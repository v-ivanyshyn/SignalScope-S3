#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

#include "types.hpp"

namespace bored::signalscope {

// Tracks per-(can_id, direction) byte transitions for optional “watch” sessions.
// Invoked from the gateway on the same cadence as FrameCache updates (post-mutation payload).
class FrameChangesWatch {
public:
    static constexpr size_t kMaxEntries = 256;

    void init();

    void observeFrame(const CanFrame& frame);

    void startWatch();
    void stopWatch();
    void reset();

    bool isWatchActive() const;

    uint8_t dirtyMaskFor(uint32_t can_id, Direction direction) const;

private:
    struct Entry {
        uint32_t can_id = 0;
        Direction direction = Direction::A_TO_B;
        uint8_t dlc = 0;
        uint8_t data[8] = {};
        bool has_previous = false;
        uint8_t watch_dirty_mask = 0;
        uint32_t watch_session_applied = 0;
        bool in_use = false;
    };

    static uint32_t hashKey(uint32_t can_id, Direction direction);
    Entry* findOrCreate(uint32_t can_id, Direction direction);
    const Entry* findEntry(uint32_t can_id, Direction direction) const;

    Entry entries_[kMaxEntries]{};
    std::atomic<uint16_t> entry_count_{0};
    std::atomic<bool> watch_active_{false};
    std::atomic<uint32_t> watch_session_{0};
};

}  // namespace bored::signalscope
