#include "frame_cache.hpp"

#include <algorithm>
#include <cstring>

namespace bored::signalscope {

namespace {

struct TimestampDesc {
    bool operator()(const FrameCacheSnapshot& lhs, const FrameCacheSnapshot& rhs) const {
        return lhs.last_timestamp_us > rhs.last_timestamp_us;
    }
};

}  // namespace

void FrameCache::init() {
    count_.store(0, std::memory_order_relaxed);
    for (size_t i = 0; i < kMaxEntries; ++i) {
        entries_[i].sequence.store(0, std::memory_order_relaxed);
        entries_[i].in_use.store(0, std::memory_order_relaxed);
        entries_[i].can_id = 0;
        entries_[i].direction = Direction::A_TO_B;
        entries_[i].dlc = 0;
        std::memset(entries_[i].data, 0, sizeof(entries_[i].data));
        entries_[i].mutated = false;
        entries_[i].last_timestamp_us = 0;
        entries_[i].total_frames = 0;
        entries_[i].period_ms = 0;
    }

    for (size_t i = 0; i < kRecentCapacity; ++i) {
        recent_[i] = {};
    }
    recent_head_.store(0, std::memory_order_relaxed);
    recent_count_.store(0, std::memory_order_relaxed);
}

void FrameCache::update(const CanFrame& frame, uint32_t /*now_ms*/, bool mutated) {
    Entry* entry = findOrCreate(frame.id, frame.direction);
    if (entry == nullptr) {
        return;
    }

    entry->sequence.fetch_add(1U, std::memory_order_relaxed);

    // Capture the previous frame's timestamp (and whether one existed) before
    // we overwrite last_timestamp_us, so we can compute the inter-frame delta.
    const bool has_previous_frame = (entry->total_frames > 0U);
    const uint32_t previous_timestamp_us = entry->last_timestamp_us;

    entry->can_id = frame.id;
    entry->direction = frame.direction;
    entry->dlc = (frame.dlc <= 8U) ? frame.dlc : 8U;
    std::memcpy(entry->data, frame.data, sizeof(entry->data));
    entry->mutated = mutated;
    entry->last_timestamp_us = frame.timestamp_us;

    ++entry->total_frames;

    if (has_previous_frame) {
        // Unsigned subtraction handles micros() wrap-around correctly for any
        // delta below ~71 minutes, which is well above realistic CAN periods.
        const uint32_t delta_us = frame.timestamp_us - previous_timestamp_us;
        entry->period_ms = delta_us / 1000U;
    } else {
        entry->period_ms = 0;
    }

    const FrameCacheSnapshot event{
        entry->can_id,
        entry->direction,
        entry->dlc,
        {
            entry->data[0], entry->data[1], entry->data[2], entry->data[3],
            entry->data[4], entry->data[5], entry->data[6], entry->data[7]
        },
        entry->mutated,
        entry->last_timestamp_us,
        entry->period_ms,
        entry->total_frames
    };

    const uint16_t slot = recent_head_.load(std::memory_order_relaxed);
    recent_[slot] = event;

    const uint16_t next = static_cast<uint16_t>((slot + 1U) % kRecentCapacity);
    recent_head_.store(next, std::memory_order_release);

    const uint16_t cur_count = recent_count_.load(std::memory_order_relaxed);
    if (cur_count < kRecentCapacity) {
        recent_count_.store(static_cast<uint16_t>(cur_count + 1U), std::memory_order_release);
    }

    entry->sequence.fetch_add(1U, std::memory_order_release);
}

size_t FrameCache::snapshot(FrameCacheSnapshot* out_entries, size_t capacity) const {
    if (out_entries == nullptr || capacity == 0U) {
        return 0U;
    }

    size_t out_count = 0U;
    for (size_t i = 0; i < kMaxEntries && out_count < capacity; ++i) {
        const Entry* entry = at(i);
        if (entry == nullptr || entry->in_use.load(std::memory_order_acquire) == 0U) {
            continue;
        }

        FrameCacheSnapshot snap{};
        bool copied = false;

        for (uint8_t attempt = 0; attempt < 4U && !copied; ++attempt) {
            const uint32_t seq_a = entry->sequence.load(std::memory_order_acquire);
            if ((seq_a & 1U) != 0U) {
                continue;
            }

            snap.can_id = entry->can_id;
            snap.direction = entry->direction;
            snap.dlc = entry->dlc;
            std::memcpy(snap.data, entry->data, sizeof(snap.data));
            snap.mutated = entry->mutated;
            snap.last_timestamp_us = entry->last_timestamp_us;
            snap.period_ms = entry->period_ms;
            snap.total_frames = entry->total_frames;

            const uint32_t seq_b = entry->sequence.load(std::memory_order_acquire);
            copied = (seq_a == seq_b) && ((seq_b & 1U) == 0U);
        }

        if (!copied) {
            continue;
        }

        out_entries[out_count++] = snap;
    }

    std::sort(out_entries, out_entries + out_count, TimestampDesc{});
    return out_count;
}

size_t FrameCache::snapshotRecent(FrameCacheSnapshot* out_entries, size_t capacity) const {
    if (out_entries == nullptr || capacity == 0U) {
        return 0U;
    }

    const uint16_t count = recent_count_.load(std::memory_order_acquire);
    const uint16_t head = recent_head_.load(std::memory_order_acquire);
    const size_t take = (count < capacity) ? count : capacity;

    for (size_t i = 0; i < take; ++i) {
        const int32_t idx = static_cast<int32_t>(head) - 1 - static_cast<int32_t>(i);
        const uint16_t slot = static_cast<uint16_t>((idx < 0)
            ? (idx + static_cast<int32_t>(kRecentCapacity))
            : idx);
        out_entries[i] = recent_[slot];
    }

    return take;
}

uint32_t FrameCache::hashKey(uint32_t can_id, Direction direction) {
    const uint32_t seed = can_id ^ (static_cast<uint32_t>(direction) * 0x9E3779B9U);
    return seed ^ (seed >> 16U);
}

FrameCache::Entry* FrameCache::findOrCreate(uint32_t can_id, Direction direction) {
    const uint32_t base = hashKey(can_id, direction) % kMaxEntries;

    for (size_t probe = 0; probe < kMaxEntries; ++probe) {
        const size_t index = (base + probe) % kMaxEntries;
        Entry& entry = entries_[index];

        if (entry.in_use.load(std::memory_order_acquire) == 0U) {
            entry.can_id = can_id;
            entry.direction = direction;
            entry.dlc = 0;
            std::memset(entry.data, 0, sizeof(entry.data));
            entry.mutated = false;
            entry.last_timestamp_us = 0;
            entry.total_frames = 0;
            entry.period_ms = 0;
            entry.sequence.store(0, std::memory_order_relaxed);
            entry.in_use.store(1U, std::memory_order_release);

            const uint16_t old_count = count_.load(std::memory_order_relaxed);
            if (old_count < kMaxEntries) {
                count_.store(static_cast<uint16_t>(old_count + 1U), std::memory_order_relaxed);
            }

            return &entry;
        }

        if (entry.can_id == can_id && entry.direction == direction) {
            return &entry;
        }
    }

    return nullptr;
}

const FrameCache::Entry* FrameCache::at(size_t index) const {
    if (index >= kMaxEntries) {
        return nullptr;
    }
    return &entries_[index];
}

}  // namespace bored::signalscope
