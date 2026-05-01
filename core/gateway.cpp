#include "gateway.hpp"

#include <Arduino.h>

#include "frame_cache.hpp"
#include "frame_changes_watch.hpp"
#include "mutation_engine.hpp"
#include "observation_manager.hpp"
#include "signal_cache.hpp"

namespace bored::signalscope {

namespace {

// Live ingress: latency is RX read (frame.timestamp_us) to after TX. Replay uses
// forwardFrame-only time so file timestamps are ignored.
inline uint32_t measuredLatencyUs(bool from_replay, uint32_t end_us, const CanFrame& frame,
                                uint32_t processing_start_us) {
    if (from_replay) {
        return end_us - processing_start_us;
    }
    return end_us - frame.timestamp_us;
}

}  // namespace

void GatewayCore::init() {
    queue_head_ = 0;
    queue_tail_ = 0;
    ready_gate_ = false;
    stats_ = {};
    direct_latency_window_sum_us_ = 0;
    direct_latency_window_count_ = 0;
    mutated_latency_window_sum_us_ = 0;
    mutated_latency_window_count_ = 0;
    last_forwarded_frames_at_roll_ = 0;
}

void GatewayCore::setMutationEngine(MutationEngine* engine) {
    mutation_engine_ = engine;
}

void GatewayCore::setReplayEngine(ReplayEngine* engine) {
    replay_engine_ = engine;
}

void GatewayCore::setTxDriver(TxDriver driver) {
    tx_driver_ = driver;
}

void GatewayCore::setFrameCache(FrameCache* cache) {
    frame_cache_ = cache;
}

void GatewayCore::setFrameChangesWatch(FrameChangesWatch* watch) {
    frame_changes_watch_ = watch;
}

void GatewayCore::setSignalCache(SignalCache* cache) {
    signal_cache_ = cache;
}

void GatewayCore::setObservationManager(ObservationManager* manager) {
    observation_manager_ = manager;
}

void GatewayCore::setDbcPointer(const std::atomic<const DbcDatabase*>* dbc_ptr) {
    dbc_active_ptr_ = dbc_ptr;
}

void GatewayCore::setReadyGate(bool ready) {
    ready_gate_ = ready;
}

bool GatewayCore::onFrameReceivedFromIsr(const CanFrame& frame) {
    const uint16_t next_head = nextIndex(queue_head_);
    if (next_head == queue_tail_) {
        if (ready_gate_) {
            ++stats_.rx_drops_run;
        } else {
            ++stats_.rx_drops_boot;
        }
        return false;
    }

    rx_queue_[queue_head_] = frame;
    queue_head_ = next_head;

    const uint16_t depth = (queue_head_ >= queue_tail_)
        ? static_cast<uint16_t>(queue_head_ - queue_tail_)
        : static_cast<uint16_t>((kRxQueueSize - queue_tail_) + queue_head_);
    stats_.rx_queue_depth = depth;

    return true;
}

bool GatewayCore::injectReplayFrame(const CanFrame& frame) {
    CanFrame mutable_frame = frame;
    forwardFrame(mutable_frame, true, static_cast<uint32_t>(mutable_frame.timestamp_us / 1000U));
    return true;
}

void GatewayCore::pollRx(uint32_t now_ms) {
    while (queue_tail_ != queue_head_) {
        CanFrame frame = rx_queue_[queue_tail_];
        queue_tail_ = nextIndex(queue_tail_);
        forwardFrame(frame, false, now_ms);
    }

    const uint16_t depth = (queue_head_ >= queue_tail_)
        ? static_cast<uint16_t>(queue_head_ - queue_tail_)
        : static_cast<uint16_t>((kRxQueueSize - queue_tail_) + queue_head_);
    stats_.rx_queue_depth = depth;
}

const GatewayStats& GatewayCore::stats() const {
    return stats_;
}

void GatewayCore::rollPerSecondWindow(uint32_t now_ms) {
    (void)now_ms;

    const uint32_t direct_count = direct_latency_window_count_;
    const uint64_t direct_sum = direct_latency_window_sum_us_;
    direct_latency_window_count_ = 0;
    direct_latency_window_sum_us_ = 0;
    if (direct_count > 0U) {
        stats_.direct_path_latency_avg_us = static_cast<uint32_t>(direct_sum / direct_count);
        stats_.direct_path_frames_per_sec = static_cast<uint16_t>(direct_count > 65535U ? 65535U : direct_count);
    } else {
        stats_.direct_path_latency_avg_us = 0U;
        stats_.direct_path_frames_per_sec = 0U;
    }

    const uint32_t mutated_count = mutated_latency_window_count_;
    const uint64_t mutated_sum = mutated_latency_window_sum_us_;
    mutated_latency_window_count_ = 0;
    mutated_latency_window_sum_us_ = 0;
    if (mutated_count > 0U) {
        stats_.mutated_path_latency_avg_us = static_cast<uint32_t>(mutated_sum / mutated_count);
        stats_.mutated_path_frames_per_sec = static_cast<uint16_t>(mutated_count > 65535U ? 65535U : mutated_count);
    } else {
        stats_.mutated_path_latency_avg_us = 0U;
        stats_.mutated_path_frames_per_sec = 0U;
    }

    const uint32_t forwarded_total = stats_.forwarded_frames;
    const uint32_t forwarded_delta = forwarded_total - last_forwarded_frames_at_roll_;
    last_forwarded_frames_at_roll_ = forwarded_total;
    stats_.forwarded_frames_per_sec =
        static_cast<uint16_t>(forwarded_delta > 65535U ? 65535U : forwarded_delta);
}

void GatewayCore::forwardFrame(CanFrame& frame, bool from_replay, uint32_t now_ms) {
    const uint32_t processing_start_us = micros();

    const bool has_rules = (mutation_engine_ != nullptr) && mutation_engine_->hasRulesForFrame(frame.id, frame.direction);
    const bool observed = (observation_manager_ != nullptr) && observation_manager_->isObserved(frame.id, frame.direction);

    if (!has_rules && !observed) {
        if (frame_cache_ != nullptr) {
            frame_cache_->update(frame, now_ms, false);
        }
        if (frame_changes_watch_ != nullptr) {
            frame_changes_watch_->observeFrame(frame);
        }

        bool tx_attempted = false;
        if (tx_driver_ != nullptr) {
            tx_attempted = true;
            static_cast<void>(tx_driver_(frame.direction, frame));
        }

        if (tx_attempted) {
            const uint32_t latency_us =
                measuredLatencyUs(from_replay, micros(), frame, processing_start_us);
            direct_latency_window_sum_us_ += static_cast<uint64_t>(latency_us);
            ++direct_latency_window_count_;
        }

        ++stats_.forwarded_frames;
        ++stats_.passive_direct_path_frames;
        if (from_replay) {
            ++stats_.replay_injected_frames;
        }
        return;
    }

    size_t applied_rules = 0U;
    if (has_rules && mutation_engine_ != nullptr) {
        applied_rules = mutation_engine_->applyFrameMutations(frame);
        stats_.mutation_applied_frames += static_cast<uint32_t>(applied_rules);
    }

    if (observed && signal_cache_ != nullptr && dbc_active_ptr_ != nullptr) {
        const DbcDatabase* dbc = dbc_active_ptr_->load(std::memory_order_acquire);
        if (dbc != nullptr) {
            stats_.observed_decoded_frames += static_cast<uint32_t>(signal_cache_->decodeObservedFrame(*dbc, frame));
        }
    }

    if (frame_cache_ != nullptr) {
        frame_cache_->update(frame, now_ms, applied_rules > 0U);
    }
    if (frame_changes_watch_ != nullptr) {
        frame_changes_watch_->observeFrame(frame);
    }

    bool tx_attempted = false;
    if (tx_driver_ != nullptr) {
        tx_attempted = true;
        static_cast<void>(tx_driver_(frame.direction, frame));
    }

    if (tx_attempted) {
        const uint32_t latency_us =
            measuredLatencyUs(from_replay, micros(), frame, processing_start_us);
        mutated_latency_window_sum_us_ += static_cast<uint64_t>(latency_us);
        ++mutated_latency_window_count_;
    }

    ++stats_.forwarded_frames;
    if (from_replay) {
        ++stats_.replay_injected_frames;
    }
}

uint16_t GatewayCore::nextIndex(uint16_t index) {
    return static_cast<uint16_t>((index + 1U) % kRxQueueSize);
}

}  // namespace bored::signalscope
