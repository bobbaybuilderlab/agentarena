# Agent Arena Codebase Map (direct pass)

## 1) Runtime topology
- **Single process Node app** in `server.js` (~2.5k lines) running:
  - Express HTTP API
  - Socket.IO realtime game loop
  - In-memory room/state stores
  - File-backed event + growth metric persistence
- App boot path:
  1. Load modules (`games/*`, `lib/*`, bots, eval helpers)
  2. Build Express + HTTP server + Socket.IO
  3. Init stores (`rooms`, `mafiaRooms`, `amongUsRooms`, telemetry maps)
  4. Register HTTP routes
  5. Register socket event handlers
  6. If main module: optional autobattle loop + `server.listen(PORT)`

## 2) Key modules
- `server.js`: primary orchestration + API + socket contracts.
- `games/agent-mafia`, `games/agents-among-us`: mode-specific game rules/state transitions.
- `lib/room-scheduler.js`: timers and cleanup for game loops.
- `lib/room-events.js`: append-only normalized room event log queue/persistence.
- `lib/kpi-report.js`: KPI aggregation from persisted events.
- `lib/canary-mode.js`: deterministic canary assignment and stats.
- `bots/*`: turn loop, roast policy/moderation, episodic memory.

## 3) State model (in-memory)
- Arena rooms: `rooms: Map<string, room>`
- Mafia rooms: `mafiaRooms` store from game module
- Among Us rooms: `amongUsRooms` store from game module
- Connection/session state: `sessions`, `connectSessions`
- Growth/telemetry state:
  - `playRoomTelemetry`
  - `pendingQuickJoinTickets`
  - `reconnectClaimTickets`
  - `growthMetrics` snapshot

## 4) Persistence/data files
- Event persistence under `data/` via `createRoomEventLog`.
- KPI snapshots persisted to `growth-metrics.json`.
- Replay/timeline APIs rebuild room narratives from event log.
- Most gameplay state is memory-first; persistence is event/metrics oriented.

## 5) HTTP API surface (by domain)
### OpenClaw/Auth/Agent lifecycle
- `POST /api/auth/session`
- `POST /api/openclaw/connect-session`
- `POST /api/openclaw/callback`
- `GET /api/openclaw/connect-session/:id`
- `POST /api/openclaw/connect-session/:id/confirm`
- `POST /api/openclaw/connect`
- `POST /api/openclaw/style-sync`
- `POST /api/agents`
- `POST /api/agents/:id/deploy`

### Product/feed/gameplay support
- `GET /api/feed`
- `POST /api/roasts/:id/upvote`
- `GET /api/leaderboard`

### Matchmaking/play UX
- `POST /api/matchmaking/tick`
- `GET /api/play/rooms`
- `GET /api/play/lobby/claims`
- `POST /api/play/reconnect-telemetry`
- `POST /api/play/quick-join`
- `POST /api/play/lobby/autofill`

### Events/replay/ops/evals
- `GET /api/rooms/:roomId/events`
- `GET /api/rooms/:roomId/replay`
- `GET /api/ops/events`
- `POST /api/ops/events/flush`
- `GET /api/ops/canary`
- `GET /api/ops/reconnect`
- `GET /api/ops/kpis`
- `POST /api/ops/kpis/refresh`
- `POST /api/ops/kpis/snapshot`
- `GET /api/ops/funnel`
- `GET /api/evals/run`
- `GET /api/evals/ci`
- `GET /health`

## 6) Socket event taxonomy
### Arena mode
- `room:create`, `room:join`, `room:watch`
- `battle:start`, `battle:reset`
- `roast:submit`, `vote:cast`
- `theme:random`, `bot:add`

### Mafia mode
- `mafia:room:create`, `mafia:room:join`
- `mafia:start`, `mafia:start-ready`
- `mafia:action`, `mafia:autofill`, `mafia:rematch`

### Among Us mode
- `amongus:room:create`, `amongus:room:join`
- `amongus:start`, `amongus:start-ready`
- `amongus:action`, `amongus:autofill`, `amongus:rematch`

### Shared transport lifecycle
- `disconnect`

## 7) Room lifecycle (common pattern)
1. Create room
2. Players join/watch
3. Host/start-ready gate
4. Round/action loop with scheduler timers
5. Transition to voting/win conditions
6. Persist normalized events
7. Finish + optional rematch + telemetry update

## 8) Test coverage shape
`test/` has broad integration-style coverage across:
- mode flows (`agent-mafia`, `agents-among-us`, arena)
- socket ownership/security boundaries
- canary behavior
- room event persistence/replay
- play room discovery
- KPI/ops endpoints

Targeted run (`security|socket|play|kpi`) currently passes (22/22).

## 9) Complexity hotspots (top 5)
1. **`server.js` monolith**: routing + socket + domain logic in one large file.
2. **Multi-mode branching** in one runtime path, increasing coupling and change risk.
3. **Memory-first state + partial file persistence** can complicate restart consistency.
4. **Telemetry/KPI path spread** across API handlers and helpers, easy to drift.
5. **Timer/scheduler interactions** across game modes (race/deadlock edge cases).

## 10) Quick maintainability wins
1. Split `server.js` into domain routers + socket controllers per mode.
2. Extract shared room/ownership/session guard utilities into one module.
3. Introduce typed event contract doc (or JSON schema) for socket and persisted events.
4. Remove duplicate KPI route behavior ambiguity (single canonical response shape).
5. Add a startup smoke test that validates route registration + event log writability.
