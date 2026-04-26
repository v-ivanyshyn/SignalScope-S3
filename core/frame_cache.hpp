#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

#include "types.hpp"

namespace bored::signalscope {

struct FrameCacheSnapshot {
    uint32_t can_id = 0;
    Direction direction = Direction::A_TO_B;
    uint8_t dlc = 0;
    uint8_t data[8] = {0};
    bool mutated = false;
    uint32_t last_timestamp_us = 0;
    uint32_t period_ms = 0;
    uint32_t total_frames = 0;
};

class FrameCache {
public:
    static constexpr size_t kMaxEntries = 128;
    static constexpr size_t kRecentCapacity = 256;

    void init();
    void update(const CanFrame& frame, uint32_t now_ms, bool mutated);

    // Snapshot keyed by (can_id, direction) identity.
    size_t snapshot(FrameCacheSnapshot* out_entries, size_t capacity) const;

    // Snapshot recent frame events (no identity collapsing), newest first.
    size_t snapshotRecent(FrameCacheSnapshot* out_entries, size_t capacity) const;

private:
    struct Entry {
        std::atomic<uint32_t> sequence{0};
        std::atomic<uint8_t> in_use{0};

        uint32_t can_id = 0;
        Direction direction = Direction::A_TO_B;
        uint8_t dlc = 0;
        uint8_t data[8] = {0};
        bool mutated = false;
        uint32_t last_timestamp_us = 0;
        uint32_t total_frames = 0;

        uint32_t period_ms = 0;
    };

    static uint32_t hashKey(uint32_t can_id, Direction direction);
    Entry* findOrCreate(uint32_t can_id, Direction direction);
    const Entry* at(size_t index) const;

    Entry entries_[kMaxEntries];
    std::atomic<uint16_t> count_{0};

    FrameCacheSnapshot recent_[kRecentCapacity];
    std::atomic<uint16_t> recent_head_{0};
    std::atomic<uint16_t> recent_count_{0};
};

}  // namespace bored::signalscope
