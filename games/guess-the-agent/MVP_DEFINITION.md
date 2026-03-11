# MVP_DEFINITION.md — Guess the Agent

## 1. MVP Objective

Ship a **playable, shareable, fun** version of Guess the Agent that:
1. A human can join from any browser
2. 5 AI bots auto-fill and respond intelligently
3. The core loop (prompt → respond → vote → eliminate) works end-to-end
4. The reveal moment is dramatic
5. Can be played in ~7 minutes

---

## 2. MUST HAVE (v1 — MVP)

### Game Logic
- [x] 1 human + 5 agents per room (exact)
- [x] 3 rounds
- [x] Prompt display (45s timer)
- [x] Response submission (text, ≤280 chars, moderated)
- [x] Anonymous response reveal phase (15s)
- [x] Voting phase (20s, majority = 3/5)
- [x] Elimination check (human vs agent)
- [x] Win conditions: agents win (human eliminated) OR human wins (survives all rounds)
- [x] Auto-bot fill (5 bot agents with names and responses)
- [x] Bot response generation (via `runBotTurn` with prompt as theme)
- [x] Bot vote logic (heuristic: score responses for humanness)
- [x] Phase timers (server-side, client countdown from `roundEndsAt`)
- [x] Reconnect window for human (30s, then agents auto-win)
- [x] Role hiding in `toPublic()` until game end
- [x] Final reveal (human identity shown at game end)

### Frontend
- [x] Join screen (name + room code + type selection)
- [x] Role reveal modal (human vs agent)
- [x] Lobby screen (player list + start button)
- [x] Prompt screen (text area + timer + submit)
- [x] Reveal screen (anonymous responses + timer)
- [x] Vote screen (names + responses + vote buttons)
- [x] Result screen (elimination or survival)
- [x] Finished screen (winner + human identity)
- [x] Mobile-friendly layout
- [x] Consistent with Arena design system

### Backend
- [x] `games/guess-the-agent/index.js` — full game module
- [x] `games/guess-the-agent/prompts.js` — 30+ prompts across 3 categories
- [x] Socket events: `gta:room:create`, `gta:room:join`, `gta:autofill`, `gta:start`, `gta:action`, `gta:rematch`
- [x] `scheduleGtaPhase()` in server.js
- [x] `emitGtaRoom()` with dual-emit (broadcast + per-socket role-aware)
- [x] `logRoomEvent('gta', ...)` for analytics
- [x] `recordMatch()` at game end (mode: 'gta')
- [x] `getLobbyStore()` updated for 'gta'
- [x] `/api/play/rooms` includes gta rooms

### UX
- [x] "Copy Room Link" in lobby
- [x] "Fill with Bots" button
- [x] Countdown timer with urgent state (red < 10s)
- [x] Live vote tally during vote phase
- [x] Dramatic final reveal animation

---

## 3. NICE TO HAVE (v1.5 — post-ship)

- [ ] Spectator shadow voting
- [ ] Spectator chat
- [ ] "Human's Strategy Revealed" post-game: show what the human was trying to do
- [ ] Bot personality variety (some bots more suspicious, some more blunt)
- [ ] Prompt categories shown to player ("this is an emotional prompt")
- [ ] Quick Join support for GTA rooms
- [ ] Match history page for GTA games
- [ ] Share button (copy match result text)
- [ ] Emoji reactions during reveal phase
- [ ] Human disconnect grace period > 30s (configurable)

---

## 4. DEFERRED TO V2

- [ ] OpenClaw-connected real AI agents (not just bots) as opponents
- [ ] Spectator commentary mode
- [ ] Player-created custom prompts
- [ ] Leaderboard: human win rate, longest survival streak
- [ ] Human "deflection" lives (3 lives before elimination)
- [ ] Team mode: 2 humans vs 4 agents
- [ ] Bluff mode: agents can publicly accuse players
- [ ] Agent suspicion feed (real-time agent "thinking" visible to spectators)
- [ ] Post-game AI analysis ("why the human was caught")
- [ ] Mobile app (PWA)
- [ ] Multi-language prompts
- [ ] Difficulty levels: Easy (more rounds) / Hard (fewer rounds, smarter bots)

---

## 5. NOT IN SCOPE (Ever or requires major rethink)

- Real-time voice responses (audio → text latency kills game pace)
- Image-based challenges (too complex for text-only agents)
- Persistent accounts / ELO for humans (v3+)
- Real money / premium features

---

## 6. MVP Success Criteria

The MVP is "done" when:

1. **Functional:** A human can join, play 3 rounds, and get a result
2. **Playable solo:** Bots fill automatically and generate coherent responses
3. **Dramatic:** The final reveal feels like a payoff
4. **Shareable:** The room link works, game is joinable by sharing URL
5. **Stable:** No crashes during a 3-round game with 1 human + 5 bots
6. **Fast:** Game loads in < 3 seconds, responses feel snappy

---

## 7. Scope Guard

If a feature is not in the MUST HAVE list above, **it is not in MVP**. The question for every implementation decision: "Does this make the core loop work?" If no → defer.

**Specific calls:**
- No Quick Join routing for GTA in MVP (complex, low-value at launch)
- No match history page for GTA in MVP (reuse existing matches table)
- No spectator mode in MVP (lobby design allows spectators to watch via room:watch but no shadow voting)
- No custom prompts in MVP (use the curated bank)
- Bot vote logic = heuristic only (no LLM-driven vote analysis)
