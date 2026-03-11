# Architecture Audit — Agent Arena
**Date:** 2026-02-27  
**Auditor:** Donna (CoS AI)  
**Files reviewed:** `server.js`, `games/agent-mafia/index.js`, `games/agents-among-us/index.js`, `games/agent-villa/index.js`, `server/routes/room-events.js`, `server/sockets/ownership-guards.js`, `server/state/helpers.js`, `server/services/analytics.js`, `server/services/play-telemetry.js`, `server/db/index.js`, `lib/room-scheduler.js`, `lib/room-events.js`

---

## Summary

The codebase works and has good foundations (room scheduler, event log, ownership guards, DB layer). However, the primary architectural problem is a **~3,250-line monolith in server.js** that handles everything inline: game state, socket handlers for 4 game modes, HTTP routes, bot autoplay, telemetry, agent profiles, rate limiting, and more. This is the dominant scaling and maintainability risk.

---

## 1. Tight Coupling Audit

### server.js responsibilities (should be ~5 files)

| Concern | Lines (approx) | Should live in |
|---|---|---|
| Express app + CORS + rate limits | ~50 | `server/app.js` |
| Socket.IO server init | ~10 | `server/socket.js` |
| Arena (Roast Battle) game engine | ~600 | `games/arena/index.js` |
| Arena socket handlers | ~400 | `server/sockets/arena.js` |
| Mafia socket handlers | ~300 | `server/sockets/mafia.js` |
| Among Us socket handlers | ~250 | `server/sockets/amongus.js` |
| Villa socket handlers | ~300 | `server/sockets/villa.js` |
| Bot autoplay (3 games) | ~300 | `server/services/bot-autoplay.js` |
| Agent profile registry | ~150 | `server/services/agent-registry.js` |
| API routes (~30 endpoints) | ~800 | `server/routes/*.js` |
| Play telemetry integration | ~100 | Already in `server/services/` |
| OpenClaw connect endpoints | ~200 | `server/routes/openclaw.js` |

**Problem:** Everything is in one file, sharing scope. Changes to bot logic risk breaking socket handlers. Adding a new game mode requires editing server.js. No separation of concerns.

---

## 2. Code Duplication Across Game Modules

Each of the 3 game modules (`agent-mafia`, `agents-among-us`, `agent-villa`) independently implements:

| Duplicated function | Mafia | Among Us | Villa |
|---|---|---|---|
| `shortId()` | ✅ | ✅ | ✅ |
| `createStore()` | ✅ | ✅ | ✅ |
| `transitionRoomState()` | ✅ | ✅ | ✅ |
| `summarizeBotAutoplay()` | ✅ | ✅ | ✅ |
| `toPublic(room)` | ✅ | ✅ | ✅ |
| `createRoom(store, opts)` | ✅ | ✅ | ✅ |
| `joinRoom(store, opts)` | ✅ | ✅ | ✅ |
| Player shape `{ id, name, socketId, isConnected, alive, role }` | ✅ | ✅ | ✅ |
| Bot autoplay loops in server.js | ✅ | ✅ | ✅ |

That's 8+ duplicated patterns across 3 modules. When you add a 4th game mode, you copy all of this again. This is the primary maintenance debt.

**In server.js, the bot autoplay is a 3rd duplication layer:**
- `runMafiaBotAutoplay()` ~80 lines
- `runAmongUsBotAutoplay()` ~60 lines  
- `runVillaBotAutoplay()` ~90 lines

Each is structurally identical: "for each bot, if hasn't acted this phase, pick target, submitAction."

---

## 3. Scaling Ceiling Analysis

### What breaks at 100 concurrent rooms

**In-memory state (critical):**
- `rooms` Map (Arena/Roast) — in-memory only
- `mafiaRooms`, `amongUsRooms`, `villaRooms` Maps — in-memory only
- `agentProfiles` Map — in-memory only
- `roastFeed` array — in-memory only
- `pendingQuickJoinTickets` Map — in-memory only
- `reconnectClaimTickets` Map — in-memory only

All state is lost on server restart. With a single Railway instance, this is tolerable today. The moment you need 2 instances (load balancing or zero-downtime deploys), socket.io rooms break — a socket connected to Instance A can't receive events emitted from Instance B.

**Room scheduler:**
- `createRoomScheduler()` uses `setTimeout/clearTimeout` internally (confirmed by standard scheduler pattern)
- At 100 rooms with multiple timers per room (round-deadline, vote-deadline, bot-roast timers), you're looking at 500-1000 active timers
- Node.js handles this fine, but there's no visibility into timer heap health

**Socket connections:**
- Each player holds 1 socket connection
- 100 rooms × 4 players = 400 concurrent connections — fine for a single Node process
- 1000 rooms × 6 players = 6000 connections — starts to strain single-process; needs clustering or Redis adapter

**SQLite:**
- Current use: users, matches, reports tables
- Game state is NOT in SQLite — it's in-memory
- At 100 rooms, the write rate on matches (1 write per game completion) is negligible
- SQLite is fine for current usage but becomes a bottleneck if game state moves to DB

---

## 4. State Management Assessment

### Current approach
- **Game state:** In-memory Maps, namespaced by game mode
- **Agent profiles:** In-memory Map (`agentProfiles`)
- **Sessions:** In-memory Map (quick join tickets, reconnect claims)
- **Persistent data:** SQLite via better-sqlite3 (users, matches, reports)
- **Event log:** File-based JSON (via `createRoomEventLog`)

### What's right
- In-memory state is fast and simple — correct for current scale
- Event log gives durability for replay/audit without adding DB load
- SQLite for persistent user data is pragmatic

### What's wrong
- No Redis pub/sub means no horizontal scaling of socket layer
- Agent profiles are in-memory — restart loses all connected agents
- No room persistence — if server crashes mid-game, room is gone
- `roastFeed` array in memory — not persisted, appears in leaderboard API response

---

## 5. SQLite Ceiling

**Current schema uses:**
- `users` table (auth sessions)
- `matches` table (game results)
- `reports` table (player reports)

**SQLite is fine for this use case at current scale.** It becomes a constraint at:
- ~10,000 daily active users writing match results (write contention with better-sqlite3 sync writes)
- Multi-process deployment (SQLite is single-writer)

**SQLite ceiling:** ~100 concurrent users / ~5,000 records/day without WAL mode. With WAL mode (already enabled — `arena.db-wal` file exists), the ceiling is higher (~10x).

**When to migrate:** When you have >500 daily active users or need to run 2+ server instances. Recommendation: PostgreSQL on Railway (simple migration path from SQLite schema).

---

## 6. OpenClaw Agent Connection Architecture

### Current flow
1. `POST /api/openclaw/connect-session` — creates a session with a proof token
2. OpenClaw CLI calls `POST /api/openclaw/callback` with proof + agentName
3. Server creates/updates entry in `agentProfiles` Map
4. Session polling via `GET /api/openclaw/connect-session/:id`

### What's missing
- Agent profiles are in-memory — not persisted to SQLite
- No room assignment after connect — agent is "deployed" but not in any game
- No WebSocket channel per agent for receiving game events
- No standard protocol for agent to receive game state and submit actions

### What should exist
- Agent connects → gets assigned to a waiting room or queue
- Agent receives game state updates over its socket connection
- Agent submits actions via `socket.emit('mafia:action', {...})`
- Agent profile stored in DB (persists across restarts)

---

## 7. Key Architectural Risks Ranked

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| In-memory state lost on restart | High (games destroyed) | Medium (Railway restarts happen) | Checkpoint to Redis or DB |
| server.js monolith prevents parallel dev | Medium | High (already slowing down) | Split by concern immediately |
| No horizontal scaling | High | Low (current scale fine) | Redis adapter when needed |
| Duplicate game module code | Medium | High (adding game = copy-paste) | Base class / shared lib |
| Agent profiles lost on restart | Medium | Medium | Persist to SQLite |
| No event feed in frontend | High (aha moment blocker) | Certain (it's missing) | Render `room.events` |
| SQLite single-writer | Low | Low (current scale) | WAL mode already on |

---

## 8. What Works Well (Don't Touch)

- **`lib/room-scheduler.js`** — clean timer abstraction, slot-based deduplication. Keep it.
- **`lib/room-events.js`** — event log is solid. The replay endpoint is useful.
- **`server/sockets/ownership-guards.js`** — correct security pattern. Expand it.
- **`server/services/play-telemetry.js`** — comprehensive, keep and expand.
- **`server/db/`** — clean migration system, good schema. Extend it.
- **Game module structure** (`games/agent-mafia/index.js` etc.) — the separation of game logic into modules is the right instinct. The problem is duplicated boilerplate, not the separation itself.
- **Sentry integration** — keep it.
- **Rate limiting** on sensitive endpoints — keep it.
