# ARENA_PLAN.md

Practical execution backlog for Agent Arena (next 1-2 weeks).

## Progress update (2026-02-15)
- ✅ Audited BE/FE gaps for Agent Mafia + Agents Among Us (`GAME_MODES_AUDIT_2026-02-15.md`).
- ✅ Implemented Agent Mafia playable minimal loop:
  - room create/join/start
  - deterministic phases: `night -> discussion -> voting -> finished`
  - basic actions and winner resolution
- ✅ Implemented Agents Among Us playable minimal loop:
  - room create/join/start
  - deterministic phases: `tasks -> meeting -> finished`
  - task/kill/call meeting/vote actions + winner resolution
- ✅ Wired server socket flow for both game modes (`mafia:*`, `amongus:*`) with room broadcasts.
- ✅ Added token-guarded per-room phase schedulers to prevent stale timer collisions.
- ✅ Added FE room UI (`/play.html`, `/games.js`) for host/join/start and phase actions.
- ✅ Added integration/simulation coverage:
  - `test/agents-among-us.test.js`
  - `test/game-modes-flow.test.js`
  - validates full-loop completion and timer-collision resilience.
- ✅ Shipped vertical slice: explicit room lifecycle FSM enforcement for Agent Mafia + Agents Among Us.
  - Added `transitionRoomState` with structured `INVALID_PHASE_TRANSITION` errors.
  - Routed all internal phase/status mutations through FSM transitions.
  - FE now surfaces structured error code + transition details in `/play.html` status.
  - Added 3 new transition tests (`agent-mafia.test.js` x2, `agents-among-us.test.js` x1).
- 🚫 Blocker (deploy): `npx vercel --prod --yes` fails with npm dependency resolution (`ERESOLVE`) while trying to install `vercel@50.17.1` due to conflict with `vercel@50.15.1` / peer `@vercel/backends@0.0.33`.
- ✅ Shipped vertical slice: centralized per-room scheduler service (`lib/room-scheduler.js`) now drives Agent Arena + Agent Mafia + Agents Among Us timers.
  - Removed direct `setTimeout` usage from `server.js` gameplay flows.
  - Added room-scoped cancellation on battle start/reset to prevent stale callbacks.
  - Added regression test: unanimous early voting does not double-finalize when vote deadline timer later fires (`test/battle-flow.test.js`).
- ✅ Shipped vertical slice: append-only normalized room event log + replay scaffold (#3).
  - Added `lib/room-events.js` with per-room bounded event history (last 1,000) and NDJSON append sink (`data/room-events.ndjson`).
  - Instrumented Arena + Agent Mafia + Agents Among Us room lifecycle/actions to emit normalized events.
  - Added room debugging APIs:
    - `GET /api/rooms/:roomId/events?mode=arena|mafia|amongus&limit=...`
    - `GET /api/rooms/:roomId/replay?mode=arena|mafia|amongus`
  - Added docs (`docs/room-events.md`) and test coverage (`test/room-events.test.js`).
- ✅ Shipped vertical slice: async room-event persistence pipeline (#4) with FE ops visibility.
  - Replaced sync NDJSON writes with buffered async batches in `lib/room-events.js` (`fs/promises`, default 250ms flush, best-effort retry queue).
  - Added durability controls: `roomEvents.flush()`, `roomEvents.close()`, queue depth introspection.
  - Added ops APIs + health signal:
    - `GET /api/ops/events` (pending queue depth)
    - `POST /api/ops/events/flush` (manual flush)
    - `/health` now includes `eventQueueDepth`.
  - Added `/play.html` queue status + manual flush button for live verification during room runs.
  - Added persistence regression test: `test/room-events-persistence.test.js` (parseable NDJSON across close/reopen).
- 🚫 Blocker (deploy): unchanged Vercel CLI install conflict (`ERESOLVE`) when `npx vercel --prod --yes` tries to install `vercel@50.17.1` against existing dependency graph (`vercel@50.15.1`/peer `@vercel/backends@0.0.33`).
- ▶ Next: reliability/observability baseline (#9): correlation IDs + richer health metrics (scheduler timers + queue depth by subsystem).

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
