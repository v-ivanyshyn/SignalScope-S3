#include "mutation_engine.hpp"

#include <climits>
#include <cmath>
#include <cstring>

namespace bored::signalscope {

namespace {

inline bool modeByteIsActive(uint8_t mode_byte) {
    return mode_byte == static_cast<uint8_t>(MutationRuntimeMode::Enabled) ||
        mode_byte == static_cast<uint8_t>(MutationRuntimeMode::SingleShot);
}

inline MutationRuntimeMode clampRuntimeMode(uint8_t raw) {
    if (raw > static_cast<uint8_t>(MutationRuntimeMode::SingleShot)) {
        return MutationRuntimeMode::Disabled;
    }
    return static_cast<MutationRuntimeMode>(raw);
}

uint64_t makeBitMask(uint8_t bit_length) {
    if (bit_length == 0U) {
        return 0U;
    }
    if (bit_length >= 64U) {
        return 0xFFFFFFFFFFFFFFFFULL;
    }
    return (1ULL << bit_length) - 1ULL;
}

uint64_t convertPhysicalToRaw(const SignalMutation& mutation, float physical_value) {
    if (mutation.length == 0U || mutation.length > 64U) {
        return 0U;
    }

    const double factor = (mutation.factor == 0.0F) ? 1.0 : static_cast<double>(mutation.factor);
    const double offset = static_cast<double>(mutation.offset);
    int64_t raw_signed = static_cast<int64_t>(std::llround((static_cast<double>(physical_value) - offset) / factor));

    int64_t min_value = 0;
    int64_t max_value = 0;
    if (mutation.is_signed) {
        if (mutation.length >= 64U) {
            min_value = INT64_MIN;
            max_value = INT64_MAX;
        } else {
            max_value = (1LL << (mutation.length - 1U)) - 1LL;
            min_value = -(1LL << (mutation.length - 1U));
        }
    } else {
        min_value = 0;
        if (mutation.length >= 63U) {
            max_value = INT64_MAX;
        } else {
            max_value = static_cast<int64_t>((1ULL << mutation.length) - 1ULL);
        }
    }

    if (raw_signed < min_value) {
        raw_signed = min_value;
    }
    if (raw_signed > max_value) {
        raw_signed = max_value;
    }

    const uint64_t mask = makeBitMask(mutation.length);
    return static_cast<uint64_t>(raw_signed) & mask;
}

}  // namespace

void MutationEngine::init() {
    staged_count_ = 0U;
    committed_count_ = 0U;
    next_sequence_ = 1U;

    for (size_t i = 0; i < kMaxRules; ++i) {
        staged_[i] = {};
        committed_shadow_[i] = {};
        runtime_state_[i].current_value.store(0U, std::memory_order_relaxed);
        runtime_state_[i].mode.store(static_cast<uint8_t>(MutationRuntimeMode::Disabled), std::memory_order_relaxed);
    }

    clearActiveTable(tables_[0]);
    clearActiveTable(tables_[1]);
    active_table_index_ = 0U;
    active_table_.store(&tables_[active_table_index_], std::memory_order_release);
    active_count_.store(0U, std::memory_order_relaxed);
}

bool MutationEngine::stageRule(const RuleStageRequest& request, uint16_t* out_rule_id) {
    RuleStageRequest normalized = request;
    if (!normalizeRule(normalized)) {
        return false;
    }

    uint16_t slot = findStagedIdentity(staged_, static_cast<uint16_t>(kMaxRules), normalized);
    if (slot == kInvalidRuleId) {
        slot = allocateRuleSlot();
        if (slot == kInvalidRuleId) {
            return false;
        }

        staged_[slot].in_use = true;
        staged_[slot].rule_id = slot;
        staged_[slot].sequence = allocateSequence();
        ++staged_count_;
    }

    staged_[slot].request = normalized;
    const MutationRuntimeMode initial_mode =
        normalized.enabled ? MutationRuntimeMode::Enabled : MutationRuntimeMode::Disabled;
    runtime_state_[slot].mode.store(static_cast<uint8_t>(initial_mode), std::memory_order_release);
    if (normalized.kind == RuleKind::BIT_RANGE && normalized.dynamic_value) {
        runtime_state_[slot].current_value.store(
            static_cast<uint32_t>(normalized.replace_value),
            std::memory_order_release);
    }

    if (out_rule_id != nullptr) {
        *out_rule_id = slot;
    }
    return true;
}

bool MutationEngine::stageMutation(const SignalMutation& mutation) {
    RuleStageRequest request{};
    request.kind = RuleKind::BIT_RANGE;
    request.can_id = mutation.can_id;
    request.direction = mutation.direction;
    request.start_bit = mutation.start_bit;
    request.bit_length = mutation.length;
    request.little_endian = mutation.little_endian;
    request.dynamic_value = false;
    request.enabled = mutation.enabled;

    switch (mutation.operation) {
    case MutationOperation::REPLACE:
        request.replace_value = convertPhysicalToRaw(mutation, mutation.op_value1);
        break;
    case MutationOperation::PASS_THROUGH:
        request.replace_value = 0U;
        request.enabled = false;
        break;
    default:
        // Non-deterministic arithmetic ops are intentionally rejected by the runtime engine.
        return false;
    }

    return stageRule(request, nullptr);
}

void MutationEngine::clearStaging() {
    for (size_t i = 0; i < kMaxRules; ++i) {
        staged_[i] = {};
    }
    staged_count_ = 0U;
}

void MutationEngine::revertStagingToActive() {
    clearStaging();
    for (uint16_t i = 0; i < committed_count_; ++i) {
        const StagedRule& src = committed_shadow_[i];
        if (!src.in_use || src.rule_id == kInvalidRuleId || src.rule_id >= kMaxRules) {
            continue;
        }
        staged_[src.rule_id] = src;
        staged_[src.rule_id].in_use = true;
        ++staged_count_;
    }
}

bool MutationEngine::applyCommit() {
    ActiveRuleTable* next_table = inactiveTable();
    if (next_table == nullptr) {
        return false;
    }
    clearActiveTable(*next_table);

    uint16_t ordered_rule_ids[kMaxRules];
    uint16_t ordered_count = 0U;

    for (uint16_t slot = 0; slot < kMaxRules; ++slot) {
        if (!staged_[slot].in_use) {
            continue;
        }

        uint16_t insert_at = ordered_count;
        while (insert_at > 0U && staged_[ordered_rule_ids[insert_at - 1U]].sequence > staged_[slot].sequence) {
            ordered_rule_ids[insert_at] = ordered_rule_ids[insert_at - 1U];
            --insert_at;
        }
        ordered_rule_ids[insert_at] = slot;
        ++ordered_count;
    }

    for (uint16_t i = 0; i < ordered_count; ++i) {
        const StagedRule& staged_rule = staged_[ordered_rule_ids[i]];
        RuleGroup* group = ensureGroup(*next_table, staged_rule.request.can_id, staged_rule.request.direction);
        if (group == nullptr) {
            return false;
        }
        ++group->rule_count;
    }

    uint16_t start = 0U;
    for (uint16_t group_index = 0; group_index < next_table->group_count; ++group_index) {
        RuleGroup& group = next_table->groups[group_index];
        const uint16_t count = group.rule_count;
        group.first_rule = start;
        group.rule_count = 0U;
        start = static_cast<uint16_t>(start + count);
    }

    uint16_t write_cursor[kMaxRules];
    for (uint16_t i = 0; i < next_table->group_count; ++i) {
        write_cursor[i] = next_table->groups[i].first_rule;
    }

    uint16_t priority = 0U;
    for (uint8_t pass = 0U; pass < 2U; ++pass) {
        const RuleKind wanted_kind = (pass == 0U) ? RuleKind::BIT_RANGE : RuleKind::RAW_MASK;

        for (uint16_t order_index = 0; order_index < ordered_count; ++order_index) {
            const uint16_t rule_id = ordered_rule_ids[order_index];
            const StagedRule& staged_rule = staged_[rule_id];
            if (staged_rule.request.kind != wanted_kind) {
                continue;
            }

            RuleGroup* group = ensureGroup(*next_table, staged_rule.request.can_id, staged_rule.request.direction);
            if (group == nullptr) {
                return false;
            }

            const uint16_t group_idx = static_cast<uint16_t>(group - next_table->groups);
            const uint16_t write_index = write_cursor[group_idx];
            if (write_index >= kMaxRules) {
                return false;
            }

            CompiledRule compiled{};
            if (!compileRule(staged_rule, priority, compiled)) {
                return false;
            }

            next_table->rules[write_index] = compiled;
            ++write_cursor[group_idx];
            ++group->rule_count;
            ++priority;
        }
    }

    next_table->rule_count = priority;

    for (uint16_t i = 0; i < kMaxRules; ++i) {
        committed_shadow_[i] = {};
    }
    committed_count_ = 0U;
    for (uint16_t i = 0; i < ordered_count; ++i) {
        const StagedRule& src = staged_[ordered_rule_ids[i]];
        committed_shadow_[committed_count_++] = src;
    }

    for (uint16_t i = 0; i < kMaxRules; ++i) {
        if (!staged_[i].in_use) {
            runtime_state_[i].mode.store(static_cast<uint8_t>(MutationRuntimeMode::Disabled), std::memory_order_release);
        }
    }

    swapActiveTable();
    return true;
}

size_t MutationEngine::stagingCount() const {
    return staged_count_;
}

size_t MutationEngine::activeCount() const {
    return active_count_.load(std::memory_order_acquire);
}

bool MutationEngine::hasRulesForFrame(uint32_t can_id, Direction direction) const {
    const ActiveRuleTable* table = activeTable();
    if (table == nullptr || table->rule_count == 0U) {
        return false;
    }

    const RuleGroup* group = findGroup(*table, can_id, direction);
    if (group == nullptr || group->rule_count == 0U) {
        return false;
    }

    const uint16_t begin = group->first_rule;
    const uint16_t end = static_cast<uint16_t>(group->first_rule + group->rule_count);
    for (uint16_t i = begin; i < end; ++i) {
        const uint16_t rule_id = table->rules[i].rule_id;
        if (rule_id < kMaxRules &&
            modeByteIsActive(runtime_state_[rule_id].mode.load(std::memory_order_relaxed))) {
            return true;
        }
    }

    return false;
}

size_t MutationEngine::applyFrameMutations(CanFrame& frame) {
    const ActiveRuleTable* table = activeTable();
    if (table == nullptr || table->rule_count == 0U) {
        return 0U;
    }

    const RuleGroup* group = findGroup(*table, frame.id, frame.direction);
    if (group == nullptr || group->rule_count == 0U) {
        return 0U;
    }

    size_t applied = 0U;
    const uint16_t begin = group->first_rule;
    const uint16_t end = static_cast<uint16_t>(group->first_rule + group->rule_count);
    for (uint16_t i = begin; i < end; ++i) {
        const CompiledRule& rule = table->rules[i];
        if (rule.rule_id >= kMaxRules) {
            continue;
        }

        const uint8_t mode_byte = runtime_state_[rule.rule_id].mode.load(std::memory_order_relaxed);
        if (!modeByteIsActive(mode_byte)) {
            continue;
        }

        const bool consume_single_shot =
            (mode_byte == static_cast<uint8_t>(MutationRuntimeMode::SingleShot));

        if (rule.source.dynamic_value && rule.source.kind == RuleKind::BIT_RANGE) {
            applyDynamicRule(rule, frame);
        } else {
            applyStaticRule(rule, frame);
        }

        if (consume_single_shot) {
            static_cast<void>(setRuleMode(rule.rule_id, MutationRuntimeMode::Disabled));
        }

        ++applied;
    }

    return applied;
}

int32_t MutationEngine::registerDynamicSignalRule(
    uint32_t can_id,
    Direction direction,
    uint16_t start_bit,
    uint8_t bit_length,
    bool little_endian,
    uint32_t initial_value,
    bool enabled) {

    RuleStageRequest request{};
    request.kind = RuleKind::BIT_RANGE;
    request.can_id = can_id;
    request.direction = direction;
    request.enabled = enabled;
    request.start_bit = start_bit;
    request.bit_length = bit_length;
    request.little_endian = little_endian;
    request.dynamic_value = true;
    request.replace_value = initial_value;

    uint16_t rule_id = kInvalidRuleId;
    if (!stageRule(request, &rule_id)) {
        return -1;
    }
    if (!applyCommit()) {
        return -1;
    }
    return static_cast<int32_t>(rule_id);
}

bool MutationEngine::setRuleValue(uint16_t rule_id, uint32_t value) {
    if (rule_id >= kMaxRules) {
        return false;
    }
    runtime_state_[rule_id].current_value.store(value, std::memory_order_release);
    return true;
}

bool MutationEngine::enableRule(uint16_t rule_id, bool enabled) {
    return setRuleMode(rule_id, enabled ? MutationRuntimeMode::Enabled : MutationRuntimeMode::Disabled);
}

void MutationEngine::syncStagedRequestEnabled(uint16_t rule_id, bool continuous_enabled) {
    if (rule_id >= kMaxRules) {
        return;
    }

    if (staged_[rule_id].in_use) {
        staged_[rule_id].request.enabled = continuous_enabled;
    }

    for (uint16_t i = 0; i < committed_count_; ++i) {
        if (committed_shadow_[i].rule_id == rule_id) {
            committed_shadow_[i].request.enabled = continuous_enabled;
        }
    }
}

bool MutationEngine::setRuleMode(uint16_t rule_id, MutationRuntimeMode mode) {
    if (rule_id >= kMaxRules) {
        return false;
    }

    runtime_state_[rule_id].mode.store(static_cast<uint8_t>(mode), std::memory_order_release);
    syncStagedRequestEnabled(rule_id, mode == MutationRuntimeMode::Enabled);
    return true;
}

void MutationEngine::setAllRulesMode(MutationRuntimeMode mode) {
    for (uint16_t i = 0; i < committed_count_; ++i) {
        const uint16_t rule_id = committed_shadow_[i].rule_id;
        if (rule_id < kMaxRules) {
            static_cast<void>(setRuleMode(rule_id, mode));
        }
    }
}

bool MutationEngine::removeRule(uint16_t rule_id) {
    if (rule_id >= kMaxRules) {
        return false;
    }

    // Reset staging to the committed snapshot first so this operation does
    // not silently commit unrelated in-progress edits the caller may have
    // staged but not applied yet.
    revertStagingToActive();

    if (!staged_[rule_id].in_use) {
        return false;
    }

    resetRuleSlot(rule_id);
    if (staged_count_ > 0U) {
        --staged_count_;
    }

    return applyCommit();
}

void MutationEngine::clearRules() {
    clearStaging();
    for (uint16_t i = 0; i < kMaxRules; ++i) {
        runtime_state_[i].current_value.store(0U, std::memory_order_relaxed);
        runtime_state_[i].mode.store(static_cast<uint8_t>(MutationRuntimeMode::Disabled), std::memory_order_relaxed);
    }
    committed_count_ = 0U;
    static_cast<void>(applyCommit());
}

size_t MutationEngine::listRules(RuleListEntry* out_entries, size_t capacity) const {
    if (out_entries == nullptr || capacity == 0U) {
        return 0U;
    }

    const ActiveRuleTable* table = activeTable();
    if (table == nullptr) {
        return 0U;
    }

    const size_t count = (table->rule_count < capacity) ? table->rule_count : capacity;
    for (size_t i = 0; i < count; ++i) {
        const CompiledRule& src = table->rules[i];
        RuleListEntry& dst = out_entries[i];
        dst.rule_id = src.rule_id;
        dst.priority = src.priority;
        dst.request = src.source;
        const uint8_t mode_byte = runtime_state_[src.rule_id].mode.load(std::memory_order_acquire);
        dst.mode = clampRuntimeMode(mode_byte);
        dst.active = modeByteIsActive(mode_byte);
    }
    return count;
}

uint32_t MutationEngine::keyHash(uint32_t can_id, Direction direction) {
    const uint32_t seed = can_id ^ (static_cast<uint32_t>(direction) * 0x9E3779B9U);
    return seed ^ (seed >> 16U);
}

uint16_t MutationEngine::nextMotorolaBit(uint16_t current_bit) {
    if ((current_bit % 8U) == 0U) {
        return static_cast<uint16_t>(current_bit + 15U);
    }
    return static_cast<uint16_t>(current_bit - 1U);
}

bool MutationEngine::normalizeRule(RuleStageRequest& rule) {
    if (rule.kind == RuleKind::BIT_RANGE) {
        if (rule.bit_length < 1U || rule.bit_length > 64U) {
            return false;
        }
        if (rule.start_bit > 63U) {
            return false;
        }
        if (rule.dynamic_value && rule.bit_length > 32U) {
            return false;
        }
        if (rule.start_bit + rule.bit_length > 64U && rule.little_endian) {
            return false;
        }

        uint8_t test_mask[8] = {0};
        uint8_t test_value[8] = {0};
        return buildBitMaskAndValue(rule.start_bit, rule.bit_length, rule.little_endian, rule.replace_value, test_mask, test_value);
    }

    if (rule.kind == RuleKind::RAW_MASK) {
        return true;
    }

    return false;
}

void MutationEngine::clearActiveTable(ActiveRuleTable& table) {
    table.rule_count = 0U;
    table.group_count = 0U;
    std::memset(table.bucket_head, 0xFF, sizeof(table.bucket_head));
}

bool MutationEngine::buildBitMaskAndValue(
    uint16_t start_bit,
    uint8_t bit_length,
    bool little_endian,
    uint64_t raw_value,
    uint8_t out_mask[8],
    uint8_t out_value[8]) {

    std::memset(out_mask, 0, 8U);
    std::memset(out_value, 0, 8U);

    if (bit_length < 1U || bit_length > 64U || start_bit > 63U) {
        return false;
    }

    if (little_endian) {
        for (uint8_t i = 0; i < bit_length; ++i) {
            const uint16_t bit_index = static_cast<uint16_t>(start_bit + i);
            if (bit_index > 63U) {
                return false;
            }
            const uint8_t byte_idx = static_cast<uint8_t>(bit_index / 8U);
            const uint8_t bit_in_byte = static_cast<uint8_t>(bit_index % 8U);
            const uint8_t bit_mask = static_cast<uint8_t>(1U << bit_in_byte);
            out_mask[byte_idx] |= bit_mask;

            if (((raw_value >> i) & 1ULL) != 0ULL) {
                out_value[byte_idx] |= bit_mask;
            }
        }
        return true;
    }

    uint16_t bit_index = start_bit;
    for (uint8_t i = 0; i < bit_length; ++i) {
        if (bit_index > 63U) {
            return false;
        }

        const uint8_t byte_idx = static_cast<uint8_t>(bit_index / 8U);
        const uint8_t bit_in_byte = static_cast<uint8_t>(bit_index % 8U);
        const uint8_t bit_mask = static_cast<uint8_t>(1U << bit_in_byte);
        out_mask[byte_idx] |= bit_mask;

        const uint8_t raw_bit = static_cast<uint8_t>((bit_length - 1U) - i);
        if (((raw_value >> raw_bit) & 1ULL) != 0ULL) {
            out_value[byte_idx] |= bit_mask;
        }

        bit_index = nextMotorolaBit(bit_index);
    }
    return true;
}

bool MutationEngine::buildDynamicBitPositions(
    uint16_t start_bit,
    uint8_t bit_length,
    bool little_endian,
    uint8_t out_positions[32]) {

    if (bit_length < 1U || bit_length > 32U || start_bit > 63U) {
        return false;
    }

    if (little_endian) {
        for (uint8_t bit = 0; bit < bit_length; ++bit) {
            const uint16_t frame_bit = static_cast<uint16_t>(start_bit + bit);
            if (frame_bit > 63U) {
                return false;
            }
            out_positions[bit] = static_cast<uint8_t>(frame_bit);
        }
        return true;
    }

    uint16_t frame_bit = start_bit;
    for (uint8_t i = 0; i < bit_length; ++i) {
        if (frame_bit > 63U) {
            return false;
        }

        const uint8_t raw_bit = static_cast<uint8_t>((bit_length - 1U) - i);
        out_positions[raw_bit] = static_cast<uint8_t>(frame_bit);
        frame_bit = nextMotorolaBit(frame_bit);
    }
    return true;
}

uint16_t MutationEngine::findStagedIdentity(
    const StagedRule* staged,
    uint16_t count,
    const RuleStageRequest& request) {
    for (uint16_t i = 0; i < count; ++i) {
        const StagedRule& candidate = staged[i];
        if (!candidate.in_use) {
            continue;
        }

        const RuleStageRequest& existing = candidate.request;
        if (existing.kind != request.kind ||
            existing.can_id != request.can_id ||
            existing.direction != request.direction) {
            continue;
        }

        if (request.kind == RuleKind::BIT_RANGE) {
            if (existing.start_bit == request.start_bit &&
                existing.bit_length == request.bit_length &&
                existing.little_endian == request.little_endian &&
                existing.dynamic_value == request.dynamic_value) {
                return i;
            }
            continue;
        }

        // One RAW_MASK rule per (can_id, direction) identity in staging.
        return i;
    }
    return kInvalidRuleId;
}

const MutationEngine::ActiveRuleTable* MutationEngine::activeTable() const {
    return active_table_.load(std::memory_order_acquire);
}

MutationEngine::ActiveRuleTable* MutationEngine::inactiveTable() {
    const uint8_t next_idx = (active_table_index_ == 0U) ? 1U : 0U;
    return &tables_[next_idx];
}

void MutationEngine::swapActiveTable() {
    active_table_index_ = (active_table_index_ == 0U) ? 1U : 0U;
    active_table_.store(&tables_[active_table_index_], std::memory_order_release);
    active_count_.store(tables_[active_table_index_].rule_count, std::memory_order_release);
}

const MutationEngine::RuleGroup* MutationEngine::findGroup(
    const ActiveRuleTable& table,
    uint32_t can_id,
    Direction direction) const {

    const uint32_t bucket = keyHash(can_id, direction) % kBucketCount;
    int16_t idx = table.bucket_head[bucket];
    while (idx >= 0) {
        const RuleGroup& group = table.groups[idx];
        if (group.can_id == can_id && group.direction == direction) {
            return &group;
        }
        idx = group.next;
    }

    return nullptr;
}

MutationEngine::RuleGroup* MutationEngine::ensureGroup(ActiveRuleTable& table, uint32_t can_id, Direction direction) {
    const uint32_t bucket = keyHash(can_id, direction) % kBucketCount;
    int16_t idx = table.bucket_head[bucket];
    while (idx >= 0) {
        RuleGroup& existing = table.groups[idx];
        if (existing.can_id == can_id && existing.direction == direction) {
            return &existing;
        }
        idx = existing.next;
    }

    if (table.group_count >= kMaxRules) {
        return nullptr;
    }

    RuleGroup& group = table.groups[table.group_count];
    group.can_id = can_id;
    group.direction = direction;
    group.first_rule = 0U;
    group.rule_count = 0U;
    group.next = table.bucket_head[bucket];
    table.bucket_head[bucket] = static_cast<int16_t>(table.group_count);
    ++table.group_count;
    return &group;
}

bool MutationEngine::compileRule(const StagedRule& staged_rule, uint16_t priority, CompiledRule& out_rule) {
    out_rule = {};
    out_rule.rule_id = staged_rule.rule_id;
    out_rule.priority = priority;
    out_rule.source = staged_rule.request;
    std::memset(out_rule.clear_mask, 0xFF, sizeof(out_rule.clear_mask));
    std::memset(out_rule.static_set_bits, 0, sizeof(out_rule.static_set_bits));
    out_rule.dynamic_bit_count = 0U;
    std::memset(out_rule.dynamic_bit_positions, 0, sizeof(out_rule.dynamic_bit_positions));

    if (staged_rule.request.kind == RuleKind::RAW_MASK) {
        for (uint8_t i = 0; i < 8U; ++i) {
            out_rule.clear_mask[i] = static_cast<uint8_t>(~staged_rule.request.mask[i]);
            out_rule.static_set_bits[i] = static_cast<uint8_t>(staged_rule.request.value[i] & staged_rule.request.mask[i]);
        }
        return true;
    }

    uint8_t bit_mask[8] = {0};
    uint8_t bit_value[8] = {0};
    const uint64_t static_value = staged_rule.request.dynamic_value ? 0ULL : staged_rule.request.replace_value;
    if (!buildBitMaskAndValue(
            staged_rule.request.start_bit,
            staged_rule.request.bit_length,
            staged_rule.request.little_endian,
            static_value,
            bit_mask,
            bit_value)) {
        return false;
    }

    for (uint8_t i = 0; i < 8U; ++i) {
        out_rule.clear_mask[i] = static_cast<uint8_t>(~bit_mask[i]);
        out_rule.static_set_bits[i] = static_cast<uint8_t>(bit_value[i] & bit_mask[i]);
    }

    if (staged_rule.request.dynamic_value) {
        out_rule.dynamic_bit_count = staged_rule.request.bit_length;
        return buildDynamicBitPositions(
            staged_rule.request.start_bit,
            staged_rule.request.bit_length,
            staged_rule.request.little_endian,
            out_rule.dynamic_bit_positions);
    }

    return true;
}

void MutationEngine::applyStaticRule(const CompiledRule& rule, CanFrame& frame) {
    applyMask(frame.data, rule.clear_mask, rule.static_set_bits);
}

void MutationEngine::applyDynamicRule(const CompiledRule& rule, CanFrame& frame) const {
    for (uint8_t i = 0; i < 8U; ++i) {
        frame.data[i] = static_cast<uint8_t>(frame.data[i] & rule.clear_mask[i]);
    }

    const uint32_t value = runtime_state_[rule.rule_id].current_value.load(std::memory_order_relaxed);
    for (uint8_t bit = 0; bit < rule.dynamic_bit_count; ++bit) {
        if ((value & (1UL << bit)) == 0UL) {
            continue;
        }
        const uint8_t frame_bit = rule.dynamic_bit_positions[bit];
        const uint8_t byte_idx = static_cast<uint8_t>(frame_bit / 8U);
        const uint8_t bit_idx = static_cast<uint8_t>(frame_bit % 8U);
        frame.data[byte_idx] = static_cast<uint8_t>(frame.data[byte_idx] | static_cast<uint8_t>(1U << bit_idx));
    }
}

void MutationEngine::applyMask(uint8_t frame_data[8], const uint8_t clear_mask[8], const uint8_t set_bits[8]) {
    for (uint8_t i = 0; i < 8U; ++i) {
        frame_data[i] = static_cast<uint8_t>((frame_data[i] & clear_mask[i]) | set_bits[i]);
    }
}

uint16_t MutationEngine::allocateRuleSlot() {
    for (uint16_t i = 0; i < kMaxRules; ++i) {
        if (!staged_[i].in_use) {
            return i;
        }
    }
    return kInvalidRuleId;
}

uint16_t MutationEngine::allocateSequence() {
    const uint16_t value = static_cast<uint16_t>(next_sequence_ & 0xFFFFU);
    ++next_sequence_;
    if (next_sequence_ == 0U) {
        next_sequence_ = 1U;
    }
    return value;
}

void MutationEngine::resetRuleSlot(uint16_t rule_id) {
    if (rule_id >= kMaxRules) {
        return;
    }
    staged_[rule_id] = {};
    runtime_state_[rule_id].current_value.store(0U, std::memory_order_relaxed);
    runtime_state_[rule_id].mode.store(static_cast<uint8_t>(MutationRuntimeMode::Disabled), std::memory_order_relaxed);
}

}  // namespace bored::signalscope
