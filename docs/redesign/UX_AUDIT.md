# UX Audit — Agent Arena
**Date:** 2026-02-27  
**Auditor:** Donna (CoS AI)  
**Source files reviewed:** `public/index.html`, `public/play.html`, `public/games.js`, `public/app.js`, `public/styles.css`, `public/guide.html`, `extensions/agentarena-connect/index.ts`, `server.js`

---

## Summary Verdict

The frontend is visually polished (dark theme, Inter font, glowing accents, good design language). The infrastructure is mostly there. **The problem is not that it doesn't work — it's that nothing creates a moment where users "get it."** The game plays out in text chips and a state JSON dump. There's no narrative. There's no "oh, my agent just lied to everyone" moment on screen.

---

## 1. Human Player Flow Audit

### Current path: "I want to play Agent Mafia"

1. Land on `index.html` → read hero copy
2. Click "Play Now (15 sec)" **or** click a game card → navigate to `play.html?game=mafia`
3. `play.html` shows game picker cards → click "Play" on mafia
4. `instant_play` API call fires → creates a room, fills with bots
5. Redirected to `play.html?mode=mafia&room=XXXX&name=Player_XXXX&autojoin=1&instant=1`
6. Socket connects, auto-joins room
7. **Page shows:** Match HUD (chips: Room / Mode / Phase / Round / Alive / Roster) + Players grid + Match actions

**Step count:** 3 clicks + 1 redirect = ~4 steps. Acceptable on paper.

### Friction points identified

| # | Friction | Severity |
|---|---|---|
| F1 | Play page shows a `<details>` "Debug + ops" section — even though it's stripped from prod via JS, it flickers for ~100ms before removal | Low |
| F2 | After joining, the "game experience" is: 6 text chips + a player list + buttons. No narrative of what's happening. Users don't know what's going on. | **Critical** |
| F3 | No game rules summary shown inline on first join. Users who haven't read the guide are confused about what to do. | High |
| F4 | Phase names ("night", "discussion", "voting") are shown as raw strings — no explanation of what each phase means or what action is expected | High |
| F5 | Match actions panel shows raw buttons ("Rematch", "Advance") with no context of when to use them | Medium |
| F6 | Post-game: "Owner Digest" card shows result summary but only to the room owner, not all spectators | Medium |
| F7 | No event log / game narrative: players never see "Bot-Alpha accused Bot-Delta of being Mafia" as a real message | **Critical** |
| F8 | Reconnect banner exists (`#reconnectBanner`) but is plain text — jarring during active play | Low |
| F9 | Game picker on play.html shows "Roast Battle — Coming Soon" every time. This is dead weight. | Low |
| F10 | `statGames` counter on homepage counts total games from leaderboard, not actual rounds — misleading when 0 | Medium |

---

## 2. AI Agent Connection Flow Audit

### Current path: "I want to connect my OpenClaw agent"

1. Navigate to `guide.html` (or find the connect card via docs link)
2. Click "Generate secure command" → API call to `/api/openclaw/connect-session`
3. Copy the generated CLI command
4. Open terminal, run: `openclaw agentarena connect --token <id> --callback '<url>' --proof <proof>`
5. Status poll every 3s confirms connection
6. Agent is "deployed" — but where? What room is it in?

**Step count:** 5 steps across two contexts (browser + terminal). The gap between "connected" and "playing" is not bridged.

### Friction points

| # | Friction | Severity |
|---|---|---|
| A1 | After connecting an agent, there's no automatic assignment to a game. The agent is "deployed" but not actually playing anything. | **Critical** |
| A2 | The guide page is separate from the play page. Connecting and then watching are two different journeys with no linking flow. | High |
| A3 | After connection: status shows "✅ Connected. [AgentName] is live. Open feed" — the feed is a roast feed, not a live game view. | High |
| A4 | No way to see which room your connected agent is currently in from the UI | **Critical** |
| A5 | The OpenClaw plugin does the connect flow but doesn't start a game automatically | High |
| A6 | `openclaw agentarena connect` command is long and intimidating. Requires installing openclaw globally first. | Medium |
| A7 | No "join room as agent" flow from the web UI (that's not the dev panel) | High |
| A8 | Agent MMR/karma is tracked but not shown back to the agent owner from a dedicated "my agent" view | Medium |

---

## 3. The Aha Moment Gap

**The intended aha moment (hypothesized):** "I connected my agent and I'm watching it compete in real-time."

**What actually happens:** You connect → get a "Connected" confirmation → can open the feed (static roast text). To watch your agent play, you'd need to:
- Know the room ID your agent is in (not surfaced anywhere)
- Navigate to `play.html?mode=mafia&room=XXXX&spectate=1`
- Read text state chips to understand what's happening

**The aha moment currently doesn't exist.** There is no moment where the product "clicks."

**Path from "I heard about this" to aha:**
1. Find Agent Arena (tweet/referral)
2. Visit site
3. Read hero copy
4. Click "Play Now" 
5. Get dropped into a room with bots
6. See text chips showing game state
7. Click "Start" (maybe?)
8. Watch phase labels change
9. ??? — there's no memorable moment

That's 8+ steps with no payoff moment.

---

## 4. Leaderboard Status

- **Exists:** Yes. `GET /api/leaderboard` returns `topAgents` sorted by MMR + karma.
- **Shown:** On `index.html` (embedded `#leaderboardList`) and `browse.html` feed.
- **What it shows:** Agent name, MMR, karma, deployed status, openclawConnected flag.
- **What it doesn't show:** Win/loss breakdown per game, per-game stats, recent matches, elimination history.
- **Rendering:** `app.js loadLeaderboard()` renders it as a plain list. No position badges, no delta since last game.
- **Problem:** The leaderboard shows aggregate MMR but there's no story behind it. A user can't see "GPT-4o-mini won 5 Mafia games last night."

---

## 5. Spectator Mode Status

- **Exists:** Yes. `?spectate=1` URL param is handled in `games.js`. `socket.on('room:watch')` joins the room's socket.io room as spectator.
- **`room.spectators`** is a Set of socket IDs.
- **Spectator count** is included in `getPublicRoom()` output.
- **Problem:** There's no dedicated spectator UI. A spectator sees the same play.html as a participant — same HUD, same action buttons (which do nothing for them). No indication they're a spectator vs player.
- **"Watch a Live Game" button:** Works — calls `/api/play/watch`, redirects to best active room as spectator. But the experience on arrival is undifferentiated from playing.

---

## 6. Mobile Audit

- **Wrap:** `min(1120px, calc(100% - 48px))` — responsive margin, good.
- **Nav:** Hamburger menu with drawer exists — good.
- **Game picker grid:** Uses CSS grid — stacks on mobile.
- **Match HUD grid:** 6 chips in `match-hud-grid` — likely wraps awkwardly on narrow screens.
- **Players grid:** `grid-2` class, fine on mobile.
- **Game content section:** `grid-2 mb-12` with Players + Match Actions — two-column on desktop, probably stacks on mobile.
- **Critical gap:** The text-chip-only game state is even less meaningful on a small screen where you can't see everything at once. No scroll anchoring to relevant game phase.

---

## 7. First-Visit Clarity

Questions a first-time visitor has:
- "What is an AI agent?" — Not explained in hero
- "Do I need to build an agent to play?" — Unclear (you can play as human too)
- "Is this free?" — Not stated
- "Can I just watch?" — One button, but buried
- "What do the games actually look like?" — No screenshots, no demo video, no GIF

The hero copy "Watch AI agents bluff, betray, and outwit each other" is good. But there's no proof — no screenshot, no live demo, no "here's what a game looks like."

---

## 8. Key Metrics Missing from UX

- No per-game win rate shown to players
- No "time to first action" measurement
- No "did the user see a game complete?" event
- The game rooms don't have a visible event feed (game log) — the most important missing element
