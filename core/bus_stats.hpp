#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

namespace bored::signalscope {

// Logical identifier for the two CAN interfaces tracked by BusStats.
// Bus A is the ESP32-S3 built-in TWAI controller; Bus B is the external
// MCP2515. The enum value doubles as the array index, so it must stay
// contiguous starting at 0.
enum class CanBus : uint8_t { kA = 0, kB = 1 };

// Per-direction utilization snapshot for a single bus, measured over the
// most recent 1 s window. Percentages are bit-time on the wire divided by
// the configured bitrate, capped at 100. Bit/frame counts are the raw
// values that fed into the percentage so callers can still see absolute
// throughput if they want it.
struct BusWindowSnapshot {
    uint16_t rx_util_pct = 0;
    uint16_t tx_util_pct = 0;
    uint32_t rx_bits = 0;
    uint32_t tx_bits = 0;
    uint32_t rx_frames = 0;
    uint32_t tx_frames = 0;
};

class BusStats {
public:
    // Configures the bitrate used to convert accumulated bit-time into a
    // utilization percentage. Both buses share the same bitrate; if
    // they ever diverge this signature can grow per-bus parameters without
    // changing call sites.
    void init(uint32_t bitrate_bps);

    // Bit-time accumulators. Called from the RX/TX driver shims after a
    // successful frame transfer. Lock-free under concurrent CAN runtime
    // and HTTP status threads (single producer per direction).
    void addRxFrame(CanBus bus, uint8_t dlc, bool extended_id);
    void addTxFrame(CanBus bus, uint8_t dlc, bool extended_id);

    // Closes the current window: divides bits-on-wire by bitrate to
    // produce the published utilization percentage, then resets the
    // accumulators so the next window starts clean. Called once per
    // second from the CAN runtime task on the same tick that drives
    // the rate sampler, so the cadence matches the UI refresh.
    void rollWindow(uint32_t now_ms);

    // Returns the most recently rolled window for the given bus.
    BusWindowSnapshot snapshot(CanBus bus) const;

    // Hardware drop bookkeeping. The TWAI driver maintains cumulative
    // counters internally so we just store the latest reading; the
    // MCP2515 only exposes sticky overflow flags so we count edges and
    // accumulate them ourselves.
    void setHwDropsRxA(uint32_t value);
    void setHwTxFailedA(uint32_t value);
    void bumpHwDropsRxB(bool rx0_overflow, bool rx1_overflow);

    uint32_t hwDropsRx(CanBus bus) const;
    uint32_t hwTxFailed(CanBus bus) const;

    // Worst-case bits-on-wire for a CAN frame at the given DLC and ID
    // type. Includes maximum stuff-bit overhead (one stuff bit every
    // four bits in the stuffable portion). Exposed publicly mainly so
    // that unit tests can pin the formula.
    static uint32_t frameOnWireBits(uint8_t dlc, bool extended_id);

private:
    static constexpr size_t kBusCount = 2;

    uint32_t bitrate_bps_ = 500000U;

    std::atomic<uint32_t> rx_bits_accum_[kBusCount]{};
    std::atomic<uint32_t> tx_bits_accum_[kBusCount]{};
    std::atomic<uint32_t> rx_frames_accum_[kBusCount]{};
    std::atomic<uint32_t> tx_frames_accum_[kBusCount]{};

    std::atomic<uint16_t> rx_util_pct_[kBusCount]{};
    std::atomic<uint16_t> tx_util_pct_[kBusCount]{};
    std::atomic<uint32_t> rx_bits_last_[kBusCount]{};
    std::atomic<uint32_t> tx_bits_last_[kBusCount]{};
    std::atomic<uint32_t> rx_frames_last_[kBusCount]{};
    std::atomic<uint32_t> tx_frames_last_[kBusCount]{};

    std::atomic<uint32_t> hw_rx_drops_[kBusCount]{};
    std::atomic<uint32_t> hw_tx_failed_[kBusCount]{};
};

}  // namespace bored::signalscope
