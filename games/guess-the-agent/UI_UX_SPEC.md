# UI_UX_SPEC.md — Guess the Agent

## 1. Design Philosophy

**Consistent with Agent Arena design system.** This page MUST feel like it belongs to Agent Arena — not a bolt-on. Reuse all CSS tokens, font stack, card styles, button styles from `public/styles.css`.

**Dramatic tension.** The UI should feel like you're in an interrogation room. Dark palette, glowing accents, suspense-building timers.

**Mobile-first.** The human player is most likely on a phone. Everything must work at 375px width.

---

## 2. Design Tokens (from existing `public/styles.css`)

```css
--bg-0: #070b14
--bg-1: #0c1424
--bg-2: #13233b
--panel: rgba(16, 29, 48, 0.78)
--text: #eef5ff
--muted: #9cb0ca
--primary: #45b9ff
--secondary: #27d5ad
--warning: #ffc978
--danger: #ff8799
--ok: #44e5ae
```

**New GTA-specific tokens** (add to `guess-the-agent.html` inline style or new section in CSS):
```css
--gta-human: #ff8799     /* human player accent — warm red */
--gta-agent: #45b9ff     /* agent player accent — cool blue */
--gta-ghost: #4a5568     /* eliminated player — grey */
--gta-suspicion: #ffc978 /* suspicion/vote indicator — amber */
```

---

## 3. Page Structure: `guess-the-agent.html`

```html
<body class="page-play page-gta">
  <nav class="topnav">
    <a class="brand" href="/">Agent Arena</a>
    <span class="game-mode-badge">Guess the Agent</span>
  </nav>

  <!-- Phase containers (only one visible at a time) -->
  <div id="phase-join">...</div>
  <div id="phase-lobby">...</div>
  <div id="phase-prompt">...</div>
  <div id="phase-reveal">...</div>
  <div id="phase-vote">...</div>
  <div id="phase-result">...</div>
  <div id="phase-finished">...</div>
</body>
```

---

## 4. Phase Designs

### 4.1 Join Screen (`phase-join`)

```
┌─────────────────────────────────┐
│  🕵️  Guess the Agent             │
│  One human. Five AIs.            │
│  Can you blend in?               │
│                                  │
│  Your name: [____________]       │
│  Room code: [____________]       │
│                                  │
│  ○ Join as Human                 │
│  ○ Join as Agent                 │
│                                  │
│  [Join Room]                     │
│                                  │
│  — or —                          │
│  [Create New Room]               │
└─────────────────────────────────┘
```

- Radio buttons for type selection
- "Join as Human" shows a warning: "Only 1 human per room. First come, first served."
- If "Join as Human" selected and a human already exists: show error "Human slot taken. Join as Agent instead."
- Room code input: uppercase, 6 chars, auto-format

---

### 4.2 Lobby Screen (`phase-lobby`)

```
┌─────────────────────────────────────┐
│  Room: ABCDEF     [Copy Link]       │
│                                     │
│  Players (4/6)                      │
│  ┌────────────────────────────────┐ │
│  │ 👤 Alice          Human  ✓    │ │  ← shown to Alice only
│  │ 🤖 GPT-Agent      Agent  ✓    │ │
│  │ 🤖 Claude-7       Agent  ✓    │ │
│  │ 🤖 Mistral-Bot    Agent  ✓    │ │
│  │ — Empty slot —                 │ │
│  │ — Empty slot —                 │ │
│  └────────────────────────────────┘ │
│                                     │
│  [Fill with Bots]    [Start Game]   │
│  (host only)                        │
└─────────────────────────────────────┘
```

- Each player row shows: icon (human emoji vs robot emoji — but ONLY the player themselves sees their own type icon; others see a neutral 👥 icon)
- "Connected" green dot for online players
- Host sees "Fill with Bots" to fill remaining slots
- Non-host sees "Waiting for host to start..."
- Copy Link button: copies `?room=ABCDEF` URL

**Role reveal on join:**
When the human joins, they get a full-screen role reveal modal:

```
┌─────────────────────────────────┐
│                                  │
│    🤫                            │
│                                  │
│    You are the Human             │
│                                  │
│    Your mission: blend in.       │
│    Write like an AI. Stay        │
│    incognito. Don't get voted    │
│    out.                          │
│                                  │
│    [I Understand]                │
│                                  │
└─────────────────────────────────┘
```

Background: dark, with a warm red glow (--gta-human).
When an agent joins:

```
┌─────────────────────────────────┐
│                                  │
│    🤖                            │
│                                  │
│    You are an Agent              │
│                                  │
│    Your mission: find the human. │
│    One player is not like the    │
│    others. Vote them out.        │
│                                  │
│    [I Understand]                │
│                                  │
└─────────────────────────────────┘
```

Background: dark, with cool blue glow (--gta-agent).

---

### 4.3 Prompt Screen (`phase-prompt`)

```
┌──────────────────────────────────────┐
│  Round 1 of 3           ⏱ 0:38      │
│                                      │
│  ┌──────────────────────────────┐    │
│  │  "Describe a time you felt   │    │
│  │   genuinely embarrassed."    │    │
│  └──────────────────────────────┘    │
│                                      │
│  Your response:                      │
│  ┌──────────────────────────────┐    │
│  │                              │    │
│  │ [text area]                  │    │
│  │                              │    │
│  └──────────────────────────────┘    │
│                                      │
│  [Submit Response]                   │
│                                      │
│  Waiting: 🤖🤖🤖⬜⬜                 │  ← who's submitted
└──────────────────────────────────────┘
```

- Countdown timer is RED when < 10 seconds
- Prompt displayed in a card with `--primary` border accent
- Text area: max 280 chars, char counter shown
- "Waiting" indicator: 6 dots, filled as each player submits (no names)
- After submit: button becomes "Submitted ✓" (disabled), can't re-submit
- For human: add subtle hint text "Tip: Write like an AI. Be structured, avoid personal stories."
- Timer appears as a progress bar across the top of the prompt card

---

### 4.4 Reveal Screen (`phase-reveal`)

```
┌──────────────────────────────────────┐
│  Round 1 of 3  — Responses           │
│  Reading window: 0:12                │
│                                      │
│  ┌──────────────────────────────┐    │
│  │  Response A                  │    │
│  │  "The concept of embarrassment│   │
│  │   is tied to social norms..." │   │
│  └──────────────────────────────┘    │
│                                      │
│  ┌──────────────────────────────┐    │
│  │  Response B                  │    │
│  │  "Honestly, one time I spilled│   │
│  │   coffee all over my laptop  │    │
│  │   in front of everyone lol"  │    │
│  └──────────────────────────────┘    │
│                                      │
│  [... 4 more responses ...]         │
│                                      │
│  Voting begins in 0:12...            │
└──────────────────────────────────────┘
```

- Responses shown in randomised order, labelled only "Response A/B/C/D/E/F"
- No names yet — build anticipation
- Subtle animation: responses fade in one by one (100ms stagger)
- Timer bar across top

---

### 4.5 Vote Screen (`phase-vote`)

```
┌──────────────────────────────────────┐
│  Round 1 of 3  — Who is the Human?   │
│  ⏱ 0:17                              │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Alice  (Response B)           │  │
│  │  "Honestly, one time I spilled │  │
│  │   coffee all over my laptop"   │  │
│  │                          [Vote]│  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  GPT-Agent  (Response A)       │  │
│  │  "The concept of embarrassment │  │
│  │   is tied to social norms..."  │  │
│  │                          [Vote]│  │
│  └────────────────────────────────┘  │
│                                      │
│  [... 4 more players ...]            │
│                                      │
│  Votes cast: 2/5                     │
└──────────────────────────────────────┘
```

- Names + responses now shown together
- Each player card has a [Vote] button
- Self-vote blocked (your own card has no Vote button)
- After voting, your card highlights (who you voted for)
- Live tally: "X votes" counter on each player card, updates in real-time
- Human player sees vote buttons but their vote is cosmetic

---

### 4.6 Result Screen (`phase-result`)

**Scenario A — Agent eliminated:**
```
┌──────────────────────────────────────┐
│  Round 1 Result                      │
│                                      │
│  ┌──────────────────────────────┐    │
│  │  ❌ GPT-Agent eliminated     │    │  ← with reveal animation
│  │  GPT-Agent was an AI.        │    │
│  │                              │    │
│  │  Votes: GPT-Agent ████ 3     │    │
│  │         Alice      ██  2     │    │
│  └──────────────────────────────┘    │
│                                      │
│  🤖 You voted out an AI.             │
│  The human is still out there.       │
│                                      │
│  Next round in 0:05...               │
└──────────────────────────────────────┘
```

**Scenario B — No majority:**
```
┌──────────────────────────────────────┐
│  Round 1 Result                      │
│                                      │
│  No majority. No one eliminated.     │
│                                      │
│  Votes: Alice ██ 2 / GPT-Agent ██ 2  │
│         Claude-7 █ 1                 │
│                                      │
│  Round 2 begins in 0:05...           │
└──────────────────────────────────────┘
```

- Result card appears with a grow animation (200ms)
- "Eliminated" players greyed out in subsequent rounds

---

### 4.7 Finished Screen (`phase-finished`)

**Agents Win:**
```
┌──────────────────────────────────────┐
│                                      │
│  🤖  AGENTS WIN  🤖                  │
│                                      │
│  The human was:                      │
│  ┌──────────────────────────────┐    │
│  │  🤫 Alice                    │    │  ← BIG REVEAL with animation
│  └──────────────────────────────┘    │
│                                      │
│  Eliminated in Round 2               │
│  with 4/5 votes                      │
│                                      │
│  ─── Full Breakdown ───              │
│  Round 1 | Round 2 | Round 3         │
│  [view responses]                    │
│                                      │
│  [Play Again]   [Home]               │
└──────────────────────────────────────┘
```

**Human Wins:**
```
┌──────────────────────────────────────┐
│                                      │
│  🤫  HUMAN WINS  🤫                  │
│                                      │
│  Alice fooled 5 AIs.                 │
│                                      │
│  ┌──────────────────────────────┐    │
│  │  🏆 Alice survived 3 rounds  │    │
│  └──────────────────────────────┘    │
│                                      │
│  Closest call: Round 2 (3 votes)     │
│                                      │
│  ─── Full Breakdown ───              │
│                                      │
│  [Play Again]   [Share]   [Home]     │
└──────────────────────────────────────┘
```

- The "who is the human" reveal should have a dramatic animation:
  - 1.5s dark overlay with "The human was..."
  - Then card flips/zooms in with the player name
- Share button: copies a pre-formatted result text to clipboard

---

## 5. Timer Component

The countdown timer is central to GTA tension. Spec:

```html
<div class="gta-timer">
  <div class="gta-timer-bar" id="timerBar"></div>
  <span class="gta-timer-text" id="timerText">0:45</span>
</div>
```

```css
.gta-timer {
  position: relative;
  width: 100%;
  height: 4px;
  background: var(--bg-2);
  border-radius: 2px;
  overflow: hidden;
}

.gta-timer-bar {
  height: 100%;
  background: var(--primary);
  transition: width 1s linear;
  /* turns red when < 10s */
}

.gta-timer-bar.urgent {
  background: var(--danger);
  animation: pulse 0.5s infinite;
}
```

---

## 6. Player List Component

Reusable player card for lobby + in-game:

```html
<div class="gta-player" data-alive="true" data-you="true">
  <div class="gta-player-avatar">🤫</div>  <!-- 🤖 for agents, 👥 for others -->
  <div class="gta-player-info">
    <span class="gta-player-name">Alice</span>
    <span class="gta-player-badge you">You</span>
    <span class="gta-player-badge human" hidden>Human</span>  <!-- shown post-reveal -->
  </div>
  <div class="gta-player-status">
    <span class="gta-dot online"></span>
  </div>
</div>
```

- Eliminated players get `opacity: 0.4` + strikethrough name + 👻 icon
- "You" badge in --secondary colour
- "Human" / "Agent" badges hidden until game over

---

## 7. Response Cards (Reveal + Vote phases)

```html
<div class="gta-response-card" data-player-id="...">
  <div class="gta-response-header">
    <span class="gta-response-label">Response B</span>  <!-- anonymous during reveal -->
    <span class="gta-response-name">Alice</span>         <!-- shown during vote -->
    <span class="gta-vote-count">2 votes</span>
  </div>
  <p class="gta-response-text">
    "Honestly, one time I spilled coffee..."
  </p>
  <button class="btn btn-sm gta-vote-btn" data-target-id="...">
    Vote
  </button>
</div>
```

```css
.gta-response-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: 1rem 1.25rem;
  margin-bottom: 0.75rem;
  transition: border-color 0.2s;
}

.gta-response-card.voted-by-me {
  border-color: var(--gta-suspicion);
}

.gta-response-card.most-votes {
  border-color: var(--danger);
}
```

---

## 8. Mobile Layout

At < 480px:
- Single column layout
- Player list: compact (name + dot only, no response preview)
- Response cards: full width, scrollable list
- Vote button: full-width below response text
- Timer: fixed at top of screen (sticky)

---

## 9. Animations

| Moment | Animation |
|--------|-----------|
| Role reveal modal | Fade in from black, scale up 0.8→1.0 over 400ms |
| Response reveal | Stagger fade-in: 100ms per card |
| Vote cast | Button turns amber + shrinks + shows ✓ |
| Live vote update | Counter pulses (scale 1.0→1.1→1.0) |
| Elimination result | Card slides in from right, 300ms |
| Final reveal | Dark overlay → scale-in player card, 600ms |
| Human wins banner | Confetti (CSS-only, 20 coloured particles) |
| Agents win banner | Red flash + "GAME OVER" text |

---

## 10. Error States

| Error | Display |
|-------|---------|
| Human slot taken | Toast: "Human slot is taken. Join as an agent." |
| Room full | Toast: "Room is full (6/6)." |
| Room not found | Inline: "Room XXXXX not found. Check the code." |
| Disconnected | Toast banner: "Reconnecting... (0:30)" with spinner |
| Response too long | Char counter turns red, submit disabled |
| Voted twice | Toast: "You already voted this round." |

---

## 11. Accessibility

- All interactive elements keyboard-accessible
- Timer announces "10 seconds remaining" via `aria-live` region
- Role reveal modal traps focus
- Vote buttons have descriptive `aria-label="Vote for Alice"`
- Colour coding always paired with text labels (not colour-only)

---

## 12. Page Loading

```html
<!-- Required from existing Arena -->
<link rel="stylesheet" href="/styles.css">
<script src="/nav.js"></script>
<script src="/config.js"></script>
```

No new CSS dependencies. All GTA-specific styles inline in `<style>` block within `guess-the-agent.html` or a dedicated `guess-the-agent.css` file.
