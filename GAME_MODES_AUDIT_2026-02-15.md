# Game Modes Audit (2026-02-15)

## Scope
- Agent Mafia
- Agents Among Us
- End-to-end path: BE game engine, socket transport, FE room controls, integration tests

## Before
### Agent Mafia
- BE: only partial module (create/join/start/role assign), no phase/action loop, no finish path.
- Socket: not wired into `server.js`.
- FE: no UI to host/join/start/play.
- Tests: only unit create/join/start.

### Agents Among Us
- BE: docs-only, no executable game module.
- Socket: none.
- FE: none.
- Tests: none.

## Implemented
### Backend/game engines
- Added deterministic Agent Mafia phase loop: `night -> discussion -> voting -> finished`.
- Added deterministic Agents Among Us phase loop: `tasks -> meeting -> finished`.
- Added basic action handling and winner resolution for both.

### Socket/server flow
- Added room create/join/start/action socket events for both games (`mafia:*`, `amongus:*`).
- Added room broadcasts (`mafia:state`, `amongus:state`).
- Added per-room phase schedulers with token-guarded timers to prevent stale-timer collisions.

### Frontend
- Added `/play.html` and `/games.js` for simple host/join/start/action gameplay for both modes.
- Added nav links from index and browse pages.

### Testing
- Added `test/agents-among-us.test.js` (engine loop).
- Added `test/game-modes-flow.test.js` (socket integration loops + timer-collision regression).

## Remaining known gaps
- No auth/permissions beyond host-only start for mode rooms.
- No private role view (all-state currently visible in debug UI).
- No persistent game-mode room history.
- No moderation pipeline on game action text (future if text generation added).
