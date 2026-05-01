#include "frame_changes_watch.hpp"

#include <cstring>

namespace bored::signalscope {

void FrameChangesWatch::init() {
    watch_active_.store(false, std::memory_order_relaxed);
    watch_session_.store(0U, std::memory_order_relaxed);
    entry_count_.store(0U, std::memory_order_relaxed);
    for (size_t i = 0; i < kMaxEntries; ++i) {
        entries_[i] = {};
    }
}

uint32_t FrameChangesWatch::hashKey(uint32_t can_id, Direction direction) {
    const uint32_t seed = can_id ^ (static_cast<uint32_t>(direction) * 0x9E3779B9U);
    return seed ^ (seed >> 16U);
}

FrameChangesWatch::Entry* FrameChangesWatch::findOrCreate(uint32_t can_id, Direction direction) {
    const uint32_t base = hashKey(can_id, direction) % kMaxEntries;

    for (size_t probe = 0; probe < kMaxEntries; ++probe) {
        const size_t index = (base + probe) % kMaxEntries;
        Entry& entry = entries_[index];

        if (!entry.in_use) {
            entry.can_id = can_id;
            entry.direction = direction;
            entry.dlc = 0;
            std::memset(entry.data, 0, sizeof(entry.data));
            entry.has_previous = false;
            entry.watch_dirty_mask = 0;
            entry.watch_session_applied = watch_session_.load(std::memory_order_acquire);
            entry.in_use = true;

            const uint16_t previous_count = entry_count_.load(std::memory_order_relaxed);
            if (previous_count < static_cast<uint16_t>(kMaxEntries)) {
                entry_count_.store(static_cast<uint16_t>(previous_count + 1U), std::memory_order_relaxed);
            }

            return &entry;
        }

        if (entry.can_id == can_id && entry.direction == direction) {
            return &entry;
        }
    }

    return nullptr;
}

const FrameChangesWatch::Entry* FrameChangesWatch::findEntry(uint32_t can_id, Direction direction) const {
    const uint32_t base = hashKey(can_id, direction) % kMaxEntries;

    for (size_t probe = 0; probe < kMaxEntries; ++probe) {
        const size_t index = (base + probe) % kMaxEntries;
        const Entry& entry = entries_[index];

        if (!entry.in_use) {
            return nullptr;
        }

        if (entry.can_id == can_id && entry.direction == direction) {
            return &entry;
        }
    }

    return nullptr;
}

void FrameChangesWatch::observeFrame(const CanFrame& frame) {
    Entry* entry = findOrCreate(frame.id, frame.direction);
    if (entry == nullptr) {
        return;
    }

    const uint32_t session = watch_session_.load(std::memory_order_acquire);
    if (entry->watch_session_applied != session) {
        entry->watch_dirty_mask = 0;
        entry->watch_session_applied = session;
    }

    const uint8_t new_dlc = (frame.dlc <= 8U) ? frame.dlc : 8U;

    uint8_t changed_mask = 0;
    if (entry->has_previous) {
        for (uint8_t byte_index = 0; byte_index < new_dlc; ++byte_index) {
            if (entry->data[byte_index] != frame.data[byte_index]) {
                changed_mask = static_cast<uint8_t>(changed_mask | (1U << byte_index));
            }
        }
    }

    if (watch_active_.load(std::memory_order_acquire) && entry->has_previous && changed_mask != 0U) {
        entry->watch_dirty_mask = static_cast<uint8_t>(entry->watch_dirty_mask | changed_mask);
    }

    entry->dlc = new_dlc;
    for (uint8_t byte_index = 0; byte_index < new_dlc; ++byte_index) {
        entry->data[byte_index] = frame.data[byte_index];
    }
    entry->has_previous = true;
}

void FrameChangesWatch::startWatch() {
    watch_session_.fetch_add(1U, std::memory_order_acq_rel);
    watch_active_.store(true, std::memory_order_release);
}

void FrameChangesWatch::stopWatch() {
    watch_active_.store(false, std::memory_order_release);
}

void FrameChangesWatch::reset() {
    watch_active_.store(false, std::memory_order_release);
    watch_session_.fetch_add(1U, std::memory_order_acq_rel);

    for (size_t i = 0; i < kMaxEntries; ++i) {
        Entry& entry = entries_[i];
        if (!entry.in_use) {
            continue;
        }
        entry.watch_dirty_mask = 0;
        entry.watch_session_applied = watch_session_.load(std::memory_order_acquire);
        entry.has_previous = false;
        entry.dlc = 0;
        std::memset(entry.data, 0, sizeof(entry.data));
    }
}

bool FrameChangesWatch::isWatchActive() const {
    return watch_active_.load(std::memory_order_acquire);
}

uint8_t FrameChangesWatch::dirtyMaskFor(uint32_t can_id, Direction direction) const {
    const Entry* entry = findEntry(can_id, direction);
    if (entry == nullptr) {
        return 0U;
    }
    return entry->watch_dirty_mask;
}

}  // namespace bored::signalscope
