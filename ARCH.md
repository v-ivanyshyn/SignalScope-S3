# SignalScope Runtime Architecture

## Runtime Split (Core Pinning)
- `CAN/runtime core` (`kCanCore = 0`): ingress polling, gateway queue drain, mutation apply, replay tick.
- `UI/server core` (`kUiCore = 1`): HTTP server handlers and web-client polling.
- CAN forwarding path is isolated from UI/server load.

## Direction Model
- Bus A (ESP32 TWAI) ingress frames are marked `A_TO_B`.
- Bus B (MCP2515) ingress frames are marked `B_TO_A`.
- TX routing is deterministic:
  - `A_TO_B` -> transmit on Bus B
  - `B_TO_A` -> transmit on Bus A

## Single Gateway Pipeline
1. Ingress frame is queued (`GatewayCore::onFrameReceivedFromIsr`).
2. `GatewayCore::pollRx` drains queue and processes each frame.
3. Fast-path precheck:
   - no active rules for `(can_id, direction)`, and
   - frame not observed by `ObservationManager`.
4. Fast path:
   - no mutation/decode work,
   - frame forwarded immediately,
   - frame cached as `mutated = false`.
5. Active path:
   - grouped rule lookup by `(can_id, direction)`,
   - compiled rules applied in commit order,
   - decode only if observed and DBC is loaded,
   - frame cached with `mutated = (applied_rules > 0)`.

Live ingress and replay injection share this same mutation/decode/forward pipeline.

## Caches
### FrameCache
Two views are maintained:
- Identity snapshot (`snapshot`): last frame keyed by `(can_id, direction)`.
- Recent event ring (`snapshotRecent`): rolling recent frame events (no ID collapse), newest first.

Each cached frame carries:
- `can_id`, `direction`, `dlc`, `data`, `timestamp_us`
- inter-frame `period_ms`, `total_frames`
- `mutated` flag (actual applied-state for that frame)

`/api/status` recent frame payload uses the **recent event ring**.

### SignalCache
- DBC-indexed signal storage (`index -> value`).
- Per-signal generation counters.
- Optional subscription bits.
- Name/index lookup tables for UI/API.

## Observation / Decode Policy
Observation modes:
- `none`
- `specific` (`id:direction` key set)
- `all`

Decode execution is demand-driven:
- decode runs only when frame is observed and DBC exists.
- loading DBC alone does not enable full decode.

## Mutation Engine
Supported runtime rule kinds:
- `BIT_RANGE`
- `RAW_MASK`

Commit model:
- staged rules -> compiled immutable active table
- grouped by `(can_id, direction)`
- atomic table swap (no active-table in-place mutation)

Ordering:
- deterministic stage/sequence order,
- `BIT_RANGE` pass compiled before `RAW_MASK` pass.

### Dynamic values
- `BIT_RANGE` rules may be `dynamic_value=true` (<=32 bits).
- `setRuleValue(rule_id, value)` updates value lock-free.

### Legacy mutation path
Compatibility endpoint (`/api/mutations/stage`) maps `SignalMutation` operations.
Current deterministic implementation accepts:
- `REPLACE`
- `PASS_THROUGH`

Arithmetic operations (`ADD_OFFSET`, `MULTIPLY`, `CLAMP`) are accepted by UI payloads but currently not executed by `MutationEngine::stageMutation`.

## DBC Lifecycle
Auto-load on boot (first valid file wins):
1. `/dbc/active.dbc`
2. `/dbc/default.dbc`
3. `/dbc/vw_pq.dbc`
4. first `*.dbc` found in `/dbc`

Manual upload endpoint: `/api/dbc`.
On successful parse/load:
- active DBC pointer swapped,
- signal cache reset,
- subscriptions cleared,
- observation reset to `none`,
- replay stopped,
- rules cleared.

## API Surface (Current)
- `GET  /api/status`
- `GET  /api/frame_cache`
- `GET  /api/signal_cache`
- `POST /api/observe`

Rules:
- `POST /api/rules/stage`
- `POST /api/rules`
- `GET  /api/rules`
- `POST /api/rules/enable`
- `POST /api/rules/value`

Replay / DBC:
- `POST /api/replay`
- `POST /api/replay/load`
- `POST /api/dbc`

Legacy compatibility routes:
- `POST /api/mutations/stage`
- `POST /api/mutations`
- `POST /api/mutations/toggle`

## Metrics Exposed in Status
`/api/status` exposes runtime metrics including:
- queue/drop counters
- forwarded/passive/observed decode counters
- active/staging mutation counts
- ingress counters (`ingress_a_frames`, `ingress_b_frames`)
- path latency averages (`fast_path_avg_us`, `active_path_avg_us`)
