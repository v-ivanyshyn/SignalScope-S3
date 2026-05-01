#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

#include "dbc_parser.hpp"
#include "types.hpp"

namespace bored::signalscope {

class FrameCache;
class FrameChangesWatch;
class MutationEngine;
class ObservationManager;
class ReplayEngine;
class SignalCache;

struct GatewayStats {
    uint32_t forwarded_frames = 0;
    uint32_t replay_injected_frames = 0;
    uint32_t mutation_applied_frames = 0;
    uint32_t passive_direct_path_frames = 0;
    uint32_t observed_decoded_frames = 0;
    uint32_t rx_drops_boot = 0;
    uint32_t rx_drops_run = 0;
    uint16_t rx_queue_depth = 0;

    // Per completed 1 s window (see rollPerSecondWindow): mean latency (µs) and
    // frame count in that window (= frames/s). Live ingress uses RX→TX; replay uses
    // forwardFrame-only time (gateway.cpp).
    uint32_t direct_path_latency_avg_us = 0;
    uint32_t mutated_path_latency_avg_us = 0;
    uint16_t direct_path_frames_per_sec = 0;
    uint16_t mutated_path_frames_per_sec = 0;

    // Forwarded frames processed in the last completed 1 s window (= frames/s).
    uint16_t forwarded_frames_per_sec = 0;
};

class GatewayCore {
public:
    using TxDriver = bool (*)(Direction tx_direction, const CanFrame& frame);

    static constexpr size_t kRxQueueSize = 128;

    void init();
    void setMutationEngine(MutationEngine* engine);
    void setReplayEngine(ReplayEngine* engine);
    void setTxDriver(TxDriver driver);
    void setFrameCache(FrameCache* cache);
    void setFrameChangesWatch(FrameChangesWatch* watch);
    void setSignalCache(SignalCache* cache);
    void setObservationManager(ObservationManager* manager);
    void setDbcPointer(const std::atomic<const DbcDatabase*>* dbc_ptr);
    void setReadyGate(bool ready);

    bool onFrameReceivedFromIsr(const CanFrame& frame);
    bool injectReplayFrame(const CanFrame& frame);

    void pollRx(uint32_t now_ms);

    // Closes the current 1 s window: publishes latency means and path frame rates,
    // forwarded frame rate, and clears latency accumulators. Call once per second
    // from the CAN runtime task on the same cadence as BusStats::rollWindow.
    void rollPerSecondWindow(uint32_t now_ms);

    const GatewayStats& stats() const;

private:
    void forwardFrame(CanFrame& frame, bool from_replay, uint32_t now_ms);
    static uint16_t nextIndex(uint16_t index);

    CanFrame rx_queue_[kRxQueueSize];
    volatile uint16_t queue_head_ = 0;
    volatile uint16_t queue_tail_ = 0;

    MutationEngine* mutation_engine_ = nullptr;
    ReplayEngine* replay_engine_ = nullptr;
    TxDriver tx_driver_ = nullptr;
    FrameCache* frame_cache_ = nullptr;
    FrameChangesWatch* frame_changes_watch_ = nullptr;
    SignalCache* signal_cache_ = nullptr;
    ObservationManager* observation_manager_ = nullptr;
    const std::atomic<const DbcDatabase*>* dbc_active_ptr_ = nullptr;

    bool ready_gate_ = false;
    GatewayStats stats_{};

    uint64_t direct_latency_window_sum_us_ = 0;
    uint32_t direct_latency_window_count_ = 0;
    uint64_t mutated_latency_window_sum_us_ = 0;
    uint32_t mutated_latency_window_count_ = 0;
    uint32_t last_forwarded_frames_at_roll_ = 0;
};

}  // namespace bored::signalscope

