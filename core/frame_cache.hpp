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
    // Time between the most recent frame for this (id, direction) and the one
    // immediately preceding it. 0 when only a single frame has been seen.
    uint32_t period_ms = 0;
    // Bitmask: bit i is set when data[i] differs from the previous frame for
    // this (id, direction). Always 0 for the first frame seen. Bits at or
    // beyond the current dlc are always 0.
    uint8_t byte_changed_mask = 0;
};

class FrameCache {
public:
    static constexpr size_t kMaxEntries = 256;

    void init();
    void update(const CanFrame& frame, uint32_t now_ms, bool mutated);

    // Snapshot keyed by (can_id, direction) identity, sorted newest first.
    size_t snapshot(FrameCacheSnapshot* out_entries, size_t capacity) const;

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

        uint32_t period_ms = 0;
        uint8_t byte_changed_mask = 0;
    };

    static uint32_t hashKey(uint32_t can_id, Direction direction);
    Entry* findOrCreate(uint32_t can_id, Direction direction);
    const Entry* at(size_t index) const;

    Entry entries_[kMaxEntries];
    std::atomic<uint16_t> count_{0};
};

}  // namespace bored::signalscope
