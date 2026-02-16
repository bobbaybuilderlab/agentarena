# ARENA_PLAN.md

Practical execution backlog for Agent Arena (next 1-2 weeks).

## Progress update (2026-02-16, cycle 05:31 UTC)
- ✅ Shipped vertical slice: lobby reconnect claim loop (host reclaim + disconnected human reclaim) for Agent Mafia + Agents Among Us.
  - Added backend claim discovery endpoint: `GET /api/play/lobby/claims?mode=mafia|amongus&roomId=...`.
  - Endpoint returns claimable disconnected human seats with host marker (`hostSeat`) + `hasHostClaim` signal.
  - Updated play-room FE (`public/play.html`, `public/games.js`, mirrored `frontend/*`) with:
    - `Find Reconnect Seats` CTA,
    - reconnect seat chips (`Claim {name}`) including host badge,
    - one-click reclaim flow that reuses existing lobby identity by name.
  - Added regression test `test/play-rooms.test.js`:
    - validates claim endpoint payload,
    - verifies host can reclaim by name and keeps original `playerId`,
    - verifies host seat disappears from claim list once reclaimed.
  - Validation: `npm test` (55/55 passing).
- 🚫 Blocker (deploy): `npx vercel --prod --yes` still fails during CLI auto-install with npm resolver conflict (`ERESOLVE`) while installing `vercel@50.17.1` against peer graph conflict around `@vercel/backends@0.0.33` and existing `vercel@50.15.1` resolution.
- ▶ Next: make reconnect claims zero-friction from quick-join links (optional claim token / suggested reclaim name) so returning hosts recover rooms without manual room-id lookup.

## Progress update (2026-02-16, cycle 04:42 UTC)
- ✅ Shipped vertical slice: launch-readiness aware room discovery + quick-match ranking hardening (Agent Mafia + Agents Among Us).
  - Added server-side `launchReadiness` summary on `/api/play/rooms` cards:
    - `hostConnected`, `canHostStartReady`, `botsNeededForReady`, disconnected-human details.
  - Updated room `matchQuality` scoring to factor host-online signal and disconnected-lobby penalty.
  - Quick-join routing now naturally de-prioritizes host-offline lobbies when host-online alternatives exist.
  - Updated homepage room cards (`public/app.js` + `frontend/app.js`) with explicit launch line:
    - `Host online · start-ready ✅/⏳ · bots needed: N`
    - or host-offline warning to avoid dead-end joins.
  - Added regression coverage in `test/play-rooms.test.js`:
    - verifies readiness payload shape,
    - verifies quick-join prefers host-online lobby over host-offline lobby.
  - Validation: `npm test` (54/54 passing).
- 🚫 Blocker (deploy): `npx vercel --prod --yes` still fails during CLI install with npm resolver conflict (`ERESOLVE`) while auto-installing `vercel@50.17.1` (peer graph conflict around `@vercel/backends@0.0.33` / existing `vercel@50.15.1`).
- ▶ Next: ship lobby reconnect claim UX (host reclaim + disconnected-human claim by name) so host-offline warnings convert back to startable rooms faster.

## Progress update (2026-02-16)
- ✅ Shipped vertical slice: one-click lobby `Start Ready` flow (Agent Mafia + Agents Among Us) with explicit readiness context + auto-recovery.
  - Added host-only socket events:
    - `mafia:start-ready`
    - `amongus:start-ready`
  - New server orchestration (`startReadyLobby`) now handles one click from lobby to match start:
    - removes disconnected non-bot lobby players,
    - auto-fills bots to 4 players,
    - starts match + schedules next phase timer,
    - emits `LOBBY_START_READY` room event with replacement/fill counts.
  - Added lobby readiness model (`getLobbyStartReadiness`) with structured reasons surfaced via error details.
  - Updated FE lobby controls (`public/games.js` + `frontend/games.js`):
    - Start button is now `Start Ready` in lobby,
    - host sees explicit readiness hints (missing players, disconnected players),
    - status message confirms bot fill + disconnected replacements used at launch.
  - Added regression test (`test/play-rooms.test.js`):
    - verifies host-only `start-ready` guard,
    - validates disconnected guest replacement and bot auto-fill before game start.
  - Validation: `npm test` (53/53 passing).
- ✅ Shipped vertical slice: telemetry-aware quick-match routing + lobby fit score surfacing for Agent Mafia/Agents Among Us discovery.
  - Added room-level match quality scoring (`matchQuality`) combining fill rate, quick-match conversion signal, and rematch momentum.
  - `/api/play/rooms` now returns `matchQuality` + `hotLobby` flags per room card.
  - `POST /api/play/quick-join` now ranks open-room candidates by fit score (then players, then recency) instead of raw player count only.
  - Added test-only telemetry seeding helper (`seedPlayTelemetry`) to validate deterministic room-ranking behavior.
  - Updated homepage room cards (`public/app.js` + `frontend/app.js`) to show fit score and hot-lobby badge (`🔥`) for higher-momentum rooms.
  - Added/updated regression coverage in `test/play-rooms.test.js` for quality-weighted quick-join selection + telemetry counters.
  - Validation: `npm test` (52/52 passing).
- ✅ Shipped vertical slice: match history + rematch streak telemetry in room discovery loop (`/api/play/rooms` + homepage cards).
  - Added per-room telemetry model in server memory:
    - `rematchCount`
    - `recentWinners` (rolling last 5)
    - `quickMatch` (`tickets`, `conversions`, `conversionRate`)
  - Wired telemetry collection into live gameplay paths:
    - quick-join ticket issue (`POST /api/play/quick-join`)
    - quick-join conversion on matching socket joins (`mafia:room:join`, `amongus:room:join`)
    - rematch increments (`mafia:rematch`, `amongus:rematch`)
    - winner capture for finished rooms surfaced via discovery summaries.
  - Updated FE room cards (`public/app.js` + `frontend/app.js`) to display:
    - rematch streak count
    - quick-match conversion ratio + percentage
    - recent winners chain.
  - Added regression coverage in `test/play-rooms.test.js`:
    - quick-match conversion increments after ticketed join
    - winner telemetry appears for finished rooms
    - rematch count increments after host rematch.
  - Validation: `npm test` (52/52 passing).
- ✅ Shipped vertical slice: lobby/start guardrails + one-click rematch loop for Agent Mafia + Agents Among Us MVP rooms.
  - Added host-aware FE guardrails on `/play.html`:
    - Start button now disables with explicit reasons (host-only, not in lobby, <4 players).
    - Auto-fill button now disables outside lobby/non-host.
    - Added rematch CTA button (host + finished-state only).
    - Status line now nudges lobby readiness (`players X/4`) for host/guests.
  - Added BE rematch flow (socket + game modules):
    - `mafia:rematch` and `amongus:rematch` events.
    - New game helpers `prepareRematch(...)` reset finished rooms to lobby baseline and preserve player roster/bots.
    - Rematch immediately restarts the match and re-enables phase scheduling/autoplay.
  - Added host identity to public room payloads (`hostPlayerId`) so FE can enforce guardrails without extra API calls.
  - Added regression coverage: `test/play-rooms.test.js` rematch test (host-only enforcement + both mode rematch restarts).
- ✅ Shipped vertical slice: in-game bot autopilot loop for Agent Mafia + Agents Among Us bot-filled lobbies.
  - Added deterministic server-side bot actions during active phases:
    - Agent Mafia: bot mafia night kill, bot discussion ready, bot voting.
    - Agents Among Us: bot crew tasking, bot imposter kill, bot meeting vote.
  - Scheduler now runs autopilot before phase timer scheduling so rooms can progress without multi-client manual input.
  - Added room event instrumentation for autoplay activity (`BOTS_AUTOPLAYED`) in both modes.
  - Added FE visibility: play-room status now shows `🤖 Bot autopilot active` when mode state is autoplay-enabled.
  - Added regression coverage: `test/bot-autoplay-modes.test.js` (one human + bot autofill can finish both game loops).
- 🚫 Blocker (deploy): Vercel deploy still fails at CLI install with npm resolver conflict (`ERESOLVE`) when `npx vercel --prod --yes` auto-installs `vercel@50.17.1` against peer graph `@vercel/backends@0.0.33` and existing `vercel@50.15.1` resolution.
- ▶ Next: ship one-click "start-ready" lobby flow (host sees explicit missing-readiness reasons + auto-ready for bots/returning players) so quick-joined rooms start in <1 click.

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
- ✅ Shipped vertical slice: reliability/observability baseline (#9) with correlation IDs + richer health metrics.
  - Added request correlation IDs (`X-Correlation-Id`) for HTTP and socket correlation IDs via handshake metadata.
  - Added structured JSON logs for HTTP requests and socket event traffic (`event`, `correlationId`, `roomId`, `socketId`).
  - Expanded health/ops APIs:
    - `/health` now reports `uptimeSec`, room counts by mode, `schedulerTimers` (total + by namespace), and event queue depth by mode.
    - `/api/ops/events` and `/api/ops/events/flush` now include `pendingByMode`.
  - Added scheduler/event-log instrumentation primitives:
    - `roomScheduler.stats()`
    - `roomEvents.pendingByMode()`
  - Added regression coverage: `test/observability.test.js` (health metrics + correlation-id header assertions).
- 🚫 Blocker (deploy): still blocked by Vercel CLI dependency resolution conflict (`ERESOLVE`) when `npx vercel --prod --yes` installs `vercel@50.17.1` against peer graph (`@vercel/backends@0.0.33`) and existing `vercel@50.15.1`.
- ✅ Shipped vertical slice: bot turn loop abstraction (#5) extracted to `bots/turn-loop.js`.
  - Added explicit pipeline stages: `planBotTurn -> draftBotRoast -> selfCheckBotTurn -> submitBotTurn` via `runBotTurn`.
  - Server now routes arena auto-roasts + auto-battle generation through the shared bot module.
  - Self-check enforces max roast length (280) and required policy tags (`humor`, `no-hate`, `no-threats`).
  - Added focused module tests: `test/bot-turn-loop.test.js`.
- ✅ Shipped vertical slice: lightweight episodic bot memory (#6) with generation context.
  - Added `bots/episodic-memory.js` to persist per-bot rolling memory (last 3 rounds): `theme`, `roast`, `votes`, `winner`.
  - Arena `finalizeRound` now records round outcomes for every bot and trims memory window automatically.
  - `generateBotRoast` now injects memory summary + recent roasts into `runBotTurn`, reducing exact repeat lines when alternatives exist.
  - Added regression coverage: `test/bot-memory.test.js` + updated `test/arena.test.js` signature usage.
- 🚫 Blocker (deploy): `npx vercel --prod --yes` still fails with npm dependency resolution (`ERESOLVE`) when trying to install `vercel@50.17.1`, conflicting with peer graph (`@vercel/backends@0.0.33`) and existing `vercel@50.15.1` resolution.
- ✅ Shipped vertical slice: roast safety/policy gate (#7) with structured moderation reason codes + audit logging.
  - Added `bots/roast-policy.js` moderation middleware (`POLICY_OK`, `POLICY_THREAT`, `POLICY_SELF_HARM`, `POLICY_HATE`, etc.) with normalized text handling.
  - Enforced gate before arena room roast publish (`roast:submit`): blocked content now returns structured `code` and emits `ROAST_REJECTED_POLICY` room events.
  - Added policy audit logging via structured logs (`event=roast_policy_decision`) for both room submissions and auto-battle roast registration.
  - Added unit edge-case coverage (`test/roast-policy.test.js`) for allowed text + disallowed threat/self-harm/hate cases.
- 🚫 Blocker (deploy): `npx vercel --prod --yes` still fails with npm resolver conflict (`ERESOLVE`) while auto-installing `vercel@50.17.1` against peer graph (`@vercel/backends@0.0.33`) and existing `vercel@50.15.1` resolution.
- ✅ Shipped vertical slice: eval harness + ops UI baseline (#8) with 20 deterministic fixtures.
  - Added fixture set (`test/fixtures/eval-fixtures.json`) covering Agent Mafia + Agents Among Us deterministic outcomes.
  - Added `lib/eval-harness.js` to compute baseline metrics: completion rate, winner determinism, vote-integrity errors, mean round steps.
  - Added backend eval API: `GET /api/evals/run`.
  - Added FE controls on `/play.html` to run evals and display metric summary/failed fixture IDs.
  - Added regression coverage: `test/eval-harness.test.js` (fixture count/metrics + API payload shape).
- ✅ Shipped vertical slice: CI eval gate + FE pass/fail visibility (#8 completion).
  - Added threshold module (`lib/eval-thresholds.js`) with overridable env-based gates:
    - completionRate, winnerDeterminism, fixturePassRate, voteIntegrityErrors, meanRoundSteps.
  - Added CLI gate command `npm run eval:ci` via `lib/eval-ci.js` (non-zero exit on threshold failure).
  - Added backend CI payload API: `GET /api/evals/ci`.
  - Added FE controls on `/play.html` + `/games.js` for “Run CI Gate” with per-metric ✅/❌ output.
  - Added regression coverage for threshold gate + CI API shape (`test/eval-harness.test.js`).
- 🚫 Blocker (deploy): Vercel deploy remains blocked by CLI dependency resolver conflict (`ERESOLVE`) when `npx vercel --prod --yes` attempts `vercel@50.17.1` against peer graph (`@vercel/backends@0.0.33`) and existing resolution (`vercel@50.15.1`).
- ✅ Shipped vertical slice: canary mode for roast policy updates (#10) with deterministic room hash targeting + rollback switch.
  - Added deterministic canary assigner (`lib/canary-mode.js`) using stable room hash + `%` rollout controls.
  - Added safe rollback/config flags:
    - `ARENA_CANARY_ENABLED=0|1` (off forces full control path)
    - `ARENA_CANARY_PERCENT=0-100` (default 0)
  - Arena room roast moderation now uses per-room `policyVariant` (`control|canary`) and emits variant-tagged policy decisions/logs.
  - Added control vs canary decision counters and ops surfaces:
    - `GET /api/ops/canary`
    - `/health.canary` summary
    - `/play.html` ops status line for canary config + decision totals.
  - Added tests:
    - `test/canary-mode.test.js`
    - `test/roast-policy.test.js` canary stricter-rule coverage
    - `test/observability.test.js` canary endpoint + health assertions.
- ✅ Shipped vertical slice: cross-mode room discovery + quick-join from front page (Agent Mafia + Agents Among Us MVP loop UX).
  - Added backend room discovery API: `GET /api/play/rooms?mode=all|mafia|amongus&status=all|open`.
  - API returns normalized room cards (`mode`, `roomId`, `status`, `phase`, `players`, `canJoin`) + summary counts.
  - Added home-page “live game rooms” panel with auto-refresh + quick-join links.
  - Added `play.html` URL-driven join (`?game=mafia|amongus&room=ABC123&autojoin=1`) for one-click lobby entry.
  - Added regression coverage: `test/play-rooms.test.js` (cross-mode listing + open-room filter behavior).
- 🚫 Blocker (deploy): still blocked by Vercel CLI dependency resolver conflict (`ERESOLVE`) when `npx vercel --prod --yes` attempts to install `vercel@50.17.1` with peer `@vercel/backends@0.0.33` against existing `vercel@50.15.1` graph.
- ✅ Shipped vertical slice: server-side quick-match API + FE one-click entry for Agent Mafia + Agents Among Us MVP loop.
  - Added backend endpoint: `POST /api/play/quick-join`.
  - Endpoint behavior:
    - selects best-fit open room (prefers fullest lobby in selected mode), or
    - creates a new room when none are available,
    - returns `joinTicket` (`joinUrl`, `mode`, `roomId`, `name`) for zero-friction redirect.
  - Added FE quick-match triggers:
    - home page “Quick Match Me” button (`/`)
    - play page “Quick Match” button (`/play.html`)
  - Added regression coverage: `test/play-rooms.test.js` quick-join selection + room-creation cases.
- ✅ Shipped vertical slice: host-side lobby bot autofill for Agent Mafia + Agents Among Us quick-start loops.
  - Added per-mode lobby bot injection helpers:
    - `games/agent-mafia/index.js` → `addLobbyBots`
    - `games/agents-among-us/index.js` → `addLobbyBots`
  - Added host-only socket events:
    - `mafia:autofill`
    - `amongus:autofill`
  - Added REST endpoint for ops/automation: `POST /api/play/lobby/autofill`.
  - Improved quick-match creation flow:
    - new rooms are now created with the quick-match player as host identity,
    - lobby auto-fills to 4 players immediately (`QUICK_JOIN_MIN_PLAYERS`),
    - user can autojoin and start without waiting for more humans.
  - FE updates on `/play.html` + `/games.js`:
    - added “Auto-fill to 4” button,
    - player cards now show bot marker (`🤖`).
  - Added regression coverage: `test/play-rooms.test.js`
    - validates quick-join room creation now auto-fills + preserves host identity,
    - validates host-only autofill permissions + successful start after autofill.
- 🚫 Blocker (deploy): Vercel deploy still fails at CLI install step with npm resolver conflict (`ERESOLVE`) when `npx vercel --prod --yes` auto-installs `vercel@50.17.1` and hits peer conflict with `@vercel/backends@0.0.33` while `vercel@50.15.1` exists in the graph.
- ▶ Next: ship minimal in-game bot autopilot actions for Mafia + AmongUs (night kill / ready+vote / task+meeting vote) so bot-filled lobbies complete full loops without manual multi-client input.

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
