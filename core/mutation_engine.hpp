#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

#include "types.hpp"

namespace bored::signalscope {

enum class MutationRuntimeMode : uint8_t {
    Disabled = 0,
    Enabled = 1,
    SingleShot = 2,
};

enum class RuleKind : uint8_t {
    BIT_RANGE = 0,
    RAW_MASK = 1,
};

struct RuleStageRequest {
    RuleKind kind = RuleKind::BIT_RANGE;
    uint32_t can_id = 0;
    Direction direction = Direction::A_TO_B;
    bool enabled = true;

    // Bit-range mode
    uint16_t start_bit = 0;
    uint8_t bit_length = 1;
    bool little_endian = true;
    bool dynamic_value = false;
    uint64_t replace_value = 0;

    // Raw mask mode
    uint8_t mask[8] = {0};
    uint8_t value[8] = {0};
};

struct RuleListEntry {
    uint16_t rule_id = 0;
    uint16_t priority = 0;
    RuleStageRequest request{};
    bool active = false;
    MutationRuntimeMode mode = MutationRuntimeMode::Disabled;
};

class MutationEngine {
public:
    static constexpr size_t kMaxRules = 96;

    void init();

    bool stageRule(const RuleStageRequest& request, uint16_t* out_rule_id = nullptr);
    bool stageMutation(const SignalMutation& mutation);  // Legacy adapter
    void clearStaging();
    void revertStagingToActive();
    bool applyCommit();

    size_t stagingCount() const;
    size_t activeCount() const;

    bool hasRulesForFrame(uint32_t can_id, Direction direction) const;
    size_t applyFrameMutations(CanFrame& frame);

    int32_t registerDynamicSignalRule(
        uint32_t can_id,
        Direction direction,
        uint16_t start_bit,
        uint8_t bit_length,
        bool little_endian,
        uint32_t initial_value,
        bool enabled);

    bool setRuleValue(uint16_t rule_id, uint32_t value);
    bool enableRule(uint16_t rule_id, bool enabled);
    bool setRuleMode(uint16_t rule_id, MutationRuntimeMode mode);
    void setAllRulesMode(MutationRuntimeMode mode);

    void clearRules();
    size_t listRules(RuleListEntry* out_entries, size_t capacity) const;

private:
    static constexpr size_t kBucketCount = 128;
    static constexpr uint16_t kInvalidRuleId = 0xFFFFU;

    struct RuntimeRuleState {
        alignas(4) std::atomic<uint32_t> current_value{0};
        std::atomic<uint8_t> mode{static_cast<uint8_t>(MutationRuntimeMode::Disabled)};
    };

    struct StagedRule {
        bool in_use = false;
        uint16_t rule_id = kInvalidRuleId;
        uint32_t sequence = 0;
        RuleStageRequest request{};
    };

    struct CompiledRule {
        uint16_t rule_id = kInvalidRuleId;
        uint16_t priority = 0;
        RuleStageRequest source{};

        uint8_t clear_mask[8] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
        uint8_t static_set_bits[8] = {0};

        uint8_t dynamic_bit_count = 0;
        uint8_t dynamic_bit_positions[32] = {0};
    };

    struct RuleGroup {
        uint32_t can_id = 0;
        Direction direction = Direction::A_TO_B;
        uint16_t first_rule = 0;
        uint16_t rule_count = 0;
        int16_t next = -1;
    };

    struct ActiveRuleTable {
        uint16_t rule_count = 0;
        uint16_t group_count = 0;
        CompiledRule rules[kMaxRules];
        RuleGroup groups[kMaxRules];
        int16_t bucket_head[kBucketCount];
    };

    static uint32_t keyHash(uint32_t can_id, Direction direction);
    static uint16_t nextMotorolaBit(uint16_t current_bit);
    static bool normalizeRule(RuleStageRequest& rule);
    static void clearActiveTable(ActiveRuleTable& table);
    static bool buildBitMaskAndValue(
        uint16_t start_bit,
        uint8_t bit_length,
        bool little_endian,
        uint64_t raw_value,
        uint8_t out_mask[8],
        uint8_t out_value[8]);
    static bool buildDynamicBitPositions(
        uint16_t start_bit,
        uint8_t bit_length,
        bool little_endian,
        uint8_t out_positions[32]);
    static uint16_t findStagedIdentity(
        const StagedRule* staged,
        uint16_t count,
        const RuleStageRequest& request);

    const ActiveRuleTable* activeTable() const;
    ActiveRuleTable* inactiveTable();
    void swapActiveTable();
    const RuleGroup* findGroup(const ActiveRuleTable& table, uint32_t can_id, Direction direction) const;
    RuleGroup* ensureGroup(ActiveRuleTable& table, uint32_t can_id, Direction direction);

    bool compileRule(const StagedRule& staged_rule, uint16_t priority, CompiledRule& out_rule);
    static void applyStaticRule(const CompiledRule& rule, CanFrame& frame);
    void applyDynamicRule(const CompiledRule& rule, CanFrame& frame) const;
    static void applyMask(uint8_t frame_data[8], const uint8_t clear_mask[8], const uint8_t set_bits[8]);

    uint16_t allocateRuleSlot();
    uint16_t allocateSequence();
    void resetRuleSlot(uint16_t rule_id);
    void syncStagedRequestEnabled(uint16_t rule_id, bool continuous_enabled);

    StagedRule staged_[kMaxRules];
    uint16_t staged_count_ = 0;

    StagedRule committed_shadow_[kMaxRules];
    uint16_t committed_count_ = 0;

    RuntimeRuleState runtime_state_[kMaxRules];

    ActiveRuleTable tables_[2];
    std::atomic<const ActiveRuleTable*> active_table_{nullptr};
    uint8_t active_table_index_ = 0;
    std::atomic<uint16_t> active_count_{0};

    uint32_t next_sequence_ = 1U;
};

}  // namespace bored::signalscope
