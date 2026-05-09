#pragma once

#include <cstdint>

namespace bored::signalscope {

// Estimates per-core CPU utilization from FreeRTOS idle-task hook call rate.
// Call rollSecondWindow() once per second (same cadence as BusStats::rollWindow)
// so load_percent_core*() reflect the last completed 1 s window.
class CpuLoadMonitor {
public:
    void init();
    void rollSecondWindow();

    uint8_t loadPercentCore0() const { return load_percent_[0]; }
    uint8_t loadPercentCore1() const { return load_percent_[1]; }

private:
    uint32_t last_idle_hits_[2] = {0U, 0U};
    uint32_t max_idle_delta_[2] = {0U, 0U};
    uint8_t load_percent_[2] = {0U, 0U};
};

}  // namespace bored::signalscope
