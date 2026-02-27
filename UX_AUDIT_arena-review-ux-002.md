# UX Audit — Agent Arena
**Task:** arena-review-ux-002  
**Author:** Donna (subagent)  
**Date:** 2026-02-27  
**Codebase:** `/Users/bobbybola/Desktop/agent-arena`

---

## Executive Summary

Agent Arena has a compelling premise and a solid visual foundation. But the aha moment — **watching AI agents debate, bluff, and vote in real-time** — is completely unreachable for new users via the primary entry point. The game never auto-starts. The user gets redirected to a lobby with no visible way to proceed. Every "Play Now" click ends in a stuck screen.

**Two critical fixes were implemented in this PR:**

1. **Server-side auto-start** (`server.js`): `/api/play/instant` and `/api/play/watch` now start the game before the client arrives. Users land in an active game, not a stuck lobby.
2. **Visible Start Game button** (`games.js`): `renderActions()` now shows a "Start Game" CTA for the host when in the lobby. Dev panel no longer the only path to start.
3. **handleInstantPlay fix** (`games.js`): Wrong event name (`startGame` → `start-ready`) + retry logic.

---

## THE AHA MOMENT

### Definition

> **The aha moment is the first time a user sees an AI agent make a strategic, unpredictable decision in front of them** — specifically: the night elimination announcement followed by the discussion phase, where AI agents begin to argue, bluff, and accuse each other.

This is the emotional core of the product. Everything before it is friction. Everything after it is the hook that creates replay.

For developers connecting their own agent: the aha moment is deeper — it's when **their** agent makes a move. But that's a 60+ second flow. The primary aha is spectator/observer and it's achievable in under 10 seconds if the plumbing works.

### What makes it land
- The phase transition: lobby → night → "PlayerX was eliminated" announcement → discussion
- The first AI message in the discussion phase — seeing an agent actually reason out loud
- The vote drama — seeing tally counts pile up on one player

---

## AHA MOMENT PATH — As Designed vs Reality

### As Designed (3 steps)
```
1. Visit index.html — click "Play Now (15 sec)"
2. API creates room + fills bots, redirect to play.html
3. Game starts → night phase → elimination → discussion → AHA
```

### Actual Path (before this fix)
```
1. Visit index.html — click "Play Now (15 sec)"
2. API creates room + fills bots, redirect to play.html
3. autoJoinFromQuery() joins room — socket connects
4. handleInstantPlay() fires — calls ${mode}:startGame (WRONG EVENT NAME)
   → silent failure, callback never fires, game never starts
5. User sees: Match HUD showing "Lobby", player cards with bots,
   "Waiting for active match..." in the actions area
6. No Start button visible (it's in the hidden dev panel)
7. User cannot proceed
8. User leaves
```

**Steps to aha moment: ∞ (unreachable)**

---

## CRITICAL FINDINGS

### C1 — handleInstantPlay uses wrong event name ⚠️ FIXED

**Location:** `public/games.js` — `handleInstantPlay()` IIFE  
**Severity:** Critical — blocks the entire instant play flow

The function called `emit('${mode}:startGame', ...)`. The actual server event is `${mode}:start-ready` (or `${mode}:start`). `startGame` doesn't exist on the server. The `emit()` fires into the void, the callback never resolves, the game never starts.

Secondary issues:
- Used `emit()` not `emitAck()` — couldn't check the response
- No retry logic — if socket connects slowly, the 2s timeout races with `autoJoinFromQuery()`
- No check that `me.playerId` was set before emitting

**Fix applied:** Replaced `emit(${mode}:startGame)` with `emitAck(${mode}:start-ready)`, added retry loop (up to 12 attempts × 500ms), checks `me.playerId` before emitting, only fires if game is still in lobby.

---

### C2 — Start button hidden on production ⚠️ FIXED

**Location:** `public/play.html` — dev panel (`.dev-panel`)  
**Severity:** Critical — even if C1 were fixed, there's no manual fallback

The Host, Join, Start Ready, and Autofill buttons are all inside `<details class="dev-panel">`. This panel is removed on production unless `?dev=1` is in the URL. So on production, users have zero ability to manually start a game they've created.

**Fix applied:** Added a lobby-state branch to `renderActions()` in `games.js`. When the user is in the lobby as host, `actionsView` now renders:
```
All 4 players ready. You're the host — start when ready.
[Start Game]  ← primary CTA, full-width
```
Non-host lobby players see: "Waiting for the host to start · 4/4 players"

---

### C3 — Game never auto-starts server-side ⚠️ FIXED

**Location:** `server.js` — `/api/play/instant` route  
**Severity:** Critical — the server creates a room and fills it with bots but never starts the game

`/api/play/instant` called `autoFillLobbyBots()` but didn't call `game.startGame()` or `schedulePhase()`. The route relied entirely on the client's `handleInstantPlay()` to start the game via socket. Since that was broken (C1), the game never started.

**Fix applied:** After `autoFillLobbyBots`, now calls `game.startGame(store, { roomId, hostPlayerId })` and the appropriate `schedule*Phase()` function. The game is live and running before the client even arrives. Client just joins and renders the active state.

Same fix applied to `/api/play/watch` — the bot-only spectator game now starts before the watchUrl is returned.

---

## MAJOR FINDINGS

### M1 — Tutorial fires then page navigates (first-time users miss it)

**Location:** `public/games.js` — `instantPlay(mode)` function  
**Severity:** Major

When a user on play.html clicks a game card, `instantPlay(mode)` fires. It calls `showTutorial(mode)` immediately, then makes the API call. The tutorial overlay appears. Milliseconds later, `window.location.href = data.playUrl` redirects to play.html with room params — a full page reload. The tutorial vanishes before the user reads it.

The tutorial is shown **once** (localStorage-gated), so the user who dismissed it by not seeing it will never see it again.

**Recommended fix:** Show the tutorial AFTER the game is active and the first state is rendered. Add a `?tutorial=1` query param to the playUrl from instant play, and trigger the tutorial from `renderState()` on the first successful state render.

---

### M2 — Among Us shows kill buttons to all players (role bleed in UI)

**Location:** `public/games.js` — `renderActions()` Among Us tasks phase  
**Severity:** Major — confusing, exposes intent to human viewers

During the tasks phase, every player sees both "Do task" AND "Imposter kill [name]" buttons, regardless of their actual role. A crew member who clicks "Imposter kill" gets `ROLE_FORBIDDEN` from the server (good), but seeing the kill button implies they have that power.

The root issue: role is hidden in the public state during the game. We can't filter buttons by role without private state.

**Recommended fix:** Track your own role in a private `me.role` var set when joining and receiving your first state update. If `me.role === 'crew'`, hide kill buttons. If `me.role === 'imposter'`, hide the task button. This requires either a private socket event or inferring from hidden state on join.

---

### M3 — No game narrative visible in main UI

**Location:** `public/play.html` / `games.js`  
**Severity:** Major — users can't follow what's happening

The game state object includes `events[]` (last 8 events: NIGHT_ELIMINATION, DAY_EXECUTION, PHASE changes, GAME_FINISHED etc). These are rendered in `stateJson` inside the dev panel — invisible on production.

The main UI shows: player cards, phase timeline, action buttons. But there's no visible feed of "what just happened". A user watching the game has no way to understand the narrative:
- Who was killed last night? (no announcement)
- Why did someone get ejected? (no vote summary)
- What round are we on? (match HUD shows it, but easy to miss)

**Recommended fix:** Add an event log section below the players view. Simple `<ul>` rendering the last 5-8 `state.events[]` items with human-readable labels. E.g.:
```
🔪 Night 1: AgentX was eliminated by the Mafia
💬 Day 1: Discussion phase — 3 agents remain
🗳 Day 1: AgentY was executed (3 votes)
🔪 Night 2: AgentZ was eliminated
🏆 Town wins!
```

---

### M4 — Watch Live lands in a lobby (no live game to actually watch)

**Location:** `server.js` — `/api/play/watch`  
**Severity:** Major (fixed server-side in this PR)

Before the fix, `/api/play/watch` with no active games created a bot room, filled it, and returned a spectate URL — but never started the game. Spectators arrived in a lobby. Now fixed: the bot game starts before the watchUrl is returned.

---

### M5 — Phase timeline has no explanation of current phase

**Location:** `public/games.js` — `renderPhaseTimeline()`  
**Severity:** Major — new users don't know what to do or what's happening

The phase steps show "Night", "Discussion", "Voting", "Finished" with dots, but no context. On first play, users don't know what the night phase means or when the discussion phase starts.

**Recommended fix:** Add a one-line description per phase directly in the timeline:
```
Night       "Mafia chooses who to eliminate"
Discussion  "Debate who you suspect — ready up when done"
Voting      "Vote to execute a suspect"
```

---

### M6 — Rematch auto-countdown starts before users read their result

**Location:** `public/games.js` — `renderOwnerDigest()` → `startRematchCountdown()`  
**Severity:** Major — users accidentally trigger rematches

10 seconds after game ends, `rematchBtn?.click()` fires automatically. The rematch starts while users may still be reading their result card, looking at the leaderboard, or composing a share. The cancel button exists but is easy to miss.

**Recommended fix:** Increase countdown to 20s, or only fire auto-rematch if the user has explicitly signalled they want to play again (e.g. clicked "Rematch" or "New Game" once before). First-time finishers should never get auto-rematched.

---

## MINOR FINDINGS

### N1 — Hero stats show "—" on load (skeleton fix already planned)
Stats display dashes until the API responds. This makes the homepage look broken on slow connections. Fix in ARENA_002_PLAN.md already addresses this.

### N2 — Post-game share link goes to homepage, not match
`shareResult()` generates `${window.location.origin}/?mode=mafia&autojoin=1`. This takes recipients to the homepage — loses the specific game context. Should link to `/match/${matchId}` (the match detail route exists at `GET /match/:matchId`).

**Fix:** Store `matchId` in the game state's post-game result (server needs to write to DB and expose it in state) and use it in the share URL.

### N3 — "Advance" button in match actions with no visible tooltip on mobile
The "Advance" button shows its purpose via `title` attribute (tooltip) — invisible on mobile. Users don't know what it does.

### N4 — Browser back button re-fires autoJoinFromQuery
Pressing back on play.html re-loads the page with the same URL params and re-fires `autoJoinFromQuery()`. Since `attemptedAutoJoin` resets on page load, it tries to re-join. If the room is full (bots took all seats), join fails with a confusing error.

**Fix:** Add a `?joined=1` param after successful join and skip `autoJoinFromQuery` if present.

### N5 — Sign In modal is optional but the flow doesn't explain why
The "Sign In" button in the nav is present but there's no contextual prompt explaining why signing in is valuable (save match history). Users who don't see the value proposition skip it, losing cross-device history.

### N6 — Mobile nav broken (already in ARENA_002_PLAN.md)
`.nav-links { display: none }` at 760px with no hamburger fallback. Already planned.

---

## EDGE CASES

| Scenario | Current Behaviour | Verdict |
|----------|------------------|---------|
| Disconnect mid-game | Reconnect banner + auto-rejoin via socket | ✅ Handled |
| Browser back | Page reload, autoJoin re-fires, may fail with ROOM_FULL | ⚠️ Partial |
| Empty room (no bots) | User in lobby, no one else, game never starts | ✅ Fixed (server-side auto-start) |
| Solo player | instant play fills bots → game starts | ✅ Fixed (server-side auto-start) |
| No rooms for quick match | Homepage shows "No open rooms" error copy | ✅ Handled |
| Backend unreachable | play.html shows "Backend unreachable" banner | ✅ Handled |
| Spectating ended game | Shows "Waiting for active match..." in actions | ⚠️ Should show result instead |
| Villa with <4 players | Game requires 4 — autofill covers this | ✅ OK |
| Roast Battle clicked | Coming Soon badge, button disabled | ✅ OK |

---

## FLOW SCORECARD (all 4 modes)

### Agent Mafia ✅ (after fixes)
- Game state: clear (Night/Discussion/Voting phase labels)
- Turns/timers: phase shown in HUD, no countdown timer visible ⚠️
- Feedback: immediate on action submit
- Who's winning: alive count visible, winner announced in post-game ✅

### Agents Among Us ✅ (after fixes, with M2 caveat)
- Game state: clear (Tasks/Meeting phase)
- Kill buttons shown to all roles ⚠️ (server rejects, but confusing)
- Feedback: immediate
- Who's winning: alive count + tasks done visible

### Agent Villa ✅ (after fixes)
- 6 phases: pairing → challenge → twist → recouple → elimination → finished
- Phase timeline handles all 6 phases correctly
- Immune/vulnerable player context shown in action buttons ✅
- Round/max-rounds visible in HUD ✅

### Roast Battles ⬜ Coming Soon
- No gameplay to review. "Coming Soon" badge in place. OK for launch.

---

## FIXED FILES

| File | Change | Severity |
|------|--------|---------|
| `server.js` | `/api/play/instant`: auto-start game after bot fill | Critical |
| `server.js` | `/api/play/watch`: auto-start bot game before returning watchUrl | Critical |
| `public/games.js` | `handleInstantPlay`: fix event name, use emitAck, add retry | Critical |
| `public/games.js` | `renderActions`: add Start Game CTA for host in lobby | Critical |

---

## RECOMMENDED FOLLOW-UPS (not in this PR)

| Priority | Fix | Effort |
|----------|-----|--------|
| P1 | Game event log in main UI (replace dev-panel-only stateJson) | 2h |
| P1 | Tutorial shown post-game-join, not before redirect | 1h |
| P2 | Phase descriptions in timeline | 30m |
| P2 | Phase countdown timer visible in UI | 2h |
| P2 | Among Us role-filtered action buttons | 1.5h |
| P2 | Post-game share link to /match/:matchId | 30m |
| P3 | Rematch countdown 20s (currently 10s) | 15m |
| P3 | Browser back button handling (?joined=1 param) | 1h |

---

## TEST STATUS
All fixes are additive/corrective. Existing server behaviour (socket events, game logic) unchanged. See PR for test run results.
