# ARENA_PLAN.md

Practical execution backlog for Agent Arena (next 1-2 weeks).

## 1) Room state machine hardening
- **Task**: Implement explicit finite-state machine for room lifecycle and reject invalid transitions.
- **Acceptance criteria**:
  - All transitions enforced through one function (`transitionRoomState`).
  - Invalid transitions return structured errors and are test-covered.
  - Existing tests pass + 3 new transition tests.
- **Effort**: M
- **Risk**: Low

## 2) Centralized timer/scheduler service
- **Task**: Move round/vote timers to a per-room scheduler module with cancellation on reset/disconnect/end.
- **Acceptance criteria**:
  - No direct `setTimeout` calls in socket handlers.
  - Resetting a battle clears all pending timers for that room.
  - Add regression test for “no double-finalize”.
- **Effort**: M
- **Risk**: Medium

## 3) Append-only room event log
- **Task**: Emit and persist normalized events (`ROOM_CREATED`, `ROUND_STARTED`, `ROAST_SUBMITTED`, etc.).
- **Acceptance criteria**:
  - Event schema documented.
  - Last 1,000 events queryable by room ID.
  - Can replay one completed room from event log for debugging.
- **Effort**: M
- **Risk**: Medium

## 4) Async persistence pipeline
- **Task**: Replace synchronous file writes with buffered async persistence.
- **Acceptance criteria**:
  - Use `fs/promises` and batched writes (e.g., every 200-500ms).
  - p95 API latency unchanged or improved under local load test.
  - No data corruption across process restart smoke test.
- **Effort**: S
- **Risk**: Medium

## 5) Bot turn loop abstraction
- **Task**: Define bot pipeline (`plan -> draft -> self-check -> submit`) with clear interfaces.
- **Acceptance criteria**:
  - Bot generation logic moved out of `server.js` into `bots/` module.
  - Self-check enforces max length and policy tags.
  - Integration test still completes a full round with bots.
- **Effort**: M
- **Risk**: Medium

## 6) Lightweight episodic memory for bots
- **Task**: Track recent round outcomes and use them in generation context.
- **Acceptance criteria**:
  - Each bot stores last 3 rounds: theme, roast, votes, winner.
  - Prompt context includes compact memory summary.
  - A/B test shows improved unique roast rate or vote share variance.
- **Effort**: M
- **Risk**: Medium

## 7) Roast safety/policy gate
- **Task**: Add moderation middleware before roast publish.
- **Acceptance criteria**:
  - Reject disallowed content with structured reason code.
  - Log policy decisions for audit.
  - Unit tests for allowed/disallowed edge cases.
- **Effort**: S
- **Risk**: Medium

## 8) Eval harness + CI metrics
- **Task**: Build offline eval runner using recorded fixtures and simulated matches.
- **Acceptance criteria**:
  - CI job outputs: round completion rate, winner determinism, vote-integrity errors, mean round time.
  - Thresholds fail CI on major regressions.
  - Include at least 20 fixture scenarios.
- **Effort**: L
- **Risk**: Medium

## 9) Reliability/observability baseline
- **Task**: Add structured logging + lightweight metrics endpoint.
- **Acceptance criteria**:
  - Correlation IDs for room/battle/session in logs.
  - `/health` expanded with timer counts + queue depth.
  - Dashboard script or README section for local observability.
- **Effort**: S
- **Risk**: Low

## 10) Canary mode for behavior updates
- **Task**: Add feature flagging to run new bot policies on a % of rooms.
- **Acceptance criteria**:
  - Flag can target rooms by deterministic hash.
  - Compare control vs canary metrics in logs.
  - Safe rollback switch documented.
- **Effort**: M
- **Risk**: Low

---

## Suggested execution order
1. #1 State machine
2. #2 Scheduler
3. #4 Async persistence
4. #9 Observability
5. #8 Eval harness
6. #5 Bot loop abstraction
7. #6 Bot memory
8. #7 Safety gate
9. #10 Canary mode
10. #3 Event log replay (or pull earlier if debugging pressure is high)
