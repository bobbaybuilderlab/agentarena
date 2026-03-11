# SELF_REVIEW.md — Critical Self-Review of Implementation Plan

## 1. What's Wrong or Missing

### 1.1 The Human Join Type Problem 🔴

**Problem:** The current join flow requires the player to *self-declare* their type (`type: 'human' | 'agent'`). This is fundamentally broken.

- A human player can join as `type: 'agent'` and never be identified as human
- A malicious human could declare `type: 'agent'` and break the game premise entirely
- Or worse: the room ends up with 0 humans and the game is meaningless

**The actual correct design:**
- The human slot should be either: (a) pre-assigned to a specific join link, (b) first-come-first-served with the room creator choosing who the human is, OR (c) the host IS the human by default
- For MVP, the cleanest approach: **Host creates room and IS the human player.** All other slots are agents (bots or OpenClaw agents). The host's browser is the "human" slot. No self-declaration needed.
- This needs to be enforced server-side: when `createRoom()` is called with `type: 'human'`, that player is assigned `role: 'human'`. Any subsequent `joinRoom()` calls with `type: 'human'` return `HUMAN_SLOT_TAKEN`.

**Fix needed:** Confirm the intended design. For MVP: room creator = human. Document this constraint clearly.

---

### 1.2 The `createRoom` vs `joinRoom` Double-Call Bug 🔴

**Problem:** In server.js Step 3.4, the `gta:room:create` handler calls:
1. `gtaGame.createRoom()` to create the room
2. Then immediately calls `gtaGame.joinRoom()` to add the host as a player

This double-call pattern is inconsistent with how `agents-among-us/index.js` does it — that module returns the player as part of `createRoom()`. The double-call could create a duplicate player record.

**Fix:** `createRoom()` in the GTA module should return `{ ok, room, player }` where `player` is already added to `room.players`. Do NOT call `joinRoom()` separately for the host. This is the existing pattern in mafia, villa, among-us.

---

### 1.3 Missing: `_forceAgentsWin()` Internal Method 🟡

**Problem:** In the disconnect handler, I reference `gtaGame._forceAgentsWin()` but this method is not defined in the game module spec. Private methods starting with `_` that are called from outside the module are a design smell.

**Fix:** Add a proper `abandonGame(store, { roomId, reason })` public function to the game module that triggers `finish(room, 'agents')` with a reason field. Or handle the abandonment entirely in server.js by calling `forceAdvance()` after manually checking human connection status.

Better pattern:
```js
// In game module
function forceAgentsWin(store, { roomId }) {
  const room = store.get(String(roomId || '').toUpperCase());
  if (!room) return { ok: false };
  if (room.status !== 'in_progress') return { ok: false };
  return finish(room, 'agents', { reason: 'human_abandoned' });
}
module.exports = { ..., forceAgentsWin };
```

---

### 1.4 Bot Vote Timing Race Condition 🟡

**Problem:** In `scheduleGtaPhase()` for the vote phase, I schedule individual bot vote timers AND a phase deadline timer. If all bots vote before the deadline, `castVote()` calls `resolveRound()` which transitions to 'result'. But the phase deadline timer still fires, and it may try to call `forceAdvance()` on a room that's already in 'result' phase.

The existing codebase handles this via token checks (`token: ${room.round}:vote`), but I need to make sure the `forceAdvance()` function inside the timer checks the current phase before doing anything.

**Fix:** Ensure `forceAdvance()` is a no-op if the phase has already advanced. The `roomScheduler` token pattern partially handles this, but `forceAdvance()` should also guard:
```js
function forceAdvance(store, { roomId }) {
  const room = store.get(...);
  if (!room || room.status !== 'in_progress') return { ok: false };
  // Only advance if in a valid phase
  const advanceable = ['prompt', 'reveal', 'vote', 'result'];
  if (!advanceable.includes(room.phase)) return { ok: false, error: { code: 'ALREADY_ADVANCED' } };
  // ... rest of logic
}
```

---

### 1.5 `emitGtaRoom` Socket Lookup Performance 🟡

**Problem:** `emitGtaRoom()` iterates all players and looks up each socket by ID via `io.sockets.sockets.get(player.socketId)`. This is fine for 6 players, but it's also called frequently (every state change). More importantly, it assumes `io.sockets.sockets` is a Map (Socket.IO 4.x behavior), which is correct but worth making explicit.

**Minor issue:** If a player has `socketId: null` (bot), the lookup returns `undefined` which is handled by the `if (sock)` check. This is fine.

**Non-issue but worth noting:** The `gta:state:self` emit requires iterating all players each time. At 6 players this is trivial. Document it anyway.

---

### 1.6 Missing: Human Reconnect UX on Frontend 🟡

**Problem:** The disconnect handler sets a 30-second reconnect window, but the frontend spec doesn't show how the human is told they're in danger of losing if they disconnect and reconnect.

When the human disconnects, other players see their connection dot go grey. When the human reconnects, they need to:
1. Know they were disconnected
2. See a "you were almost caught!" type message
3. Resume the game without missing too much

**Fix needed in UI_UX_SPEC.md:** Add a "reconnecting" banner state and a "reconnected" state in the frontend. The `guess-the-agent.js` should handle `socket.on('connect')` and check `currentState.phase` to resume correctly.

---

### 1.7 `responsesByRound` Hidden During Reveal Phase — Logic Gap 🟡

**Problem:** The spec says responses are hidden during `prompt` phase and revealed in `reveal` phase. The `toPublic()` function needs to implement this. But the spec for `toPublic()` doesn't give the full logic for `buildPublicResponses(room)`.

If `buildPublicResponses()` returns anonymised responses during reveal and de-anonymised during vote/result, there's a risk of:
- Response order being fixed (easy to correlate by submission order)
- Response attribution leaking before vote phase

**Fix:** In `buildPublicResponses(room)`:
- During `prompt` phase: return null (nothing shown)
- During `reveal` phase: return responses shuffled in a deterministic random order, with keys like 'A', 'B', 'C' instead of playerIds — NO player ID attached
- During `vote` phase: return responses with playerIds (for voting)
- During `result` and `finished` phases: full data

The shuffle must be **deterministic per game** (seeded by room.id + round) so all clients see the same response order.

---

### 1.8 Database Schema for GTA Winner Not Matched 🟠

**Problem:** The `recordMatch()` call at the end of a GTA game stores `winner: room.winner` which would be `'human'` or `'agents'`. But the existing `getPlayerMatches()` query may not handle this type of winner (previous modes store winner as a player NAME, not a team name).

**Fix:** Check the `recordMatch()` function signature. If winner must be a player name, store it as `'[HUMAN] Alice'` or `'[AGENTS] All'`. Better: add a `metadata` JSON field. For MVP, just store `room.winner` and note the inconsistency in the code.

---

### 1.9 Missing Test: Role Security 🔴

**Problem:** I specified a unit test for role security, but the test file spec doesn't have an explicit test for the socket-level emission. The `toPublic()` unit test covers the function in isolation, but there's no integration test that confirms the socket event payload doesn't include role data.

**Fix:** Add socket-level integration test:
```js
test('gta:state broadcast does not include role for other players', (done) => {
  // create room, start game, verify that gta:state event
  // received by a non-human player contains no role field
});
```

---

### 1.10 Phase Timer Countdown Source of Truth 🟠

**Problem:** The plan says "timer counts down from `roundEndsAt`" on the client. But `roundEndsAt` is set when the PHASE BEGINS. If the client reconnects mid-phase, `roundEndsAt` may be in the past (if the phase has already ended server-side) or still valid.

**Fix:** Client should always compute `remaining = Math.max(0, state.roundEndsAt - Date.now())`. If `remaining === 0`, the timer shows 0 but doesn't crash. This is already the right approach — just needs to be explicit in the frontend spec.

Also: `roundEndsAt` needs to be updated for EACH phase, not just the prompt phase. The plan partially addresses this but the `room` state update timing for `reveal` and `vote` phases needs to be explicit.

---

## 2. What's Ambiguous

### 2.1 Room Capacity Edge Case
The spec says "exactly 6 players (1 human + 5 agents)" but the game should start if there are fewer (e.g., 1 human + 2 agents). The GAME_DESIGN_SPEC says 6 is standard but the implementation plan says `total ≥ 3`.

**Decision needed:** For MVP, minimum is 3 players total (1 human + 2 agents). Ideal is 6. The majority vote threshold (3/5) must scale with player count.

**Fix in game module:** `MIN_VOTE_THRESHOLD = Math.ceil(alivePlayers.length * 0.5)` instead of hardcoded 3.

### 2.2 Human Vote Handling
The spec says "human can vote but it's non-binding / cosmetic." But `castVote()` in the implementation plan stores the human's vote in `votesByRound`. If the threshold check counts all votes, the human's vote could accidentally count toward reaching majority.

**Fix:** In `resolveRound()`, when counting votes, only count votes from `agent` role players. Human vote stored but excluded from tally.

### 2.3 Spectator Join in GTA
The spec says spectators can join via existing `room:watch` pattern, but there's no handler in the GTA socket events for spectators. The existing `room:watch` event in server.js is for the arena mode (roast battle). GTA needs its own spectator join or reuse the existing pattern.

**Fix:** Reuse existing `room:watch` event with `roomId` → join `gta:ROOMID` socket room. Document this.

---

## 3. What's Too Complex for MVP

### 3.1 Bot Vote Heuristic is Over-Engineered
The `pickHumanSuspect()` function with regex scoring is cute but probably over-engineers the MVP. For a first version, bots can just vote randomly (weighted random, avoiding self-votes). This is simpler, more predictable to test, and still creates tension.

**Recommendation:** Use random vote for MVP, add heuristic scoring in v1.5.

### 3.2 The Dual-Emit Pattern is Novel and Risky
The `emitGtaRoom()` dual-emit (broadcast + per-socket) is a new pattern not used in existing game modes. It adds complexity and potential bugs (what if a socket is stale?). 

**Alternative for MVP:** Send role in a SEPARATE event on join only (`gta:role:reveal { role, message }`). The broadcast `gta:state` never includes role. Client keeps `myRole` in memory. This is simpler and safer.

### 3.3 `resolveRound()` as Internal vs External
Having `resolveRound()` be called both from `castVote()` (when all agents vote) AND from `forceAdvance()` creates two entry points into critical logic. If there's a bug where both trigger at the same time (race condition), the game could double-resolve.

**Fix:** Add a `roundResolved` flag to room state. `resolveRound()` checks and sets this flag atomically.

---

## 4. What's Missing Entirely

1. **No README.md for the game module** — agents using OpenClaw need documentation on how to integrate. Add `games/guess-the-agent/README.md`.

2. **No OpenClaw CLI example** — The plan mentions agents connect via `openclaw agentarena join` but doesn't verify this command exists in the current Arena extension. Need to check `extensions/agentarena-connect/index.ts` for the actual CLI interface.

3. **No `games.js` / browse page update** — The existing `public/games.js` or `public/browse.html` may list game modes. GTA needs to be added there too.

4. **No migration for 'gta' in mode validation** — Several places in server.js validate `mode === 'mafia' || 'amongus' || 'villa'`. All of these need 'gta' added, including: `api/play/rooms`, `api/play/lobby/autofill`, `api/play/reconnect-telemetry`, etc.

5. **No error handling for `selectGamePrompts()` failure** — If the prompt bank is empty or corrupted, `startGame()` will crash. Add a fallback.

6. **No content for the `games/guess-the-agent/README.md`** — Should document the game loop for agents using OpenClaw.

---

## 5. Summary of Bugs to Fix Before Building

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | 🔴 | Human self-declaration is exploitable | Host = human in MVP |
| 2 | 🔴 | Double createRoom + joinRoom creates duplicate player | createRoom returns player already |
| 3 | 🔴 | `_forceAgentsWin` undefined | Add public `forceAgentsWin()` |
| 4 | 🔴 | Role security not integration-tested | Add socket-level test |
| 5 | 🟡 | Bot vote timing race condition | Token check + phase guard in forceAdvance |
| 6 | 🟡 | Human vote counts toward threshold | Exclude human votes from tally |
| 7 | 🟡 | Response anonymisation logic missing detail | Define buildPublicResponses() fully |
| 8 | 🟡 | Majority threshold hardcoded at 3/5 | Scale with alive player count |
| 9 | 🟡 | Human reconnect UX missing from frontend | Add reconnecting banner |
| 10 | 🟠 | GTA mode missing from validation checks in server.js | Add 'gta' to all mode validation lists |
| 11 | 🟠 | Double resolveRound risk | Add roundResolved flag |
| 12 | 🟠 | DB winner field type mismatch | Document and handle gracefully |
