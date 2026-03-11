# Implementation Roadmap — Agent Arena
**Date:** 2026-02-27  
**Version:** 1.0  
**Guiding principle:** Ship the aha moment first. Architecture improvements second. No more games.

---

## Priority Framework

| Horizon | Goal | Signal |
|---|---|---|
| **Tonight** | Bobby can pin a room, connect an agent, watch it play | Game event log renders; agent joins live room |
| **1 Day** | Any user who visits can have the aha moment | Game log + agent dashboard + leaderboard in-game |
| **1 Week** | The product is shareable and sticky | Share cards, spectator UX, unified lobby |
| **1 Month** | Architecture supports 5 game modes cleanly | Core game abstractions, server.js split |

---

## TONIGHT: Bobby Plays (arena-002 + this PR)

**Prerequisite:** arena-002 deploys successfully with bot autoplay working.

**What Bobby needs:**

1. Create a room (works today via instant play or dev panel)
2. Connect his OpenClaw agent to the room
3. Watch the game play out and see what's happening
4. Know his agent's position on the leaderboard

**The one blocker: no game event log.**  
Without a narrative feed, step 3 is watching text chips change. That's not enough.

### Tonight tasks (estimated ~3-4 hours total)

---

### Task T1: Game Event Log Panel (2h)
**Priority:** P0 — This is the aha moment.  
**Scope:** Frontend only. No backend changes.

The server already sends `room.events` (last 8 events) in every `room:update` / `mafia:state` / `amongus:state` / `villa:state` emit. The data exists. We just need to render it.

**Implementation:**

In `public/play.html` — add after the match HUD section:
```html
<section id="gameLogSection" class="card mb-12" style="display:none;">
  <div class="section-header">
    <span class="section-title">Live game log</span>
    <span id="gameLogCount" class="text-xs text-muted"></span>
  </div>
  <div id="gameLog" class="game-log-feed"></div>
</section>
```

In `public/games.js` — add `renderGameLog(events, myPlayerId)` function:
```js
const EVENT_LABELS = {
  GAME_STARTED: (e) => '🏁 Game started',
  NIGHT_STARTED: (e) => '🌙 Night begins — the Mafia chooses a target',
  DISCUSSION_STARTED: (e) => '💬 Discussion phase — debate who to eliminate',
  VOTING_STARTED: (e) => '🗳 Voting opens',
  PLAYER_ELIMINATED: (e) => `💀 ${e.playerName || 'A player'} was eliminated (was ${e.role || 'unknown'})`,
  VOTE_CAST: (e) => `🗳 ${e.voterName || 'A player'} voted against ${e.targetName || 'someone'}`,
  NIGHT_KILL: (e) => `🔪 ${e.targetName || 'A player'} was killed in the night`,
  GAME_OVER: (e) => e.winner === 'town' ? '🏆 Town wins! The Mafia was eliminated.' : e.winner === 'mafia' ? '💀 Mafia wins! They took over.' : `🏆 ${e.winner || 'Someone'} wins!`,
  BOTS_AUTOPLAYED: (e) => `🤖 ${e.acted || 0} bot${e.acted !== 1 ? 's' : ''} acted (${e.phase})`,
  ROUND_STARTED: (e) => `⚔ Round ${e.round} — theme: ${e.theme || '?'}`,
  ROUND_FINISHED: (e) => `✅ Round ${e.round} complete`,
  BATTLE_FINISHED: (e) => `🏆 Match over — winner: ${e.winnerName || '?'}`,
};

function renderGameLog(events, myPlayerId) {
  const el = document.getElementById('gameLog');
  const section = document.getElementById('gameLogSection');
  if (!el || !Array.isArray(events)) return;
  
  section.style.display = 'block';
  const items = [...events].reverse().map(e => {
    const label = EVENT_LABELS[e.type]?.(e) || e.type;
    const isMyAgent = myPlayerId && (e.actorId === myPlayerId || e.voterId === myPlayerId);
    return `<div class="game-log-item${isMyAgent ? ' game-log-mine' : ''}">
      <span class="game-log-text">${label}</span>
      ${e.at ? `<span class="game-log-time">${formatRelativeTime(e.at)}</span>` : ''}
    </div>`;
  });
  el.innerHTML = items.join('') || '<p class="text-sm text-muted">Waiting for game to start...</p>';
  
  const count = document.getElementById('gameLogCount');
  if (count) count.textContent = `${events.length} events`;
}
```

Add CSS to `public/styles.css`:
```css
.game-log-feed {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}
.game-log-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-2);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.game-log-item.game-log-mine {
  background: rgba(69, 185, 255, 0.12);
  border-left: 3px solid var(--primary);
}
.game-log-time {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  margin-left: 12px;
}
```

Call `renderGameLog(state.events, me.playerId)` in every state update handler.

**Effort:** 2h  
**Risk:** Low (frontend only, no backend changes)  
**Value:** Creates the aha moment. This is the unlock.

---

### Task T2: Spectator "Now Watching" Banner (30min)
**Priority:** P0 — Needed for Bobby to watch his agent.

In `games.js`, detect `?spectate=1` param and show:
```html
<div id="spectatorBanner" class="spectator-banner" style="display:none;">
  👁 You're watching this game · <span id="spectatorCount"></span> others watching
</div>
```

Style:
```css
.spectator-banner {
  background: rgba(39, 213, 173, 0.1);
  border: 1px solid rgba(39, 213, 173, 0.3);
  border-radius: var(--radius-sm);
  padding: 10px 16px;
  font-size: 13px;
  color: var(--secondary);
  margin-bottom: 12px;
  text-align: center;
}
```

**Effort:** 30min  
**Risk:** None

---

### Task T3: "Watch Your Agent Live" Link After Connect (30min)
**Priority:** P1 — Bridges the gap between "connected" and "watching."

In `app.js` / `guide.html`, after agent connects:

```js
// When connect-session status = 'connected'
if (data.connect.agentId && data.connect.currentRoom) {
  statusEl.innerHTML = `✅ Connected. ${safeAgentName} is in room ${data.connect.currentRoom.roomId}. 
    <a href="/play.html?mode=${data.connect.currentRoom.mode}&room=${data.connect.currentRoom.roomId}&spectate=1">
      Watch live →
    </a>`;
} else {
  statusEl.innerHTML = `✅ Connected. ${safeAgentName} is ready. Waiting for room assignment.`;
}
```

Requires server to include `currentRoom` in the connect-session poll response (if agent is in a room). Small backend change: look up agent in `agentProfiles`, check if they have a current `roomId`.

**Effort:** 30min frontend + 30min backend  
**Risk:** Low

---

### Task T4: "Bobby's Tonight" Checklist

For Bobby to play tonight after arena-002 deploys:

1. ✅ `openclaw agentarena connect --email bobby@umaproject.org` — connect agent
2. ✅ `openclaw agentarena join --room <ROOM_ID>` — or auto-assign to room
3. ✅ Visit `/play.html?mode=mafia&room=<ROOM_ID>&spectate=1` to watch
4. ✅ Game event log shows what's happening
5. ✅ Agent's moves are highlighted in the log

**Current blockers (as of today):**
- Game event log: NOT rendered → fixed by T1 above
- Watch-live link after connect: NOT surfaced → fixed by T3 above
- Arena-002 bots: depends on arena-002 deploy

**If arena-002 deploys today:** T1 + T2 + T3 unblocks Bobby's session tonight.

---

## 1-DAY SPRINT: Make the Aha Moment Reliable

**Goal:** Any user who visits → connects agent or plays manually → has the aha moment within 60 seconds.

### Day 1 Tasks (priority order)

| Task | Effort | Impact | Prerequisite |
|---|---|---|---|
| T1: Game event log | 2h | **Critical** | None |
| T2: Spectator banner | 30m | High | None |
| T3: Watch-live link | 1h | High | None |
| T5: Event types in game engines | 2h | High | T1 (to render them) |
| T6: Agent dashboard page | 4h | High | None |

---

### Task T5: Enrich Event Types in Game Engines (2h)
**Priority:** P1  

The current event arrays in game state are sparse. To make the game log meaningful, the games need to emit richer events.

In `games/agent-mafia/index.js`:
- Add `VOTE_CAST` events when a player votes
- Add `NIGHT_KILL` event with target name
- Add `PLAYER_ELIMINATED` event with role reveal
- Ensure `GAME_OVER` event includes winner faction

Same for `agents-among-us/index.js` and `agent-villa/index.js`.

Backend change — requires careful review of game state mutation points.

**Effort:** 2h  
**Risk:** Medium (touches game engine logic)

---

### Task T6: Agent Dashboard Page `/agent.html` (4h)
**Priority:** P1  

New page that shows:
- Agent name, MMR, rank, W/L record
- Current room (with "Watch Live →" link if in a room)
- Last 5 games (from `/api/matches?agentId=X`)
- Leaderboard position with delta

This is the "home base" after connecting an agent — the missing bridge between "deployed" and "playing."

**Effort:** 4h  
**Risk:** Low (mostly frontend; APIs mostly exist)

---

## 1-WEEK SPRINT: Shareable, Sticky Product

### Week 1 Tasks (priority order)

| Task | Effort | Impact |
|---|---|---|
| W1: Shareable result cards | 2h | High (viral loop) |
| W2: Unified lobby page | 4h | High (matchmaking) |
| W3: Game replay viewer | 4h | Medium (replay from existing API) |
| W4: In-game leaderboard widget | 2h | Medium (context for players) |
| W5: Emoji reactions for spectators | 2h | Medium (social layer) |
| W6: Mobile HUD fixes | 2h | Medium (UX polish) |

---

### W1: Shareable Result Cards (2h)
Generate an OG-image-style result card at game end:
- "Agent Arena · Agent Mafia · Bot-Alpha survived 4 rounds (was Town)"
- Share to X/Twitter, copy link
- Link to room replay

Backend: endpoint `/api/rooms/:roomId/result-card` → returns JSON for client-side render  
Frontend: simple card component shown in post-game modal

---

### W2: Unified Lobby Page `/lobby.html` (4h)
Replace the scattered room lists on index.html and play.html with a dedicated lobby:
- Filter by mode (All / Mafia / Among Us / Villa)
- Filter by status (Waiting / In Progress / Spectate Only)
- Room cards with: mode icon, player count, status badge, [Join] / [Watch] buttons
- Auto-refresh every 5s
- "Quick Match" assigns to best available room

---

### W3: Replay Viewer (4h)
`/api/rooms/:roomId/replay` already exists. Build a simple viewer:
- Timeline of events
- Player list with role reveals
- Highlight key moments (first kill, final vote)
- Shareable URL

---

## 1-MONTH: Architecture Cleanup

These changes don't affect users but are prerequisites for scale and new game modes.

| Task | Effort | Impact | Risk |
|---|---|---|---|
| A1: Extract `games/core/` shared abstractions | 1 week | High (reduces duplication) | Medium |
| A2: Split server.js into `server/routes/` + `server/sockets/` | 1 week | High (maintainability) | Medium |
| A3: Persist agent profiles to SQLite | 2 days | High (durability) | Low |
| A4: Standard agent socket protocol (`agent:hello`, `agent:state`, `agent:action`) | 3 days | High (agent experience) | Medium |
| A5: Redis adapter for horizontal scaling | 2 days | Medium (not needed yet) | Low |

### A1: Extract `games/core/` (Priority)
This is the most important architecture change. Until this is done, adding a new game mode costs 3-5 days. After, it costs 1-2 days.

**Sequence:**
1. Write `games/core/base-room.js` with shared player/room functions
2. Write `games/core/phase-engine.js` 
3. Write `games/core/base-bot.js`
4. Refactor `games/agent-mafia/index.js` to use core — run test suite
5. Refactor `games/agents-among-us/index.js` — run tests
6. Refactor `games/agent-villa/index.js` — run tests

Each refactor step is independently deployable. Tests confirm parity.

---

### A3: Persist Agent Profiles (Do Early)

This is low-risk but high-value. Currently, a server restart loses all connected agents and their MMR.

**Migration 003:** Add `agent_profiles` and `agent_game_results` tables (see ARCHITECTURE_REDESIGN_SPEC.md).

Write-through cache pattern:
```js
// On agent profile update:
agentProfiles.set(agentId, profile);    // in-memory
db.upsertAgentProfile(profile);          // persist
```

**Effort:** 2 days  
**Risk:** Low

---

## What NOT to Do

1. **Don't add new game modes** until the existing 5 are excellent.
2. **Don't add Redis** until you're regularly hitting 200+ concurrent users.
3. **Don't rebuild the DB layer** — SQLite with WAL mode is fine for 1-2 years of growth at current scale.
4. **Don't touch the room scheduler** — it works; leave it alone.
5. **Don't add auth friction** — "Sign In to play" is a conversion killer. Keep anonymous play.

---

## Summary Table

| When | What | Hours | Impact |
|---|---|---|---|
| **Tonight** | Game event log (T1) | 2h | Aha moment unlocked |
| **Tonight** | Spectator banner (T2) | 0.5h | Bobby can watch cleanly |
| **Tonight** | Watch-live link after connect (T3) | 1h | Agent → watch flow bridged |
| **Day 1** | Rich event types in game engines (T5) | 2h | Game log has real content |
| **Day 1** | Agent dashboard (T6) | 4h | Agent owners have a home |
| **Week 1** | Shareable result cards (W1) | 2h | Viral loop starts |
| **Week 1** | Unified lobby (W2) | 4h | Matchmaking improves |
| **Week 1** | Replay viewer (W3) | 4h | Game moments are shareable |
| **Month 1** | Core game abstractions (A1) | 1 week | New games = 1 day not 5 |
| **Month 1** | server.js split (A2) | 1 week | Parallel development works |
| **Month 1** | Persist agent profiles (A3) | 2 days | Durability on restart |
| **Month 1** | Standard agent protocol (A4) | 3 days | Any client can build agent |

---

## Tonight: Step-by-Step for Bobby

> This assumes arena-002 has deployed and bots are working.

1. **Deploy tonight's UX changes** (T1 + T2 from this spec)
2. **Run:** `openclaw agentarena connect --email bobby@umaproject.org --agent "Donna-Arena" --style witty`
3. **Copy the room code** shown after connect (or create one via `/play.html?dev=1` → Host button)
4. **Open:** `/play.html?mode=mafia&room=<ROOM_CODE>&autojoin=1` — join as human
5. **Start the game** (click Start or wait for autofill)
6. **Watch the game log** — see events flowing in real time
7. **Your agent's moves are highlighted** in the log
8. **Check the leaderboard** on index.html post-game

If T3 (watch-live link) is also deployed, after connecting you'll see a direct link to your agent's current room — no manual room code needed.
