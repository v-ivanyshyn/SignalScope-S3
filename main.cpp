#include <Arduino.h>
#include <LittleFS.h>
#include <SPI.h>
#include <WebServer.h>
#include <WiFi.h>
#include <driver/twai.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <mcp2515.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "core/dbc_parser.hpp"
#include "core/frame_cache.hpp"
#include "core/gateway.hpp"
#include "core/mutation_engine.hpp"
#include "core/observation_manager.hpp"
#include "core/replay_engine.hpp"
#include "core/signal_cache.hpp"
#include "core/types.hpp"
#include "fs/persistence.hpp"

using namespace bored::signalscope;

namespace {

constexpr const char* kApSsid = "SignalScope-AP";
constexpr const char* kApPassword = "signalscope";
constexpr size_t kStatusFrameLimit = 256;
constexpr size_t kSignalSnapshotLimit = 384;
constexpr size_t kMaxPollFramesPerBus = 128;
constexpr size_t kMaxDecodedSignalsPerFrame = 24;
constexpr size_t kStatusRuleLimit = 48;

constexpr int kBusARxPin = 6;
constexpr int kBusATxPin = 7;
constexpr int kMcpCsPin = 10;
constexpr int kMcpSclkPin = 12;
constexpr int kMcpMosiPin = 11;
constexpr int kMcpMisoPin = 13;
constexpr int kMcpRstPin = 9;

// Keep CAN runtime isolated from UI/server runtime.
constexpr BaseType_t kCanCore = 0;
constexpr BaseType_t kUiCore = 1;
constexpr uint32_t kCanTaskStackBytes = 8192;
constexpr uint32_t kUiTaskStackBytes = 16384;

GatewayCore gateway;
MutationEngine mutation_engine;
ReplayEngine replay_engine;
FrameCache frame_cache;
SignalCache signal_cache;
ObservationManager observation_manager;
PersistenceStore persistence;

DbcDatabase dbc_database;
std::atomic<const DbcDatabase*> active_dbc{nullptr};

WebServer server(80);
MCP2515 can_mcp(kMcpCsPin, 10000000, &SPI);

TaskHandle_t can_task_handle = nullptr;
TaskHandle_t ui_task_handle = nullptr;

std::atomic<uint8_t> bus_a_ready{0};
std::atomic<uint8_t> bus_b_ready{0};
std::atomic<uint8_t> fs_mounted{0};
std::atomic<uint16_t> frame_rate_fps{0};
std::atomic<uint32_t> ingress_a_frames{0};
std::atomic<uint32_t> ingress_b_frames{0};
String ui_index_path = "/index.html";
constexpr const char* kDbcDirPath = "/dbc";
constexpr const char* kActiveDbcPath = "/dbc/active.dbc";
const char* directionToString(Direction direction) {
    return (direction == Direction::A_TO_B) ? "A_TO_B" : "B_TO_A";
}

Direction parseDirectionFromText(const String& text, Direction fallback) {
    if (text == "A_TO_B") return Direction::A_TO_B;
    if (text == "B_TO_A") return Direction::B_TO_A;
    return fallback;
}

const char* observationModeToString(ObservationMode mode) {
    switch (mode) {
    case ObservationMode::ALL:
        return "all";
    case ObservationMode::SPECIFIC:
        return "specific";
    case ObservationMode::NONE:
    default:
        return "none";
    }
}

ObservationMode parseObservationMode(const String& text) {
    if (text == "all" || text == "ALL") return ObservationMode::ALL;
    if (text == "specific" || text == "SPECIFIC") return ObservationMode::SPECIFIC;
    return ObservationMode::NONE;
}

const char* ruleKindToString(RuleKind kind) {
    return (kind == RuleKind::RAW_MASK) ? "RAW_MASK" : "BIT_RANGE";
}

bool parseBoolText(const String& text, bool fallback) {
    if (text == "1" || text == "true" || text == "TRUE" || text == "on") return true;
    if (text == "0" || text == "false" || text == "FALSE" || text == "off") return false;
    return fallback;
}

uint32_t parseUIntArg(const char* name, uint32_t fallback) {
    if (!server.hasArg(name)) return fallback;
    char* end_ptr = nullptr;
    const unsigned long value = std::strtoul(server.arg(name).c_str(), &end_ptr, 0);
    if (end_ptr == server.arg(name).c_str()) return fallback;
    return static_cast<uint32_t>(value);
}

int32_t parseIntArg(const char* name, int32_t fallback) {
    if (!server.hasArg(name)) return fallback;
    char* end_ptr = nullptr;
    const long value = std::strtol(server.arg(name).c_str(), &end_ptr, 0);
    if (end_ptr == server.arg(name).c_str()) return fallback;
    return static_cast<int32_t>(value);
}

float parseFloatArg(const char* name, float fallback) {
    if (!server.hasArg(name)) return fallback;
    return server.arg(name).toFloat();
}

String contentTypeForPath(const String& path) {
    if (path.endsWith(".html")) return "text/html";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".js")) return "application/javascript";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".svg")) return "image/svg+xml";
    if (path.endsWith(".woff")) return "font/woff";
    if (path.endsWith(".woff2")) return "font/woff2";
    if (path.endsWith(".ico")) return "image/x-icon";
    return "application/octet-stream";
}

String escapeJsonString(const char* input) {
    String out;
    if (input == nullptr) return out;

    for (size_t i = 0; input[i] != '\0'; ++i) {
        const char c = input[i];
        switch (c) {
        case '\\':
            out += "\\\\";
            break;
        case '"':
            out += "\\\"";
            break;
        case '\n':
            out += "\\n";
            break;
        case '\r':
            out += "\\r";
            break;
        case '\t':
            out += "\\t";
            break;
        default:
            out += (static_cast<unsigned char>(c) < 0x20U) ? ' ' : c;
            break;
        }
    }
    return out;
}

void resolveUiIndexPath() {
    ui_index_path = LittleFS.exists("/index.html") ? "/index.html" : "/index.htm";
}
bool loadDbcFromFilePath(const String& fs_path) {
    if (fs_mounted.load(std::memory_order_acquire) == 0U) return false;
    if (!LittleFS.exists(fs_path)) return false;

    File file = LittleFS.open(fs_path, "r");
    if (!file || file.isDirectory()) {
        if (file) file.close();
        return false;
    }

    String dbc_text = file.readString();
    file.close();
    if (dbc_text.length() == 0) return false;

    if (!dbc_database.parseFromText(dbc_text.c_str(), static_cast<size_t>(dbc_text.length()))) {
        return false;
    }

    active_dbc.store(&dbc_database, std::memory_order_release);
    signal_cache.resetForDbc(dbc_database);
    signal_cache.clearSubscriptions();
    observation_manager.clearSpecific();
    observation_manager.setMode(ObservationMode::NONE);
    replay_engine.stop();
    mutation_engine.clearRules();

    Serial.printf(
        "[dbc] auto-loaded %s (%lu bytes, %lu msgs, %lu signals)\\n",
        fs_path.c_str(),
        static_cast<unsigned long>(dbc_text.length()),
        static_cast<unsigned long>(dbc_database.messageCount()),
        static_cast<unsigned long>(dbc_database.signalCount()));

    return true;
}

bool autoLoadDbcFromLittleFs() {
    if (fs_mounted.load(std::memory_order_acquire) == 0U) return false;

    constexpr const char* kPreferredPaths[] = {
        "/dbc/active.dbc",
        "/dbc/default.dbc",
        "/dbc/vw_pq.dbc",
    };

    for (const char* path : kPreferredPaths) {
        if (loadDbcFromFilePath(path)) return true;
    }

    File dir = LittleFS.open("/dbc");
    if (!dir || !dir.isDirectory()) {
        if (dir) dir.close();
        return false;
    }

    File entry = dir.openNextFile();
    while (entry) {
        const bool is_dir = entry.isDirectory();
        String name = entry.name();
        entry.close();

        if (!is_dir) {
            String lower = name;
            lower.toLowerCase();
            if (lower.endsWith(".dbc")) {
                if (!name.startsWith("/")) {
                    name = String("/dbc/") + name;
                }
                if (loadDbcFromFilePath(name)) {
                    dir.close();
                    return true;
                }
            }
        }

        entry = dir.openNextFile();
    }

    dir.close();
    return false;
}

bool serveStaticFile(const String& path) {
    if (fs_mounted.load(std::memory_order_acquire) == 0U) return false;

    String fs_path = (path == "/") ? ui_index_path : path;
    if (!LittleFS.exists(fs_path) && !fs_path.endsWith("/")) {
        const String maybe_index = fs_path + "/index.html";
        if (LittleFS.exists(maybe_index)) fs_path = maybe_index;
    }

    if (!LittleFS.exists(fs_path)) return false;
    File file = LittleFS.open(fs_path, "r");
    if (!file) return false;

    server.streamFile(file, contentTypeForPath(fs_path));
    file.close();
    return true;
}

String frameDataHex(const FrameCacheSnapshot& frame) {
    String out;
    out.reserve(24);
    for (uint8_t i = 0; i < frame.dlc && i < 8U; ++i) {
        if (i > 0U) out += ' ';
        char byte_text[3] = {0};
        std::snprintf(byte_text, sizeof(byte_text), "%02X", frame.data[i]);
        out += byte_text;
    }
    return out;
}

bool parseHexNibble(char c, uint8_t& out_value) {
    if (c >= '0' && c <= '9') {
        out_value = static_cast<uint8_t>(c - '0');
        return true;
    }
    if (c >= 'A' && c <= 'F') {
        out_value = static_cast<uint8_t>(10 + (c - 'A'));
        return true;
    }
    if (c >= 'a' && c <= 'f') {
        out_value = static_cast<uint8_t>(10 + (c - 'a'));
        return true;
    }
    return false;
}

bool parseHexBytes(const String& text, uint8_t out_bytes[8]) {
    char hex[32] = {0};
    size_t n = 0U;
    for (size_t i = 0; i < text.length() && n < sizeof(hex); ++i) {
        uint8_t nibble = 0U;
        if (parseHexNibble(text[i], nibble)) hex[n++] = text[i];
    }
    if (n < 16U) return false;

    for (uint8_t i = 0; i < 8U; ++i) {
        uint8_t hi = 0U;
        uint8_t lo = 0U;
        if (!parseHexNibble(hex[i * 2U], hi) || !parseHexNibble(hex[(i * 2U) + 1U], lo)) return false;
        out_bytes[i] = static_cast<uint8_t>((hi << 4U) | lo);
    }
    return true;
}

size_t parseU16Csv(const String& csv, uint16_t* out_values, size_t capacity) {
    if (out_values == nullptr || capacity == 0U) return 0U;
    size_t count = 0U;
    int start = 0;
    while (start < csv.length() && count < capacity) {
        int end = csv.indexOf(',', start);
        if (end < 0) end = csv.length();
        String token = csv.substring(start, end);
        token.trim();
        if (token.length() > 0) {
            char* end_ptr = nullptr;
            const unsigned long value = std::strtoul(token.c_str(), &end_ptr, 0);
            if (end_ptr != token.c_str() && value <= 0xFFFFUL) out_values[count++] = static_cast<uint16_t>(value);
        }
        start = end + 1;
    }
    return count;
}

size_t parseObservationCsv(const String& csv, ObservationKey* out_keys, size_t capacity) {
    if (out_keys == nullptr || capacity == 0U) return 0U;
    size_t count = 0U;
    int start = 0;
    while (start < csv.length() && count < capacity) {
        int end = csv.indexOf(',', start);
        if (end < 0) end = csv.length();
        String token = csv.substring(start, end);
        token.trim();
        if (token.length() > 0) {
            int sep = token.indexOf(':');
            String id_text = (sep >= 0) ? token.substring(0, sep) : token;
            String dir_text = (sep >= 0) ? token.substring(sep + 1) : "A_TO_B";
            char* end_ptr = nullptr;
            const unsigned long can_id = std::strtoul(id_text.c_str(), &end_ptr, 0);
            if (end_ptr != id_text.c_str()) {
                out_keys[count].can_id = static_cast<uint32_t>(can_id);
                out_keys[count].direction = parseDirectionFromText(dir_text, Direction::A_TO_B);
                ++count;
            }
        }
        start = end + 1;
    }
    return count;
}

bool bodyContains(const String& body, const char* token) {
    return body.indexOf(token) >= 0;
}

bool findRuleIdByIdentity(uint32_t can_id, Direction direction, uint16_t start_bit, uint8_t bit_length, uint16_t& out_rule_id);
bool findRuleIdByRawIdentity(uint32_t can_id, Direction direction, uint16_t& out_rule_id);

// API handlers
void handleStatus();
void handleFrameCache();
void handleSignalCache();
void handleObserve();
void handleRuleStage();
void handleRulesAction();
void handleRulesList();
void handleRuleValue();
void handleRuleEnable();
void handleReplayLoad();
void handleReplayControl();
void handleDbcUpload();
void handleDbcUnload();
void handleNotFound();
void configureHttpServer();
void startAccessPoint();

bool initBusA();
bool initBusB();
bool readBusA(CanFrame& out_frame);
bool readBusB(CanFrame& out_frame);
bool writeBusA(const CanFrame& frame);
bool writeBusB(const CanFrame& frame);
bool txDriver(Direction tx_direction, const CanFrame& frame);
bool replayTxBridge(const CanFrame& frame);
void pollCanIngress();

void canRuntimeTask(void* context);
void uiRuntimeTask(void* context);

}  // namespace

namespace {

bool initBusA() {
    twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(
        static_cast<gpio_num_t>(kBusATxPin),
        static_cast<gpio_num_t>(kBusARxPin),
        TWAI_MODE_NORMAL);
    twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
    twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();
    g_config.tx_queue_len = 64;
    g_config.rx_queue_len = 128;

    esp_err_t err = twai_driver_install(&g_config, &t_config, &f_config);
    if (err != ESP_OK) {
        Serial.printf("[can-a] driver install failed: %s\n", esp_err_to_name(err));
        return false;
    }
    err = twai_start();
    if (err != ESP_OK) {
        Serial.printf("[can-a] start failed: %s\n", esp_err_to_name(err));
        return false;
    }

    Serial.println("[can-a] TWAI started on pins TX=7 RX=6 @500kbps");
    return true;
}

bool initBusB() {
    pinMode(kMcpRstPin, OUTPUT);
    digitalWrite(kMcpRstPin, HIGH);
    delay(10);
    digitalWrite(kMcpRstPin, LOW);
    delay(10);
    digitalWrite(kMcpRstPin, HIGH);
    delay(10);

    SPI.begin(kMcpSclkPin, kMcpMisoPin, kMcpMosiPin, kMcpCsPin);
    if (can_mcp.reset() != MCP2515::ERROR_OK) {
        Serial.println("[can-b] MCP2515 reset failed");
        return false;
    }
    if (can_mcp.setBitrate(CAN_500KBPS) != MCP2515::ERROR_OK) {
        Serial.println("[can-b] MCP2515 bitrate set failed");
        return false;
    }
    if (can_mcp.setNormalMode() != MCP2515::ERROR_OK) {
        Serial.println("[can-b] MCP2515 normal mode failed");
        return false;
    }

    Serial.println("[can-b] MCP2515 started @500kbps");
    return true;
}

bool readBusA(CanFrame& out_frame) {
    twai_message_t rx = {};
    if (twai_receive(&rx, 0) != ESP_OK) return false;

    out_frame.id = rx.identifier;
    out_frame.dlc = (rx.data_length_code <= 8U) ? rx.data_length_code : 8U;
    for (uint8_t i = 0; i < out_frame.dlc; ++i) out_frame.data[i] = rx.data[i];
    out_frame.timestamp_us = micros();
    out_frame.direction = Direction::A_TO_B;
    return true;
}

bool readBusB(CanFrame& out_frame) {
    struct can_frame frame = {};
    if (can_mcp.readMessage(&frame) != MCP2515::ERROR_OK) return false;

    out_frame.id = frame.can_id & CAN_EFF_MASK;
    out_frame.dlc = (frame.can_dlc <= 8U) ? frame.can_dlc : 8U;
    for (uint8_t i = 0; i < out_frame.dlc; ++i) out_frame.data[i] = frame.data[i];
    out_frame.timestamp_us = micros();
    out_frame.direction = Direction::B_TO_A;
    return true;
}

bool writeBusA(const CanFrame& frame) {
    if (bus_a_ready.load(std::memory_order_acquire) == 0U) return false;

    twai_message_t tx = {};
    tx.identifier = frame.id;
    tx.extd = (frame.id > 0x7FFU) ? 1 : 0;
    tx.rtr = 0;
    tx.data_length_code = (frame.dlc <= 8U) ? frame.dlc : 8U;
    for (uint8_t i = 0; i < tx.data_length_code; ++i) tx.data[i] = frame.data[i];

    return twai_transmit(&tx, pdMS_TO_TICKS(1)) == ESP_OK;
}

bool writeBusB(const CanFrame& frame) {
    if (bus_b_ready.load(std::memory_order_acquire) == 0U) return false;

    struct can_frame tx = {};
    tx.can_id = frame.id & CAN_EFF_MASK;
    if (frame.id > 0x7FFU) tx.can_id |= CAN_EFF_FLAG;
    tx.can_dlc = (frame.dlc <= 8U) ? frame.dlc : 8U;
    for (uint8_t i = 0; i < tx.can_dlc; ++i) tx.data[i] = frame.data[i];

    return can_mcp.sendMessage(&tx) == MCP2515::ERROR_OK;
}

bool txDriver(Direction tx_direction, const CanFrame& frame) {
    return (tx_direction == Direction::A_TO_B)
        ? writeBusB(frame)
        : writeBusA(frame);
}

bool replayTxBridge(const CanFrame& frame) {
    return gateway.injectReplayFrame(frame);
}

void pollCanIngress() {
    CanFrame frame{};

    size_t processed = 0;
    while (processed < kMaxPollFramesPerBus &&
           bus_a_ready.load(std::memory_order_acquire) != 0U &&
           readBusA(frame)) {
        gateway.onFrameReceivedFromIsr(frame);
        ingress_a_frames.fetch_add(1U, std::memory_order_relaxed);
        ++processed;
    }

    processed = 0;
    while (processed < kMaxPollFramesPerBus &&
           bus_b_ready.load(std::memory_order_acquire) != 0U &&
           readBusB(frame)) {
        gateway.onFrameReceivedFromIsr(frame);
        ingress_b_frames.fetch_add(1U, std::memory_order_relaxed);
        ++processed;
    }
}

void configureHttpServer() {
    server.on("/", HTTP_GET, []() {
        if (fs_mounted.load(std::memory_order_acquire) == 0U) {
            server.send(500, "text/plain", "LittleFS not mounted");
            return;
        }

        if (!serveStaticFile(ui_index_path)) {
            server.send(500, "text/plain", "UI index missing");
            return;
        }
    });

    server.on("/api/status", HTTP_GET, handleStatus);
    server.on("/api/frame_cache", HTTP_GET, handleFrameCache);
    server.on("/api/signal_cache", HTTP_GET, handleSignalCache);
    server.on("/api/observe", HTTP_POST, handleObserve);

    server.on("/api/rules/stage", HTTP_POST, handleRuleStage);
    server.on("/api/rules", HTTP_POST, handleRulesAction);
    server.on("/api/rules", HTTP_GET, handleRulesList);
    server.on("/api/rules/value", HTTP_POST, handleRuleValue);
    server.on("/api/rules/enable", HTTP_POST, handleRuleEnable);

    // Backward-compatible paths
    server.on("/api/mutations/stage", HTTP_POST, handleRuleStage);
    server.on("/api/mutations", HTTP_POST, handleRulesAction);
    server.on("/api/mutations/toggle", HTTP_POST, []() {
        const bool enabled = parseBoolText(server.arg("enabled"), true);

        uint16_t rule_id = 0U;
        const int32_t explicit_rule_id = parseIntArg("rule_id", -1);
        if (explicit_rule_id >= 0 && explicit_rule_id < static_cast<int32_t>(MutationEngine::kMaxRules)) {
            rule_id = static_cast<uint16_t>(explicit_rule_id);
        } else {
            const uint32_t can_id = parseUIntArg("can_id", 0U);
            const Direction direction = parseDirectionFromText(server.arg("direction"), Direction::A_TO_B);
            const bool is_raw = server.hasArg("kind") && server.arg("kind") == "RAW_MASK";
            if (is_raw) {
                if (!findRuleIdByRawIdentity(can_id, direction, rule_id)) {
                    server.send(404, "application/json", "{\"ok\":false,\"error\":\"mutation_not_found\"}");
                    return;
                }
            } else {
                const uint16_t start_bit = static_cast<uint16_t>(parseUIntArg("start_bit", 0U));
                const uint8_t bit_length = static_cast<uint8_t>(parseUIntArg("length", 0U));
                if (!findRuleIdByIdentity(can_id, direction, start_bit, bit_length, rule_id)) {
                    server.send(404, "application/json", "{\"ok\":false,\"error\":\"mutation_not_found\"}");
                    return;
                }
            }
        }

        const bool ok = mutation_engine.enableRule(rule_id, enabled);
        if (!ok) {
            server.send(404, "application/json", "{\"ok\":false,\"error\":\"rule_not_found\"}");
            return;
        }
        server.send(200, "application/json", "{\"ok\":true}");
    });

    server.on("/api/replay", HTTP_POST, handleReplayControl);
    server.on("/api/replay/load", HTTP_POST, handleReplayLoad);
    server.on("/api/dbc", HTTP_POST, handleDbcUpload);
    server.on("/api/dbc", HTTP_DELETE, handleDbcUnload);

    server.onNotFound(handleNotFound);
    server.begin();
}

void startAccessPoint() {
    WiFi.mode(WIFI_MODE_AP);
    if (!WiFi.softAP(kApSsid, kApPassword)) {
        Serial.println("[wifi] AP start failed");
        return;
    }
    const IPAddress ap_ip = WiFi.softAPIP();
    Serial.printf("[wifi] AP started: SSID=%s PASS=%s IP=%s\n", kApSsid, kApPassword, ap_ip.toString().c_str());
}

void canRuntimeTask(void* /*context*/) {
    uint32_t last_rate_sample_ms = millis();
    uint32_t last_forwarded = 0U;
    uint32_t last_stats_log_ms = millis();

    gateway.setReadyGate(true);

    for (;;) {
        const uint32_t now_us = micros();
        const uint32_t now_ms = millis();

        pollCanIngress();
        gateway.pollRx(now_us, now_ms);
        replay_engine.tick(now_us);

        if (now_ms - last_rate_sample_ms >= 1000U) {
            const uint32_t forwarded = gateway.stats().forwarded_frames;
            frame_rate_fps.store(static_cast<uint16_t>(forwarded - last_forwarded), std::memory_order_release);
            last_forwarded = forwarded;
            last_rate_sample_ms = now_ms;
        }

        if (now_ms - last_stats_log_ms >= 5000U) {
            const GatewayStats& stats = gateway.stats();
            Serial.printf(
                "[gateway] drops_boot=%lu drops_run=%lu queue=%u passive=%lu decoded=%lu active_rules=%u\n",
                static_cast<unsigned long>(stats.rx_drops_boot),
                static_cast<unsigned long>(stats.rx_drops_run),
                static_cast<unsigned int>(stats.rx_queue_depth),
                static_cast<unsigned long>(stats.passive_fast_path_frames),
                static_cast<unsigned long>(stats.observed_decoded_frames),
                static_cast<unsigned int>(mutation_engine.activeCount()));
            last_stats_log_ms = now_ms;
        }

        vTaskDelay(pdMS_TO_TICKS(1));
    }
}

void uiRuntimeTask(void* /*context*/) {
    for (;;) {
        server.handleClient();
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

}  // namespace

void setup() {
    Serial.begin(115200);
    delay(250);

    gateway.init();
    mutation_engine.init();
    replay_engine.init();
    frame_cache.init();
    signal_cache.init();
    observation_manager.init();
    persistence.begin();

    gateway.setMutationEngine(&mutation_engine);
    gateway.setReplayEngine(&replay_engine);
    gateway.setTxDriver(txDriver);
    gateway.setFrameCache(&frame_cache);
    gateway.setSignalCache(&signal_cache);
    gateway.setObservationManager(&observation_manager);
    gateway.setDbcPointer(&active_dbc);
    gateway.setReadyGate(false);
    replay_engine.setTxCallback(replayTxBridge);

    const bool mounted = LittleFS.begin(false, "/littlefs", 10, "littlefs")
        || LittleFS.begin(true, "/littlefs", 10, "littlefs");
    fs_mounted.store(mounted ? 1U : 0U, std::memory_order_release);
    if (mounted) {
        resolveUiIndexPath();
        if (!autoLoadDbcFromLittleFs()) {
            Serial.println("[dbc] auto-load skipped: no valid /dbc/*.dbc found");
        }
    }

    bus_a_ready.store(initBusA() ? 1U : 0U, std::memory_order_release);
    bus_b_ready.store(initBusB() ? 1U : 0U, std::memory_order_release);

    startAccessPoint();
    configureHttpServer();

    const BaseType_t can_ok = xTaskCreatePinnedToCore(
        canRuntimeTask,
        "ss_can",
        kCanTaskStackBytes,
        nullptr,
        3,
        &can_task_handle,
        kCanCore);
    const BaseType_t ui_ok = xTaskCreatePinnedToCore(
        uiRuntimeTask,
        "ss_ui",
        kUiTaskStackBytes,
        nullptr,
        1,
        &ui_task_handle,
        kUiCore);

    Serial.printf("[runtime] CAN task core=%d created=%d | UI task core=%d created=%d\n",
        static_cast<int>(kCanCore),
        static_cast<int>(can_ok == pdPASS),
        static_cast<int>(kUiCore),
        static_cast<int>(ui_ok == pdPASS));
}

void loop() {
    vTaskDelay(pdMS_TO_TICKS(1000));
}

namespace {

void handleRuleStage() {
    if (!server.hasArg("rule_kind") && server.hasArg("operation")) {
        SignalMutation mutation{};
        mutation.can_id = parseUIntArg("can_id", 0U);
        mutation.direction = parseDirectionFromText(server.arg("direction"), Direction::A_TO_B);

        const uint32_t start_bit = parseUIntArg("start_bit", 0U);
        const uint32_t length = parseUIntArg("length", 8U);
        mutation.start_bit = static_cast<uint16_t>((start_bit > 63U) ? 63U : start_bit);
        mutation.length = static_cast<uint8_t>((length < 1U) ? 1U : ((length > 64U) ? 64U : length));

        mutation.little_endian = parseBoolText(server.arg("little_endian"), true);
        mutation.is_signed = parseBoolText(server.arg("is_signed"), false);
        mutation.factor = parseFloatArg("factor", 1.0F);
        mutation.offset = parseFloatArg("offset", 0.0F);

        const String operation_text = server.arg("operation");
        if (operation_text == "REPLACE") {
            mutation.operation = MutationOperation::REPLACE;
        } else if (operation_text == "PASS_THROUGH") {
            mutation.operation = MutationOperation::PASS_THROUGH;
        } else if (operation_text == "ADD_OFFSET") {
            mutation.operation = MutationOperation::ADD_OFFSET;
        } else if (operation_text == "MULTIPLY") {
            mutation.operation = MutationOperation::MULTIPLY;
        } else if (operation_text == "CLAMP") {
            mutation.operation = MutationOperation::CLAMP;
        } else {
            mutation.operation = MutationOperation::REPLACE;
        }

        mutation.op_value1 = parseFloatArg("op_value1", 0.0F);
        mutation.op_value2 = parseFloatArg("op_value2", 0.0F);
        mutation.enabled = parseBoolText(server.arg("enabled"), true);

        if (!mutation_engine.stageMutation(mutation)) {
            server.send(507, "application/json", "{\"ok\":false,\"error\":\"stage_failed\"}");
            return;
        }

        const String json = "{\"ok\":true,\"staging_count\":" + String(static_cast<uint32_t>(mutation_engine.stagingCount())) + "}";
        server.send(200, "application/json", json);
        return;
    }

    RuleStageRequest request{};
    const String kind_text = server.hasArg("rule_kind")
        ? server.arg("rule_kind")
        : (server.hasArg("kind") ? server.arg("kind") : "BIT_RANGE");

    request.kind = (kind_text == "RAW_MASK") ? RuleKind::RAW_MASK : RuleKind::BIT_RANGE;
    request.can_id = parseUIntArg("can_id", 0U);
    request.direction = parseDirectionFromText(server.arg("direction"), Direction::A_TO_B);
    request.enabled = parseBoolText(server.arg("enabled"), true);

    if (request.kind == RuleKind::RAW_MASK) {
        if (!parseHexBytes(server.arg("mask"), request.mask) || !parseHexBytes(server.arg("value"), request.value)) {
            server.send(400, "application/json", "{\"ok\":false,\"error\":\"invalid_mask_or_value\"}");
            return;
        }
    } else {
        const uint32_t start_bit = parseUIntArg("start_bit", 0U);
        const uint32_t length = parseUIntArg("length", 8U);
        request.start_bit = static_cast<uint16_t>((start_bit > 63U) ? 63U : start_bit);
        request.bit_length = static_cast<uint8_t>((length < 1U) ? 1U : ((length > 64U) ? 64U : length));
        request.little_endian = parseBoolText(server.arg("little_endian"), true);
        request.dynamic_value = parseBoolText(server.arg("dynamic"), false);
        request.replace_value = static_cast<uint64_t>(parseUIntArg("replace_value", parseUIntArg("op_value1", 0U)));
    }

    uint16_t rule_id = 0U;
    if (!mutation_engine.stageRule(request, &rule_id)) {
        server.send(507, "application/json", "{\"ok\":false,\"error\":\"stage_failed\"}");
        return;
    }

    String json = "{\"ok\":true,\"rule_id\":" + String(rule_id) +
        ",\"staging_count\":" + String(static_cast<uint32_t>(mutation_engine.stagingCount())) + "}";
    server.send(200, "application/json", json);
}

void handleRulesAction() {
    const String body = server.arg("plain");

    if (bodyContains(body, "apply_commit")) {
        const bool ok = mutation_engine.applyCommit();
        server.send(ok ? 200 : 422, "application/json", ok ? "{\"ok\":true,\"action\":\"apply_commit\"}" : "{\"ok\":false}");
        return;
    }
    if (bodyContains(body, "revert")) {
        mutation_engine.revertStagingToActive();
        server.send(200, "application/json", "{\"ok\":true,\"action\":\"revert\"}");
        return;
    }
    if (bodyContains(body, "clear_staging")) {
        mutation_engine.clearStaging();
        server.send(200, "application/json", "{\"ok\":true,\"action\":\"clear_staging\"}");
        return;
    }
    if (bodyContains(body, "clear_rules")) {
        mutation_engine.clearRules();
        server.send(200, "application/json", "{\"ok\":true,\"action\":\"clear_rules\"}");
        return;
    }

    server.send(400, "application/json", "{\"ok\":false,\"error\":\"unknown_action\"}");
}

void handleRulesList() {
    RuleListEntry rules[MutationEngine::kMaxRules];
    const size_t count = mutation_engine.listRules(rules, MutationEngine::kMaxRules);

    String json;
    json.reserve(22000);
    json += "{\"ok\":true,\"count\":" + String(static_cast<uint32_t>(count)) + ",\"rules\":[";
    for (size_t i = 0; i < count; ++i) {
        if (i > 0U) json += ",";
        const RuleListEntry& item = rules[i];
        json += "{";
        json += "\"rule_id\":" + String(item.rule_id) + ",";
        json += "\"priority\":" + String(item.priority) + ",";
        json += "\"active\":" + String(item.active ? "true" : "false") + ",";
        json += "\"kind\":\"" + String(ruleKindToString(item.request.kind)) + "\",";
        json += "\"can_id\":" + String(item.request.can_id) + ",";
        json += "\"direction\":\"" + String(directionToString(item.request.direction)) + "\",";
        json += "\"start_bit\":" + String(item.request.start_bit) + ",";
        json += "\"length\":" + String(item.request.bit_length) + ",";
        json += "\"dynamic\":" + String(item.request.dynamic_value ? "true" : "false") + ",";
        json += "\"replace_value\":" + String(static_cast<uint32_t>(item.request.replace_value));
        json += "}";
    }
    json += "]}";
    server.send(200, "application/json", json);
}

void handleRuleValue() {
    const int32_t rule_id = parseIntArg("rule_id", -1);
    if (rule_id < 0 || rule_id >= static_cast<int32_t>(MutationEngine::kMaxRules)) {
        server.send(400, "application/json", "{\"ok\":false,\"error\":\"invalid_rule_id\"}");
        return;
    }

    const uint32_t value = parseUIntArg("value", 0U);
    if (!mutation_engine.setRuleValue(static_cast<uint16_t>(rule_id), value)) {
        server.send(404, "application/json", "{\"ok\":false,\"error\":\"rule_not_found\"}");
        return;
    }

    if (server.hasArg("enabled")) {
        mutation_engine.enableRule(static_cast<uint16_t>(rule_id), parseBoolText(server.arg("enabled"), true));
    }

    server.send(200, "application/json", "{\"ok\":true}");
}

void handleRuleEnable() {
    int32_t rule_id = parseIntArg("rule_id", -1);
    if (rule_id < 0 || rule_id >= static_cast<int32_t>(MutationEngine::kMaxRules)) {
        const uint32_t can_id = parseUIntArg("can_id", 0U);
        const Direction direction = parseDirectionFromText(server.arg("direction"), Direction::A_TO_B);
        const bool is_raw = server.hasArg("kind") && server.arg("kind") == "RAW_MASK";
        uint16_t resolved_rule_id = 0U;

        bool found = false;
        if (is_raw) {
            found = findRuleIdByRawIdentity(can_id, direction, resolved_rule_id);
        } else if (server.hasArg("start_bit") && server.hasArg("length")) {
            const uint16_t start_bit = static_cast<uint16_t>(parseUIntArg("start_bit", 0U));
            const uint8_t bit_length = static_cast<uint8_t>(parseUIntArg("length", 0U));
            found = findRuleIdByIdentity(can_id, direction, start_bit, bit_length, resolved_rule_id);
        }

        if (!found) {
            server.send(400, "application/json", "{\"ok\":false,\"error\":\"invalid_rule_id\"}");
            return;
        }
        rule_id = static_cast<int32_t>(resolved_rule_id);
    }
    const bool ok = mutation_engine.enableRule(static_cast<uint16_t>(rule_id), parseBoolText(server.arg("enabled"), true));
    server.send(ok ? 200 : 404, "application/json", ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"rule_not_found\"}");
}

void handleReplayLoad() {
    const String csv_text = server.arg("plain");
    if (csv_text.length() == 0) {
        server.send(400, "application/json", "{\"ok\":false,\"error\":\"empty_replay_body\"}");
        return;
    }

    const Direction replay_direction = parseDirectionFromText(server.arg("direction"), Direction::A_TO_B);
    const bool loaded = replay_engine.loadLogCsv(csv_text.c_str(), static_cast<size_t>(csv_text.length()), replay_direction);

    const String json = "{\"ok\":" + String(loaded ? "true" : "false") +
        ",\"frames\":" + String(static_cast<uint32_t>(replay_engine.frameCount())) + "}";
    server.send(loaded ? 200 : 422, "application/json", json);
}

void handleReplayControl() {
    const String body = server.arg("plain");
    if (bodyContains(body, "start")) {
        if (replay_engine.frameCount() == 0U) {
            server.send(409, "application/json", "{\"ok\":false,\"error\":\"replay_empty\"}");
            return;
        }

        ReplayLoopMode loop_mode = ReplayLoopMode::PLAY_ONCE;
        if (bodyContains(body, "LOOP_RAW")) {
            loop_mode = ReplayLoopMode::LOOP_RAW;
        } else if (bodyContains(body, "LOOP_WITH_COUNTER_CONTINUATION")) {
            loop_mode = ReplayLoopMode::LOOP_WITH_COUNTER_CONTINUATION;
        }

        replay_engine.start(loop_mode, micros());
        server.send(200, "application/json", "{\"ok\":true,\"action\":\"start\"}");
        return;
    }

    if (bodyContains(body, "stop")) {
        replay_engine.stop();
        server.send(200, "application/json", "{\"ok\":true,\"action\":\"stop\"}");
        return;
    }

    server.send(400, "application/json", "{\"ok\":false,\"error\":\"unknown_replay_action\"}");
}

void handleDbcUpload() {
    String dbc_text = server.arg("plain");
    if (dbc_text.length() == 0 && fs_mounted.load(std::memory_order_acquire) != 0U) {
        if (LittleFS.exists(kActiveDbcPath)) {
            File staged = LittleFS.open(kActiveDbcPath, "r");
            if (staged && !staged.isDirectory()) {
                dbc_text = staged.readString();
            }
            if (staged) staged.close();
        }
    }

    if (dbc_text.length() == 0) {
        server.send(400, "application/json", "{\"ok\":false,\"error\":\"empty_dbc_body_or_upload\"}");
        return;
    }

    if (!dbc_database.parseFromText(dbc_text.c_str(), static_cast<size_t>(dbc_text.length()))) {
        server.send(422, "application/json", "{\"ok\":false,\"error\":\"dbc_parse_failed\"}");
        return;
    }

    if (fs_mounted.load(std::memory_order_acquire) != 0U) {
        if (!LittleFS.exists(kDbcDirPath)) {
            static_cast<void>(LittleFS.mkdir(kDbcDirPath));
        }
        File out = LittleFS.open(kActiveDbcPath, "w");
        if (out && !out.isDirectory()) {
            static_cast<void>(out.print(dbc_text));
            out.close();
        } else if (out) {
            out.close();
        }
    }

    active_dbc.store(&dbc_database, std::memory_order_release);

    signal_cache.resetForDbc(dbc_database);
    signal_cache.clearSubscriptions();
    observation_manager.clearSpecific();
    observation_manager.setMode(ObservationMode::NONE);
    replay_engine.stop();
    mutation_engine.clearRules();

    const String json = "{\"ok\":true,\"messages\":" + String(static_cast<uint32_t>(dbc_database.messageCount())) +
        ",\"signals\":" + String(static_cast<uint32_t>(dbc_database.signalCount())) + "}";
    server.send(200, "application/json", json);
}

void handleDbcUnload() {
    // Detach the runtime first so consumers (gateway decode path, status
    // endpoint, signal cache writers) stop dereferencing the database before
    // we wipe its contents.
    active_dbc.store(nullptr, std::memory_order_release);
    dbc_database.clear();

    // After clear() the database reports 0 signals, so resetForDbc collapses
    // the signal cache name map and counts back to the empty state.
    signal_cache.resetForDbc(dbc_database);
    signal_cache.clearSubscriptions();
    observation_manager.clearSpecific();
    observation_manager.setMode(ObservationMode::NONE);
    replay_engine.stop();
    mutation_engine.clearRules();

    // Forget the persisted copy so the device boots without a DBC next time.
    bool removed = false;
    if (fs_mounted.load(std::memory_order_acquire) != 0U) {
        if (LittleFS.exists(kActiveDbcPath)) {
            removed = LittleFS.remove(kActiveDbcPath);
        }
    }

    Serial.printf("[dbc] unloaded (persisted_removed=%d)\n", removed ? 1 : 0);

    server.send(200, "application/json", "{\"ok\":true}");
}

void handleNotFound() {
    const String uri = server.uri();
    if (uri.startsWith("/api/")) {
        server.send(404, "application/json", "{\"ok\":false,\"error\":\"api_not_found\"}");
        return;
    }
    if (serveStaticFile(uri)) return;
    if (serveStaticFile(ui_index_path)) return;
    server.send(404, "text/plain", "SignalScope file not found");
}

}  // namespace

namespace {

const DbcSignalDef* findSignalByLocation(const DbcDatabase* dbc, uint32_t can_id, uint16_t start_bit, uint8_t bit_length) {
    if (dbc == nullptr) return nullptr;
    const size_t total = dbc->signalCount();
    for (size_t i = 0; i < total; ++i) {
        const DbcSignalDef* signal = dbc->signalAt(i);
        if (signal == nullptr) continue;
        if (signal->can_id == can_id && signal->start_bit == start_bit && signal->length == bit_length) {
            return signal;
        }
    }
    return nullptr;
}

bool findRuleIdByIdentity(uint32_t can_id, Direction direction, uint16_t start_bit, uint8_t bit_length, uint16_t& out_rule_id) {
    RuleListEntry rules[MutationEngine::kMaxRules];
    const size_t count = mutation_engine.listRules(rules, MutationEngine::kMaxRules);
    for (size_t i = 0; i < count; ++i) {
        const RuleStageRequest& rule = rules[i].request;
        if (rule.kind != RuleKind::BIT_RANGE) continue;
        if (rule.can_id == can_id &&
            rule.direction == direction &&
            rule.start_bit == start_bit &&
            rule.bit_length == bit_length) {
            out_rule_id = rules[i].rule_id;
            return true;
        }
    }
    return false;
}
bool findRuleIdByRawIdentity(uint32_t can_id, Direction direction, uint16_t& out_rule_id) {
    RuleListEntry rules[MutationEngine::kMaxRules];
    const size_t count = mutation_engine.listRules(rules, MutationEngine::kMaxRules);
    for (size_t i = 0; i < count; ++i) {
        const RuleStageRequest& rule = rules[i].request;
        if (rule.kind != RuleKind::RAW_MASK) continue;
        if (rule.can_id == can_id && rule.direction == direction) {
            out_rule_id = rules[i].rule_id;
            return true;
        }
    }
    return false;
}

void appendDecodedSignalsJson(String& json, const FrameCacheSnapshot& frame) {
    const DbcDatabase* dbc = active_dbc.load(std::memory_order_acquire);
    const DbcMessageDef* message = (dbc == nullptr) ? nullptr : dbc->findMessage(frame.can_id);

    json += "\"message_name\":";
    if (message != nullptr && message->name[0] != '\0') {
        json += "\"" + escapeJsonString(message->name) + "\"";
    } else {
        json += "null";
    }
    json += ",";

    json += "\"decoded_signals\":[";
    if (message != nullptr && message->signal_count > 0U) {
        const size_t message_signal_count = static_cast<size_t>(message->signal_count);
        const size_t max_signals = (message_signal_count > kMaxDecodedSignalsPerFrame)
            ? kMaxDecodedSignalsPerFrame
            : message_signal_count;

        const bool mutated = frame.mutated;
        bool first = true;
        for (size_t i = 0; i < max_signals; ++i) {
            const size_t signal_index = static_cast<size_t>(message->signal_start) + i;
            const DbcSignalDef* signal = dbc->signalAt(signal_index);
            if (signal == nullptr) continue;

            float value = 0.0F;
            uint32_t generation = 0U;
            bool valid = false;
            if (!signal_cache.readSignal(static_cast<uint16_t>(signal_index), value, generation, valid) || !valid) {
                continue;
            }

            if (!first) json += ",";
            first = false;

            json += "{";
            json += "\"index\":" + String(static_cast<uint32_t>(signal_index)) + ",";
            json += "\"name\":\"" + escapeJsonString(signal->name) + "\",";
            json += "\"value\":" + String(value, 3) + ",";
            json += "\"start_bit\":" + String(signal->start_bit) + ",";
            json += "\"length\":" + String(signal->length) + ",";
            json += "\"little_endian\":" + String(signal->little_endian ? "true" : "false") + ",";
            json += "\"is_signed\":" + String(signal->is_signed ? "true" : "false") + ",";
            json += "\"factor\":" + String(signal->factor, 6) + ",";
            json += "\"offset\":" + String(signal->offset, 6) + ",";
            json += "\"generation\":" + String(generation) + ",";
            json += "\"mutated\":" + String(mutated ? "true" : "false");
            json += "}";
        }
    }
    json += "]";
}

void appendActiveRulesJson(String& json) {
    RuleListEntry rules[kStatusRuleLimit];
    const size_t count = mutation_engine.listRules(rules, kStatusRuleLimit);
    const DbcDatabase* dbc = active_dbc.load(std::memory_order_acquire);

    json += "\"active_mutation_items\":[";
    for (size_t i = 0; i < count; ++i) {
        if (i > 0U) json += ",";
        const RuleListEntry& item = rules[i];
        char can_id_text[11] = {0};
        std::snprintf(can_id_text, sizeof(can_id_text), "0x%03lX", static_cast<unsigned long>(item.request.can_id));

        json += "{";
        json += "\"rule_id\":" + String(item.rule_id) + ",";
        json += "\"priority\":" + String(item.priority) + ",";
        json += "\"active\":" + String(item.active ? "true" : "false") + ",";
        json += "\"kind\":\"" + String(ruleKindToString(item.request.kind)) + "\",";
        json += "\"can_id\":\"" + String(can_id_text) + "\",";
        json += "\"direction\":\"" + String(directionToString(item.request.direction)) + "\",";
        json += "\"enabled\":" + String(item.active ? "true" : "false") + ",";
        json += "\"dynamic\":" + String(item.request.dynamic_value ? "true" : "false") + ",";
        json += "\"start_bit\":" + String(item.request.start_bit) + ",";
        json += "\"length\":" + String(item.request.bit_length) + ",";
        json += "\"little_endian\":" + String(item.request.little_endian ? "true" : "false") + ",";
        json += "\"operation\":\"" + String(item.request.kind == RuleKind::RAW_MASK ? "RAW_MASK" : "REPLACE") + "\",";
        json += "\"replace_value\":" + String(static_cast<uint32_t>(item.request.replace_value));

        if (item.request.kind == RuleKind::RAW_MASK) {
            json += ",\"mask\":\"";
            for (uint8_t b = 0; b < 8U; ++b) {
                char t[3] = {0};
                std::snprintf(t, sizeof(t), "%02X", item.request.mask[b]);
                json += t;
            }
            json += "\",\"value\":\"";
            for (uint8_t b = 0; b < 8U; ++b) {
                char t[3] = {0};
                std::snprintf(t, sizeof(t), "%02X", item.request.value[b]);
                json += t;
            }
            json += "\"";
        } else {
            json += ",\"signal_name\":";
            const DbcSignalDef* signal = findSignalByLocation(
                dbc,
                item.request.can_id,
                item.request.start_bit,
                item.request.bit_length);
            if (signal != nullptr && signal->name[0] != '\0') {
                json += "\"" + escapeJsonString(signal->name) + "\"";
            } else {
                json += "null";
            }
        }

        json += "}";
    }
    json += "]";
}

void handleStatus() {
    const GatewayStats& stats = gateway.stats();
    const DbcDatabase* dbc = active_dbc.load(std::memory_order_acquire);

    FrameCacheSnapshot frames[kStatusFrameLimit];
    const size_t frame_count = frame_cache.snapshot(frames, kStatusFrameLimit);

    const uint16_t fps = frame_rate_fps.load(std::memory_order_acquire);
    const uint16_t bus_a = (fps > 1000U) ? 100U : static_cast<uint16_t>(fps / 10U);
    const uint16_t bus_b = bus_a;
    const uint16_t bus_total = (bus_a + bus_b > 100U) ? 100U : static_cast<uint16_t>(bus_a + bus_b);

    String json;
    // Sized for up to ~256 distinct CAN IDs in the snapshot, each with a
    // moderate number of decoded signals. Falls back to dynamic growth if
    // the bus actually surfaces more.
    json.reserve(60000);
    json += "{";
    json += "\"cpu_load_pct\":5,";
    json += "\"bus_a_util_pct\":" + String(bus_a) + ",";
    json += "\"bus_b_util_pct\":" + String(bus_b) + ",";
    json += "\"bus_total_util_pct\":" + String(bus_total) + ",";
    json += "\"bus_a_ready\":" + String(bus_a_ready.load(std::memory_order_acquire) ? "true" : "false") + ",";
    json += "\"bus_b_ready\":" + String(bus_b_ready.load(std::memory_order_acquire) ? "true" : "false") + ",";
    json += "\"ingress_a_frames\":" + String(ingress_a_frames.load(std::memory_order_relaxed)) + ",";
    json += "\"ingress_b_frames\":" + String(ingress_b_frames.load(std::memory_order_relaxed)) + ",";
    json += "\"rx_queue_depth\":" + String(stats.rx_queue_depth) + ",";
    json += "\"rx_drops_boot\":" + String(stats.rx_drops_boot) + ",";
    json += "\"rx_drops_run\":" + String(stats.rx_drops_run) + ",";
    json += "\"dropped_frames\":" + String(stats.rx_drops_run) + ",";
    json += "\"forwarded_frames\":" + String(stats.forwarded_frames) + ",";
    json += "\"passive_fast_path_frames\":" + String(stats.passive_fast_path_frames) + ",";
    json += "\"observed_decoded_frames\":" + String(stats.observed_decoded_frames) + ",";
    json += "\"active_mutations\":" + String(static_cast<uint32_t>(mutation_engine.activeCount())) + ",";
    json += "\"staging_mutations\":" + String(static_cast<uint32_t>(mutation_engine.stagingCount())) + ",";
    json += "\"dbc_loaded\":" + String(dbc != nullptr ? "true" : "false") + ",";
    json += "\"dbc_message_count\":" + String(static_cast<uint32_t>(dbc != nullptr ? dbc->messageCount() : 0U)) + ",";
    json += "\"dbc_signal_count\":" + String(static_cast<uint32_t>(dbc != nullptr ? dbc->signalCount() : 0U)) + ",";
    json += "\"replay_frame_count\":" + String(static_cast<uint32_t>(replay_engine.frameCount())) + ",";
    json += "\"replay_playing\":" + String(replay_engine.isPlaying() ? "true" : "false") + ",";
    json += "\"frame_rate_fps\":" + String(fps) + ",";
    json += "\"observation_mode\":\"" + String(observationModeToString(observation_manager.mode())) + "\",";
    json += "\"decode_all\":" + String(signal_cache.decodeAll() ? "true" : "false") + ",";
    json += "\"fast_path_avg_us\":" + String(stats.fast_path_latency_avg_us) + ",";
    json += "\"active_path_avg_us\":" + String(stats.active_path_latency_avg_us) + ",";
    json += "\"fast_path_samples\":" + String(stats.fast_path_latency_samples) + ",";
    json += "\"active_path_samples\":" + String(stats.active_path_latency_samples) + ",";
    appendActiveRulesJson(json);
    json += ",\"recent_frames\":[";

    for (size_t i = 0; i < frame_count; ++i) {
        if (i > 0U) json += ",";
        char id_text[11] = {0};
        std::snprintf(id_text, sizeof(id_text), "0x%03lX", static_cast<unsigned long>(frames[i].can_id));

        json += "{";
        json += "\"id\":\"" + String(id_text) + "\",";
        json += "\"can_id\":" + String(frames[i].can_id) + ",";
        json += "\"dlc\":" + String(frames[i].dlc) + ",";
        json += "\"direction\":\"" + String(directionToString(frames[i].direction)) + "\",";
        json += "\"timestamp_us\":" + String(frames[i].last_timestamp_us) + ",";
        json += "\"data\":\"" + frameDataHex(frames[i]) + "\",";
        json += "\"period_ms\":" + String(frames[i].period_ms) + ",";
        json += "\"byte_changed_mask\":" + String(static_cast<uint32_t>(frames[i].byte_changed_mask)) + ",";
        json += "\"mutated\":" + String(frames[i].mutated ? "true" : "false") + ",";
        appendDecodedSignalsJson(json, frames[i]);
        json += "}";
    }
    json += "]}";
    server.send(200, "application/json", json);
}

void handleFrameCache() {
    const uint32_t requested_limit = parseUIntArg("limit", kStatusFrameLimit);
    const size_t limit = (requested_limit > kStatusFrameLimit) ? kStatusFrameLimit : static_cast<size_t>(requested_limit);

    FrameCacheSnapshot frames[kStatusFrameLimit];
    const size_t count = frame_cache.snapshot(frames, limit);

    String json;
    json.reserve(12000);
    json += "{\"ok\":true,\"count\":" + String(static_cast<uint32_t>(count)) + ",\"frames\":[";
    for (size_t i = 0; i < count; ++i) {
        if (i > 0U) json += ",";
        json += "{";
        json += "\"can_id\":" + String(frames[i].can_id) + ",";
        json += "\"direction\":\"" + String(directionToString(frames[i].direction)) + "\",";
        json += "\"dlc\":" + String(frames[i].dlc) + ",";
        json += "\"timestamp_us\":" + String(frames[i].last_timestamp_us) + ",";
        json += "\"period_ms\":" + String(frames[i].period_ms) + ",";
        json += "\"byte_changed_mask\":" + String(static_cast<uint32_t>(frames[i].byte_changed_mask)) + ",";
        json += "\"mutated\":" + String(frames[i].mutated ? "true" : "false") + ",";
        json += "\"data\":\"" + frameDataHex(frames[i]) + "\"";
        json += "}";
    }
    json += "]}";
    server.send(200, "application/json", json);
}

void handleSignalCache() {
    uint16_t indexes[kSignalSnapshotLimit];
    size_t index_count = 0U;
    if (server.hasArg("indexes")) {
        index_count = parseU16Csv(server.arg("indexes"), indexes, kSignalSnapshotLimit);
    }

    SignalCacheSnapshot entries[kSignalSnapshotLimit];
    const size_t count = signal_cache.snapshotByIndexes(
        (index_count > 0U) ? indexes : nullptr,
        index_count,
        entries,
        kSignalSnapshotLimit);

    String json;
    json.reserve(20000);
    json += "{\"ok\":true,\"count\":" + String(static_cast<uint32_t>(count)) + ",\"signals\":[";
    for (size_t i = 0; i < count; ++i) {
        if (i > 0U) json += ",";
        const SignalCacheSnapshot& s = entries[i];
        json += "{";
        json += "\"index\":" + String(s.index) + ",";
        json += "\"can_id\":" + String(s.can_id) + ",";
        json += "\"name\":\"" + escapeJsonString(s.name) + "\",";
        json += "\"value\":" + String(s.value, 4) + ",";
        json += "\"generation\":" + String(s.generation) + ",";
        json += "\"valid\":" + String(s.valid ? "true" : "false") + ",";
        json += "\"subscribed\":" + String(s.subscribed ? "true" : "false");
        json += "}";
    }
    json += "]}";
    server.send(200, "application/json", json);
}

void handleObserve() {
    const ObservationMode mode = parseObservationMode(server.arg("mode"));
    if (mode == ObservationMode::ALL) {
        observation_manager.clearSpecific();
        observation_manager.setMode(ObservationMode::ALL);
        signal_cache.setDecodeAll(true);
    } else if (mode == ObservationMode::SPECIFIC) {
        ObservationKey keys[ObservationManager::kMaxSpecificKeys];
        const size_t count = parseObservationCsv(
            server.hasArg("ids") ? server.arg("ids") : "",
            keys,
            ObservationManager::kMaxSpecificKeys);
        if (!observation_manager.setSpecific(keys, count)) {
            server.send(422, "application/json", "{\"ok\":false,\"error\":\"invalid_specific_subscription\"}");
            return;
        }
        signal_cache.setDecodeAll(false);
    } else {
        observation_manager.clearSpecific();
        observation_manager.setMode(ObservationMode::NONE);
        signal_cache.setDecodeAll(false);
    }

    const String json = "{\"ok\":true,\"mode\":\"" + String(observationModeToString(observation_manager.mode())) + "\"}";
    server.send(200, "application/json", json);
}

}  // namespace














