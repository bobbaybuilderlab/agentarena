# Code Review — Agent Arena (2026-03-01)

Comprehensive review of backend (server.js, db, 4 game modules) and frontend (games.js, guess-the-agent, HTML/CSS). Going to production.

---

## 🔴 Critical (fix before launch)

### C1 — Double `loadState()` duplicates roast feed + votes on every restart
**File:** `server.js:3148` and `server.js:3548`

`loadState()` is called at module scope AND inside the `require.main` block. It pushes to `roastFeed` and adds to `votes` without clearing first. Every server restart doubles the data in memory.

**Fix:** Guard with idempotency flag, or remove the module-scope call at line 3148.

---

### C2 — CORS bypass: all origins get credentialed access when `ALLOWED_ORIGINS` is empty
**File:** `server.js:1698-1710`

The manual CORS middleware checks `!allowedOrigins.length || allowedOrigins.includes(origin)`. When `ALLOWED_ORIGINS` is empty (default), every origin passes. This bypasses the Socket.IO CORS config.

**Fix:** Use `effectiveOrigins` consistently:
```js
if (effectiveOrigins.includes(origin)) {
  res.setHeader('Access-Control-Allow-Origin', origin);
}
```

---

### C3 — `castVote` not callable from inline onclick in strict mode — voting is broken
**File:** `guess-the-agent.js:179` (defines `castVote`), `guess-the-agent.js:363` (calls it via `onclick`)

`castVote` is a local function, not on `window`. Inline `onclick="castVote('...')"` looks up `window.castVote` which doesn't exist in strict mode. **GTA voting is completely broken.**

**Fix:** Either `window.castVote = function(targetId) {...}` or switch to event delegation with `data-` attributes.

---

### C4 — Duplicate `/health` route — second handler never executes
**File:** `server.js:1998-2026` and `server.js:3466-3489`

Two `app.get('/health', ...)` registered. Express matches the first (basic DB check). The second (room counts, scheduler stats, canary info) is dead code. If ops monitoring depends on the richer one, it's silently broken.

**Fix:** Merge into a single handler.

---

### C5 — XSS via `innerHTML` in index.html ticker
**File:** `index.html:208`

```js
track.innerHTML = content; // content built from API response data (r.mode, r.players)
```

API response data injected into DOM with no escaping.

**Fix:** Use `document.createElement('span')` + `textContent` instead.

---

### C6 — XSS: leaderboard agent names injected unescaped
**File:** `games.js:865-866`

```js
<span class="lb-mini-name">${agent.name}</span>
```

`agent.name` from `/api/leaderboard` is inserted via `innerHTML` without `escapeHtml()`. Stored XSS if an attacker registers a malicious agent name.

**Fix:** `${escapeHtml(agent.name)}`

---

### C7 — XSS: recent matches player_name unescaped
**File:** `games.js:1544-1558`

`m.player_name` and `m.role` from server inserted into `innerHTML` without escaping.

**Fix:** `${escapeHtml(m.player_name || '')}`, `${escapeHtml(m.role || '')}`

---

### C8 — XSS: player ID injected into onclick attribute unescaped
**File:** `guess-the-agent.js:363`

```js
onclick="castVote('${p.id}')"
```

If `p.id` contains `'); alert('xss`, it executes. Use event delegation instead.

---

### C9 — Room stores grow unbounded in all game modules — memory leak / eventual OOM
**Files:** `games/agent-mafia/index.js:8`, `games/agents-among-us/index.js:8`, `games/agent-villa/index.js:8`, `games/guess-the-agent/index.js:10-13`

Every `createRoom` adds to the Map; nothing ever removes entries. No TTL, no eviction. Server will eventually exhaust memory.

**Fix:** Add TTL sweep (e.g., 2-hour expiry) or export `deleteRoom` and call from `cleanupStaleRooms`.

---

### C10 — Biased shuffle in role assignment (mafia + among-us)
**Files:** `games/agent-mafia/index.js:202`, `games/agents-among-us/index.js:207`

`[...arr].sort(() => Math.random() - 0.5)` is not a uniform shuffle. Elements near the start are biased to stay near the start, affecting which players get mafia/imposter roles.

**Fix:** Replace with Fisher-Yates:
```js
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
```

---

## 🟡 High (fix this week)

### H1 — No socket authentication — any client can interact with any game
**File:** `server.js:934-937`

Socket middleware only sets a correlation ID. No token/session validation. A malicious client can connect, guess a room ID, and act on behalf of any player.

**Fix:** Validate session token from `socket.handshake.auth`.

---

### H2 — `quick-join` and `instant-play` missing `gta` mode — will crash or route to wrong game
**Files:** `server.js:3110-3114`, `server.js:3181-3182`

The ternary chains for `targetStore`/`store`/`game` don't include `gta`. Falls through to `villaRooms` or `mafiaRooms`.

**Fix:** Add `gta` to the ternary chains in both endpoints.

---

### H3 — `gta:room:create` and other GTA handlers crash on null payload
**File:** `server.js:1319`

`socket.on('gta:room:create', ({ name }, cb) => {` — if client sends null, destructuring throws. Other game modes use `const { name } = payload || {};`.

**Fix:** `socket.on('gta:room:create', (payload, cb) => { const { name } = payload || {};`

---

### H4 — Five unbounded in-memory Maps/Sets leak permanently
**File:** `server.js` — `votes` (Set, line 1757), `agentProfiles` (Map, 1878), `completedMatchRooms` (Set, 1762), `playRoomTelemetry` (Map, 93), `connectSessions` (Map, 1761), `sessions` (Map, 1760)

None of these are ever cleaned up. They grow forever.

**Fix:** Add periodic eviction to each, or move to DB-backed storage.

---

### H5 — Synchronous `fs.writeFileSync` on every page visit
**File:** `server.js:1784`

`incrementGrowthMetric` calls `writeFileSync` on every invocation including page visits. Blocks the event loop.

**Fix:** Debounce writes (e.g., flush every 5 seconds if dirty).

---

### H6 — `setStatus` null dereference crashes the page
**File:** `games.js:267-274`

```js
if (playStatus) playStatus.style.display = 'block';
playStatus.textContent = text; // crashes if playStatus is null
```

**Fix:** `if (!playStatus) return;` at the top.

---

### H7 — `hasVoted` resets on every render — allows double-voting
**File:** `guess-the-agent.js:335`

`renderVote` is called on every state update. It resets `hasVoted = false` each time, defeating the double-vote guard.

**Fix:** Track voted state per round: only reset when `state.round` changes.

---

### H8 — Reconnect logic broken — `myRoomId` is always null on page refresh
**File:** `guess-the-agent.js:31-40`

`myRoomId` is not persisted. On refresh, the `saved && myRoomId` check always fails.

**Fix:** Use `data.roomId` from sessionStorage instead.

---

### H9 — `copyRoomLink` uses implicit `event` global — breaks in Firefox
**File:** `guess-the-agent.js:152`

`const btn = event.target` — Firefox doesn't have `window.event`. The "Copied!" feedback never shows.

**Fix:** Accept event as parameter: `window.copyRoomLink = function(e) { const btn = e.target; }`

---

### H10 — Hardcoded Railway URL for socket.io client in play.html
**File:** `play.html:300`

```html
<script src="https://agent-arena-production-2d75.up.railway.app/socket.io/socket.io.js"></script>
```

If Railway deploys to a different domain or someone runs locally, the play page is completely broken.

**Fix:** Use CDN: `<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>`

---

### H11 — Missing GTA win condition: human survives when all agents eliminated
**File:** `games/guess-the-agent/index.js:253-296`

`resolveRound` checks if the human was eliminated, but never checks if all agents are dead. If agents vote each other out, the game is stuck with no alive agents.

**Fix:** After elimination, check `if (aliveAgents.length === 0) return finish(room, 'human');`

---

### H12 — Vote ties decided by lexicographic ID sort — deterministic unfairness
**Files:** `games/agent-mafia/index.js:302`, `games/agents-among-us/index.js:300`, `games/agent-villa/index.js:335`

Tied votes always eliminate the player whose UUID sorts first alphabetically. Same player loses every tie all game.

**Fix:** Break ties randomly, or skip elimination on a true tie.

---

### H13 — Self-vote allowed in agents-among-us meetings (inconsistent with mafia/villa)
**File:** `games/agents-among-us/index.js:263-273`

No `target.id === actor.id` check. Players can vote to eject themselves. Mafia and villa both prevent this.

**Fix:** Add `if (target.id === actor.id) return { ok: false, error: { code: 'INVALID_TARGET' } };`

---

### H14 — Events array grows unbounded in all game modules
**Files:** All 4 game modules — `room.events.push(...)` never capped.

`toPublic` only sends the last 8-16 events, but the server array grows forever. Accumulates across rematches.

**Fix:** `if (room.events.length > 100) room.events = room.events.slice(-50);`

---

### H15 — `onAny` rate limiter doesn't actually prevent handler execution
**File:** `server.js:964-985`

`onAny` is a listener, not middleware. Rate-limited events still execute. The rate limiter is partially ineffective.

**Fix:** Use `socket.use()` middleware instead:
```js
socket.use(([event, ...args], next) => {
  if (!checkSocketRateLimit(socket.id)) return next(new Error('rate limited'));
  next();
});
```

---

### H16 — Role modal has no ARIA attributes, no focus trap, no Escape key dismiss
**File:** `guess-the-agent.html:126`

Modal is a plain `<div>` with no `role="dialog"`, `aria-modal="true"`, or keyboard handling. Users can be permanently stuck if the button is off-screen on mobile.

**Fix:** Add ARIA attributes, Escape key handler, and focus trap.

---

### H17 — Reveal overlay has no accessibility attributes or focus management
**File:** `guess-the-agent.html:216`

Same issue as H16. Full-screen overlay with no ARIA.

---

### H18 — Disconnect handler iterates ALL rooms across ALL game modes per disconnect
**File:** `server.js:1615-1680`

O(N) scan of 5 room stores on every socket disconnect. No early break.

**Fix:** Maintain a reverse map `socketId -> { mode, roomId }` for O(1) lookup.

---

### H19 — Missing `createdAt` on agents-among-us room object
**File:** `games/agents-among-us/index.js:101-114`

Mafia and villa include `createdAt: Date.now()`. Among-us does not. Breaks any room-cleanup or monitoring logic.

**Fix:** Add `createdAt: Date.now()` to the room object.

---

### H20 — `callMeeting` has no phase guard in agents-among-us
**File:** `games/agents-among-us/index.js:254-261`

Players can attempt to call a meeting during any phase, not just `tasks`.

**Fix:** `if (room.phase !== 'tasks') return { ok: false, error: { code: 'WRONG_PHASE' } };`

---

### H21 — Ops endpoints called without authentication from frontend
**File:** `games.js:1253-1262`

`/api/ops/events/flush`, `/api/evals/run`, `/api/evals/ci` called with no auth token. If server-side auth is also missing, any user can flush events or trigger evals.

**Fix:** Require admin auth on these endpoints.

---

### H22 — 3-second ops polling for every client unconditionally
**File:** `games.js:1361-1363`

Two HTTP requests every 3 seconds from every connected client, regardless of debug panel visibility or tab activity.

**Fix:** Only poll when `?debug=1` is set, pause when tab is hidden.

---

### H23 — Full DOM rebuild on every state update (render thrashing)
**File:** `games.js:658-680, 888-1031`

Every `renderState` call reconstructs `innerHTML` from scratch. Destroys scroll position, focus state, and causes layout thrashing.

**Fix:** Skip re-render if state hasn't changed, or diff/patch only changed elements.

---

### H24 — Villa autoplay overrides human player's action
**File:** `server.js:665-683`

Bot autoplay force-submits a deterministic action for a human player who hasn't acted yet. Strips player agency. `forceAdvance` already handles phase deadlines.

**Fix:** Remove this block. Let `forceAdvance` handle deadline-based fallbacks.

---

### H25 — `finish()` bypasses GTA state machine
**File:** `games/guess-the-agent/index.js:299-305`

Sets `room.phase = 'finished'` directly instead of going through `transition()`. Skips validation.

**Fix:** Add `vote -> finished` to `VALID_TRANSITIONS` and route through `transition()`.

---

### H26 — DB input validation: `upgradeUser` accepts arbitrary-length strings
**File:** `server/db/index.js:58-71`

No validation on `email`, `displayName`, `agentId`. A caller can write a 10MB string.

**Fix:** Validate type and length before SQL insertion.

---

### H27 — No enum validation on `updateReportStatus`
**File:** `server/db/index.js:195`

Any arbitrary string can be written as a report status. If the ops dashboard renders it unsanitized, it becomes stored XSS.

**Fix:** Validate against `['pending', 'reviewed', 'dismissed']`.

---

### H28 — GTA nav is stripped down — no way to navigate to other pages
**File:** `guess-the-agent.html:114-117`

No hamburger, no nav links, no mobile drawer. Missing the sword emoji. Page feels disconnected from the rest of the site.

**Fix:** Add standard nav or at minimum a "Back" link.

---

### H29 — GTA disconnected player lookup uses stale socket ID
**File:** `server.js:1653-1654`

After `gtaGame.disconnectPlayer` runs, `room.players.find(p => p.socketId === socket.id)` may fail because socketId was cleared. Abandon timer never starts; game hangs forever.

**Fix:** Find the human player before calling `disconnectPlayer`.

---

---

## 🟢 Low / Polish

### L1 — `Math.random() - 0.5` biased shuffle used in server.js (4 locations)
`server.js:192, 1470, 1606, 1984` — Replace with Fisher-Yates.

### L2 — `startReadyLobby`, `createQuickJoinRoom`, `getClaimableLobbySeats` don't handle `gta` mode
`server.js:2682, 2768, 2863` — Falls through to mafia. Add GTA handling.

### L3 — `shortId` collision risk with no dedup check
All game modules + `server.js` — 6-char hex has only ~16M possibilities. Check for collisions.

### L4 — `prepareRematch` doesn't remove disconnected players
All 3 game modules — Rematch includes disconnected player slots that can never act.

### L5 — `advanceRoundPhase` is dead alias in agent-villa
`games/agent-villa/index.js:547-549` — Just `return forceAdvance(...)`. Remove or consolidate.

### L6 — `resolveCouples` has unreachable condition in agent-villa
`games/agent-villa/index.js:296` — `assigned.has(partner.id)` check is always false. Dead code.

### L7 — `toPublic` exposes per-player `tasksDone` to imposter in agents-among-us
`games/agents-among-us/index.js:76` — In standard Among Us, task progress is a global bar, not per-player.

### L8 — `persistState` writes entire state synchronously on every vote/roast
`server.js:1866, 1956, 2246, 2298` — Debounce or batch writes.

### L9 — `cleanupStaleRooms` doesn't clear associated scheduler timers
`server.js:3505-3535` — Timer references persist until they fire.

### L10 — `SIGTERM` handler exits without draining connections
`server.js:3564-3567` — Call `server.close()` first with a 10s force-exit timeout.

### L11 — `buildRoomMatchQuality` returns score as string
`server.js:2561` — `.toFixed(2)` returns string. Wrap with `Number()`.

### L12 — Duplicate `getMatchesByUser` / `getPlayerMatches` in DB module
`server/db/index.js:128-162` — Near-identical queries. Consolidate.

### L13 — No upper bound on `limit` parameter in DB queries
`server/db/index.js:128, 141` — `limit = 999999999` dumps the table. Cap at 100.

### L14 — `disconnectPlayer` ignores spectators in GTA
`games/guess-the-agent/index.js:435-442` — Disconnected spectators stay in Set forever.

### L15 — `prepareRematch` doesn't clear events array in GTA
`games/guess-the-agent/index.js:375-403` — Events accumulate across rematches.

### L16 — `isSpectating()` re-parses URL params on every call
`games.js:487-490` — Cache the result.

### L17 — `stat-skeleton` class referenced in JS but no CSS
`index.html:183` — Skeleton loading state is invisible. Add CSS animation.

### L18 — "Coming Soon" badge has no defined CSS
`play.html:98` — `.coming-soon-badge` class renders as unstyled text.

### L19 — Roast Battle card uses `<div>` while siblings use `<article>`
`play.html:94` — Semantic inconsistency; `article` styles won't apply.

### L20 — GTA page uses inline styles instead of design system
`guess-the-agent.html:135+` — Heavy inline styles duplicate what `styles.css` provides.

### L21 — Nav hamburger never toggles `aria-expanded`
JS toggles `nav-mobile-open` class but never updates `aria-expanded` attribute.

### L22 — GTA vote buttons all say "Vote" with no accessible label for target
`guess-the-agent.js:363` — Screen readers hear "Vote, Vote, Vote, Vote."

### L23 — Timer countdown not announced to screen readers
`guess-the-agent.html:171, 186, 197` — No `aria-live` region on timer.

### L24 — Textarea not cleared between GTA rounds
`guess-the-agent.js:289-313` — Previous answer persists in the input.

### L25 — Massive code duplication across socket handlers for 4 game modes
`server.js:986-1406` — ~80 lines of copy-paste per mode. Extract a generic handler factory.

### L26 — GTA page doesn't load `nav.js`
`guess-the-agent.html` — If hamburger nav is added later, it won't work without the script.

---

## ✅ What's working well

### Architecture
- **Clean game module separation** — Each game (mafia, among-us, villa, GTA) is its own module with consistent exports (`createStore`, `createRoom`, `joinRoom`, `submitAction`, `forceAdvance`, `toPublic`). This makes it easy to add new games.
- **State machine pattern in GTA** — `VALID_TRANSITIONS` map with explicit `transition()` function is solid. Other modules use `PHASE_TRANSITIONS` similarly. This prevents impossible state jumps.
- **Room scheduler abstraction** — Centralized timer management for phase deadlines is clean and avoids scattered `setTimeout` calls.

### Security (what exists)
- **`escapeHtml` exists and is used** in most places in `games.js`. The XSS issues are gaps in coverage, not a total absence of awareness.
- **`socketOwnsPlayer` guard** on game actions prevents cross-player impersonation within a room.
- **Rate limiting exists** (even if `onAny` is the wrong hook, the intent is there).
- **Parameterized SQL queries** in `server/db/index.js` — no raw string interpolation of values into SQL.

### Frontend
- **Design system is cohesive** — `styles.css` has a well-structured token system (`--bg-0` through `--bg-3`, `--accent`, `--danger`, etc.), responsive breakpoints, and consistent utility classes.
- **Reconnect handling exists** — Both `games.js` and `guess-the-agent.js` have reconnect banners, session recovery attempts, and socket reconnect logic.
- **`toPublic` data filtering** — All game modules strip sensitive data (roles, agent identities) before sending state to clients. The human player only sees what they should see.
- **Growth metrics / telemetry** — The ops dashboard, event tracking, and canary system show production-readiness thinking.

### Game Design
- **Bot autoplay system** — Bots can fill rooms and play autonomously, enabling single-player testing and reducing wait times. The phase-based autoplay with randomized delays is realistic.
- **Rematch / party streak** — The rematch system with `partyStreak` tracking encourages replay without requiring lobby re-creation.
- **Spectator mode** — Clean separation between player and spectator views.

---

*Review by Claude Opus 4.6 — 2026-03-01*
*10 critical, 29 high, 26 low findings across ~6,000 lines of backend + frontend code.*
