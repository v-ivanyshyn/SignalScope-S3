#include "cpu_load_monitor.hpp"

#include <Arduino.h>

#include <algorithm>
#include <atomic>

#include <esp_freertos_hooks.h>
#include <sdkconfig.h>

namespace bored::signalscope {
namespace {

std::atomic<uint32_t> g_idle_hits[2] = {0U, 0U};

bool idleHookCore0() {
    g_idle_hits[0].fetch_add(1U, std::memory_order_relaxed);
    return false;
}

bool idleHookCore1() {
    g_idle_hits[1].fetch_add(1U, std::memory_order_relaxed);
    return false;
}

#if CONFIG_FREERTOS_UNICORE
constexpr unsigned kCoreCount = 1U;
#else
constexpr unsigned kCoreCount = 2U;
#endif

}  // namespace

void CpuLoadMonitor::init() {
    (void)esp_register_freertos_idle_hook_for_cpu(idleHookCore0, 0);
#if !CONFIG_FREERTOS_UNICORE
    (void)esp_register_freertos_idle_hook_for_cpu(idleHookCore1, 1);
#endif
}

void CpuLoadMonitor::rollSecondWindow() {
    for (unsigned core_index = 0U; core_index < kCoreCount; ++core_index) {
        const uint32_t now = g_idle_hits[core_index].load(std::memory_order_relaxed);
        const uint32_t delta = now - last_idle_hits_[core_index];
        last_idle_hits_[core_index] = now;

        uint32_t& max_reference_delta = max_idle_delta_[core_index];
        max_reference_delta = std::max(max_reference_delta, delta);

        uint8_t load_percent = 0U;
        if (max_reference_delta > 0U) {
            const uint32_t busy_scaled =
                (max_reference_delta > delta)
                ? static_cast<uint32_t>((static_cast<uint64_t>(max_reference_delta - delta) * 100ULL)
                    / static_cast<uint64_t>(max_reference_delta))
                : 0U;
            load_percent = static_cast<uint8_t>(std::min<uint32_t>(busy_scaled, 100U));
        }
        load_percent_[core_index] = load_percent;
    }
#if CONFIG_FREERTOS_UNICORE
    load_percent_[1] = 0U;
#endif
}

}  // namespace bored::signalscope
