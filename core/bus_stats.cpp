#include "bus_stats.hpp"

namespace bored::signalscope {

namespace {

constexpr size_t busIndex(CanBus bus) {
    return static_cast<size_t>(bus);
}

}  // namespace

uint32_t BusStats::frameOnWireBits(uint8_t dlc, bool extended_id) {
    const uint32_t clamped_dlc = (dlc > 8U) ? 8U : static_cast<uint32_t>(dlc);
    const uint32_t payload_bits = 8U * clamped_dlc;

    // Base bits include SOF, ID/control, DLC, data, CRC (15+delim), ACK
    // (slot+delim), EOF (7), and IFS (3). The stuffable region is the
    // contiguous span from SOF through the CRC sequence (data + CRC
    // before its delimiter), where every 4 like-valued bits forces a
    // stuff bit. The (n - 1) / 4 form gives the worst-case stuff bit
    // count for that span.
    if (extended_id) {
        const uint32_t base = 67U + payload_bits;
        const uint32_t stuffable = 54U + payload_bits - 1U;
        return base + (stuffable / 4U);
    }
    const uint32_t base = 47U + payload_bits;
    const uint32_t stuffable = 34U + payload_bits - 1U;
    return base + (stuffable / 4U);
}

void BusStats::init(uint32_t bitrate_bps) {
    bitrate_bps_ = (bitrate_bps == 0U) ? 500000U : bitrate_bps;
    for (size_t i = 0; i < kBusCount; ++i) {
        rx_bits_accum_[i].store(0U, std::memory_order_relaxed);
        tx_bits_accum_[i].store(0U, std::memory_order_relaxed);
        rx_frames_accum_[i].store(0U, std::memory_order_relaxed);
        tx_frames_accum_[i].store(0U, std::memory_order_relaxed);
        rx_util_pct_[i].store(0U, std::memory_order_relaxed);
        tx_util_pct_[i].store(0U, std::memory_order_relaxed);
        rx_bits_last_[i].store(0U, std::memory_order_relaxed);
        tx_bits_last_[i].store(0U, std::memory_order_relaxed);
        rx_frames_last_[i].store(0U, std::memory_order_relaxed);
        tx_frames_last_[i].store(0U, std::memory_order_relaxed);
        hw_rx_drops_[i].store(0U, std::memory_order_relaxed);
        hw_tx_failed_[i].store(0U, std::memory_order_relaxed);
    }
}

void BusStats::addRxFrame(CanBus bus, uint8_t dlc, bool extended_id) {
    const size_t i = busIndex(bus);
    const uint32_t bits = frameOnWireBits(dlc, extended_id);
    rx_bits_accum_[i].fetch_add(bits, std::memory_order_relaxed);
    rx_frames_accum_[i].fetch_add(1U, std::memory_order_relaxed);
}

void BusStats::addTxFrame(CanBus bus, uint8_t dlc, bool extended_id) {
    const size_t i = busIndex(bus);
    const uint32_t bits = frameOnWireBits(dlc, extended_id);
    tx_bits_accum_[i].fetch_add(bits, std::memory_order_relaxed);
    tx_frames_accum_[i].fetch_add(1U, std::memory_order_relaxed);
}

void BusStats::rollWindow(uint32_t now_ms) {
    (void)now_ms;
    const uint32_t bitrate = (bitrate_bps_ == 0U) ? 1U : bitrate_bps_;
    for (size_t i = 0; i < kBusCount; ++i) {
        const uint32_t rx_bits = rx_bits_accum_[i].exchange(0U, std::memory_order_acq_rel);
        const uint32_t tx_bits = tx_bits_accum_[i].exchange(0U, std::memory_order_acq_rel);
        const uint32_t rx_frames = rx_frames_accum_[i].exchange(0U, std::memory_order_acq_rel);
        const uint32_t tx_frames = tx_frames_accum_[i].exchange(0U, std::memory_order_acq_rel);

        // Integer percentage with rounding; bitrate is bits-per-second
        // and the window is exactly 1 s, so bits / bitrate is the duty
        // cycle directly. Cap at 100 because the worst-case stuffing
        // formula combined with timing jitter near a full bus could
        // briefly nudge above 100.
        uint32_t rx_pct = (rx_bits * 100U + bitrate / 2U) / bitrate;
        uint32_t tx_pct = (tx_bits * 100U + bitrate / 2U) / bitrate;
        if (rx_pct > 100U) rx_pct = 100U;
        if (tx_pct > 100U) tx_pct = 100U;

        rx_bits_last_[i].store(rx_bits, std::memory_order_relaxed);
        tx_bits_last_[i].store(tx_bits, std::memory_order_relaxed);
        rx_frames_last_[i].store(rx_frames, std::memory_order_relaxed);
        tx_frames_last_[i].store(tx_frames, std::memory_order_relaxed);
        rx_util_pct_[i].store(static_cast<uint16_t>(rx_pct), std::memory_order_release);
        tx_util_pct_[i].store(static_cast<uint16_t>(tx_pct), std::memory_order_release);
    }
}

BusWindowSnapshot BusStats::snapshot(CanBus bus) const {
    const size_t i = busIndex(bus);
    BusWindowSnapshot snap;
    snap.rx_util_pct = rx_util_pct_[i].load(std::memory_order_acquire);
    snap.tx_util_pct = tx_util_pct_[i].load(std::memory_order_acquire);
    snap.rx_bits = rx_bits_last_[i].load(std::memory_order_relaxed);
    snap.tx_bits = tx_bits_last_[i].load(std::memory_order_relaxed);
    snap.rx_frames = rx_frames_last_[i].load(std::memory_order_relaxed);
    snap.tx_frames = tx_frames_last_[i].load(std::memory_order_relaxed);
    return snap;
}

void BusStats::setHwDropsRxA(uint32_t value) {
    hw_rx_drops_[busIndex(CanBus::kA)].store(value, std::memory_order_release);
}

void BusStats::setHwTxFailedA(uint32_t value) {
    hw_tx_failed_[busIndex(CanBus::kA)].store(value, std::memory_order_release);
}

void BusStats::bumpHwDropsRxB(bool rx0_overflow, bool rx1_overflow) {
    const size_t i = busIndex(CanBus::kB);
    uint32_t increment = 0U;
    if (rx0_overflow) increment += 1U;
    if (rx1_overflow) increment += 1U;
    if (increment != 0U) {
        hw_rx_drops_[i].fetch_add(increment, std::memory_order_relaxed);
    }
}

uint32_t BusStats::hwDropsRx(CanBus bus) const {
    return hw_rx_drops_[busIndex(bus)].load(std::memory_order_acquire);
}

uint32_t BusStats::hwTxFailed(CanBus bus) const {
    return hw_tx_failed_[busIndex(bus)].load(std::memory_order_acquire);
}

}  // namespace bored::signalscope
