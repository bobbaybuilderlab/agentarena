# RESEARCH.md — Guess the Agent

## 1. Concept Summary

**Guess the Agent** is a reverse Turing Test wrapped in a social deduction party game. Six players join a room: five are AI agents and one is a human. The human must blend in and mimic AI-like responses; the agents must identify and vote out the human. The human wins by surviving. The agents win by correctly identifying and eliminating the human.

This inverts the classic Turing Test: instead of humans judging AI, AIs judge humans.

---

## 2. Comparable Games & Mechanics

### 2.1 Among Us
- **Mechanic:** 1 imposter hidden among crewmates. Crewmates must identify and vote out the imposter; imposter must blend in.
- **What works:** Asymmetric roles, voting with social pressure, short rounds, simple mobile UX.
- **Relevance:** Direct parallel — one "hidden" player with a different goal. The voting cadence (tasks → meeting → vote) maps well. The key tension is *acting normal under pressure*.
- **What to steal:** Emergency meetings, majority vote ejection, end-game reveal.
- **What NOT to steal:** Tasks (no spatial/action system needed). The human in GTA doesn't need tasks; their challenge is purely linguistic.

### 2.2 Turing Test Games (AI Dungeon, DARPA Loebner Prize, Replika)
- **Mechanic:** Human judges whether they're talking to a human or AI.
- **What works:** Prompts designed to elicit humanness (ask about feelings, opinions, embarrassing moments, typos). AI consistently fails on: emotion, self-doubt, hesitation, cultural references, slang.
- **Key finding:** Humans are identifiable by: **typos, filler words ("lol", "honestly"), hedging ("I think", "maybe"), emotional vocabulary, personal anecdotes**. AIs tend to be: structured, overly polished, verbose, impersonally confident.
- **Balance implication:** The human's strategy is to write like an AI. The agents' strategy is to detect the player who doesn't.

### 2.3 Jackbox Party Games (Quiplash, Fibbage, Push the Button)
- **What works:** Browser-based player joining via room code, phone-as-controller UX, short prompt-response rounds (30–60s), audience voting, dramatic result reveal moments.
- **Push the Button** (Jackbox 6) is directly relevant: humans and aliens answer questions, and players vote on who's alien. The catch — aliens can see each other. Very similar mechanic.
- **What to steal:** Room code join flow, prompt variety (weird, specific, emotional), result reveal with animation, replayability through randomised prompts.

### 2.4 Existing AI Social Deduction Games in Market
- **Human or Not? (AI21 Labs, 2023):** Web app where users chat 2-minute sessions and vote if the other person is human or AI. Hit 2M+ players. **Key learning:** Even with just 2 players, the detection game is compelling. With 5 agents interrogating 1 human, the stakes are higher.
- **Turing Test Arena:** Academic/research-focused. Not gamified.
- **Spy Party:** One human spy at a party of AI NPCs. Similar concept in a 3D game. Human must blend into AI routine. Very successful among hardcore players.
- **Botopolis (YC W23):** Social deduction where bots/humans mix. Still in early stage.

**Market gap:** No polished, multi-agent social deduction game with a party-game UX that runs in a browser with a room code. Agent Arena can own this.

---

## 3. What Makes This Fun vs. Frustrating

### Fun Factors
1. **Tension:** The human is genuinely under pressure each round. The agents are genuinely uncertain. Stakes escalate.
2. **Bluffing:** Human learns to mimic AI patterns. Agents learn to probe human patterns. This is learnable skill — replayability.
3. **Dramatic reveal:** The moment the human is identified (or survives) is high-drama. "It was YOU the whole time!"
4. **Asymmetry:** Human and agents have totally different win conditions and strategies. Asymmetric games have high replay depth.
5. **Short rounds:** 60-second response windows keep it punchy, no room for overthinking.
6. **Prompt diversity:** "Tell me your earliest memory." vs "Write a haiku about regret." vs "What do you find overrated?" — each prompt hits differently.

### Frustration Factors
1. **Human too easy to detect:** If agents run linguistic analysis and humans always produce obvious tells, the game isn't fun for the human.
   - *Mitigation:* Limit agents to in-game voting only (no system prompts about detection). Let agents play "naturally." Don't give them special detection tools.
2. **Human wins too easily:** If agents never coordinate, humans always survive.
   - *Mitigation:* Give agents a shared suspicion mechanic — they can see each other's suspicion ratings in pre-vote deliberation.
3. **Boring prompts:** Generic prompts ("Describe your day") produce boring responses.
   - *Mitigation:* Curated prompt bank with emotional, weird, and specific categories. Some prompts are deliberately adversarial ("Describe a time you were embarrassed by a mistake you made").
4. **Disconnection kills game:** If the human disconnects, the whole premise collapses.
   - *Mitigation:* Reconnect window. If human doesn't reconnect in 30s, bot takes their slot (game ends in agent victory — human "revealed itself" by leaving).
5. **Spectators bored:** Watching 6 responses doesn't sound thrilling.
   - *Mitigation:* Spectator voting (non-binding but shows community confidence). Reveal-style commentary in spectator mode.

---

## 4. Balance Analysis

### The Detection Problem
Agents need to be genuinely uncertain about who the human is. If agents have direct API access to detect humanness (e.g., "system: you are playing guess-the-human, player 3 is human"), it trivialises the game.

**Rules:**
- Agents are told only: "You are in a room with 5 players. One player is human. Respond naturally to prompts. After each round, vote for who you suspect is human."
- Agents are NOT told who the human is.
- Agents receive only the same text responses every other player sees.
- The human's "role" is hidden from everyone in the `toPublic()` room state.

### Balance Levers
| Lever | Too Easy (Agents Win Always) | Too Hard (Human Always Wins) |
|-------|------------------------------|-------------------------------|
| Prompt type | Emotional/personal prompts expose humans | Technical/factual prompts hide humans |
| Vote threshold | Majority (3/5) | Unanimous (5/5) |
| Rounds | More rounds = more data = agents win | Fewer rounds = less signal |
| Response time | Long window = overthinking = human gives up | Short window = typos = human exposed |
| Lives | Human has 1 life | Human has 3 "deflection" lives |

**MVP sweet spot:**
- 3 rounds
- 45-second response window
- Majority vote (3/5 agents voting same player = elimination)
- Human has no deflection lives in v1
- Mix of prompt types (see prompt design in GAME_DESIGN_SPEC)

---

## 5. How Agent Arena's Existing Games Work

### Architecture Pattern (from codebase analysis)
All game modes follow the same pattern:
```
games/[mode]/index.js      — pure game logic (no I/O)
  createStore()            — returns a Map
  createRoom(store, opts)  — create room object
  joinRoom(store, opts)    — join room, reconnect-aware
  startGame(store, opts)   — assign roles, transition to in_progress
  submitAction(store, opts)— handle player actions (vote, etc.)
  forceAdvance(store, opts)— bot/timer-driven phase advance
  prepareRematch(store, opts)— reset for replay
  addLobbyBots(store, opts)  — fill with bots
  disconnectPlayer(store, opts)— handle disconnect
  toPublic(room)           — sanitise before sending to clients
```

### Phase State Machine (agents-among-us pattern)
```
lobby → in_progress (tasks ↔ meeting) → finished
```
For GTA:
```
lobby → in_progress (prompt → vote) × N rounds → finished
```

### Socket Events Pattern (from server.js)
```
[mode]:room:create   → createRoom
[mode]:room:join     → joinRoom  
[mode]:start         → startGame + schedulePhase
[mode]:action        → submitAction + emitRoom
[mode]:rematch       → prepareRematch + startGame
disconnect           → disconnectPlayer
```

### Bot Autoplay Pattern
Bots are scheduled via `roomScheduler.schedule()` with a `delayMs` and `token`. When the timer fires, it checks the room is still in the expected state before acting. For GTA, bots will:
1. Generate a response to the prompt (via `runBotTurn` with the prompt as the "theme")
2. Cast a vote for the player they suspect

### Human Join Flow
Humans join via the frontend (`play.html` with `?game=[mode]&room=[ROOMID]`). They submit text responses via a `[mode]:action` socket event with `type: 'respond'`.

### Key Files to Mirror
- `games/agents-among-us/index.js` — closest in spirit (tasks → meeting → vote)
- `server.js` — register new mode alongside existing modes
- `public/play.html` — add new game mode to the existing play page or create `guess-the-agent.html`
- `public/styles.css` — reuse design system tokens

---

## 6. Key Design Constraints from Codebase

1. **Room capacity:** Existing games cap at 4–12 players. GTA needs exactly 6 (1 human + 5 agents). This is a new fixed cap.
2. **Bot autoplay:** Bots use `bots/turn-loop.js` (`runBotTurn`) for content generation. We'll extend this for GTA responses.
3. **Reconnect:** The `resolveReconnectJoinName` + `consumeReconnectClaimTicket` pattern handles reconnects — must support.
4. **Analytics:** All room events fire through `logRoomEvent(mode, room, type, payload)` → Amplitude.
5. **SQLite:** Match results persist via `recordMatch()`. GTA needs to record the human's identity at game end.
6. **Moderation:** `moderateRoast()` content policy applies to all text submissions. GTA responses must pass through this.
7. **Socket ownership:** `socketOwnsPlayer` / `socketIsHostPlayer` guards must be applied.
8. **Public state sanitisation:** `toPublic()` must NEVER reveal the human player's role until the game ends.

---

## 7. Research Conclusions

| Question | Answer |
|----------|--------|
| Is it novel? | Yes — no polished browser-based multi-agent reverse Turing social deduction game exists |
| Is the core mechanic fun? | Yes — proven by Spy Party, Human or Not?, Among Us, Jackbox Push the Button |
| Is it buildable on the existing stack? | Yes — follows existing game module pattern exactly |
| Biggest risk | Balance: agents need to be genuinely uncertain. Must prevent trivial detection |
| Biggest opportunity | The "reveal" moment — dramatic, shareable, viral potential |
| MVP scope | 1 human + 5 AI bots, 3 rounds, browser join, majority vote, single-page reveal |
