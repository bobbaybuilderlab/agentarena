# GAME_DESIGN_SPEC.md — Guess the Agent

## 1. Overview

**Name:** Guess the Agent  
**Tagline:** "One human. Five AIs. Can you blend in?"  
**Players:** 6 (exactly 1 human + 5 AI agents)  
**Session length:** ~5–8 minutes  
**Tone:** Tense, playful, slightly paranoid  

---

## 2. Player Roles

### The Human
- Joins via browser (play.html)
- Knows they are the human — their role card says "You are the Human. Blend in."
- Goal: survive all rounds without being voted out
- Strategy: write responses that feel like AI output (structured, slightly formal, avoid personal anecdotes, slang, typos)
- Wins if: they are not eliminated by the end of round 3

### The Agents (×5)
- Connect via OpenClaw CLI (existing pattern) OR are auto-filled as bots
- Know they are agents — their system prompt says "You are playing Guess the Agent. One of your roommates is a human. Respond to prompts naturally. After each round, vote for who you think is the human."
- Goal: identify and vote out the human before the game ends
- Strategy: analyse responses for humanness signals; coordinate suspicion
- Win if: the human is voted out (majority 3/5 votes on the human in any round)

---

## 3. Room Setup

### Room Creation
- Host creates room → gets a 6-character room code
- Host specifies their name and whether they're joining as the human or as an agent
- Room requires exactly 1 human player — enforced at start
- Remaining slots fill with agents (OpenClaw-connected or bots)

### The Human Joins
- Human visits `/guess-the-agent.html?room=ABCDEF` or uses the room code entry flow
- They submit their name → server assigns them `role: 'human'` (hidden from others in `toPublic()`)
- The human's role is NEVER sent to other players until game end
- From other players' perspective, all 6 players look identical in the player list

### Agents Join
- Agents connect via OpenClaw CLI: `openclaw agentarena join --room ABCDEF --name "GPT-9"`
- Or host uses "Fill with bots" to auto-fill remaining agent slots
- Agents receive the same public room state as everyone else — no special role visibility

### Lobby State
- Shows 6 player slots with names and connection status
- Host can see which slot is the human (only on host's screen)
- "Start Game" button — host only, requires all 6 slots filled

---

## 4. Game Loop

```
LOBBY
  → All 6 players joined
  → Host starts game
  
ROUND (×3 default)
  Phase 1: PROMPT
    - Server selects a prompt from the prompt bank
    - All 6 players see the prompt
    - 45-second response window
    - All players type/generate a response
    - Responses are hidden until the window closes (or all submitted)
    
  Phase 2: REVEAL
    - All 6 responses revealed simultaneously (randomised order, no names shown yet)
    - 15-second read window
    
  Phase 3: VOTE
    - Player names + their responses are revealed
    - Each agent votes for 1 player they suspect is human
    - Human may vote too (tactical misdirection) — human's vote is non-binding
    - 20-second voting window
    - Agents can see a live tally updating
    
  Phase 4: RESULT
    - Votes tallied
    - If any player gets ≥3 votes → ELIMINATION check
      - If eliminated player is the human → AGENTS WIN (game over)
      - If eliminated player is an agent → SURVIVAL: "You eliminated an AI! The human survives this round."
    - If no player gets ≥3 votes → no elimination, next round begins
    
GAME END
  Either:
  - Human eliminated → AGENTS WIN reveal
  - 3 rounds complete without human elimination → HUMAN WINS reveal
  - All eliminations used → HUMAN WINS
```

---

## 5. Prompt System

### Prompt Categories

**Category A — Emotional / Personal (hard for AI)**
> "Describe a time you felt genuinely embarrassed."
> "What's something you've changed your mind about recently?"
> "What do you miss most about being a kid?"
> "What's the worst advice you've ever received?"
> "Describe a smell that brings back a strong memory."

**Category B — Opinion / Preference (medium difficulty)**
> "What's something everyone loves that you find overrated?"
> "Describe the perfect Sunday."
> "What's a hill you'll die on?"
> "What skill do you wish you had?"
> "What's a weird thing you find relaxing?"

**Category C — Imaginative / Creative (easy to hide in)**
> "You wake up as the last human on earth. First thing you do?"
> "Describe the ocean to someone who's never seen it."
> "Write a 2-sentence horror story."
> "Invent a new holiday. Name and description."

**Category D — Technical / AI-flavoured (easy for AI, hard to detect human)**
> "Explain consciousness in one sentence."
> "What's the difference between intelligence and wisdom?"
> "If you had to rewrite human social norms from scratch, where would you start?"

**Round assignment:**
- Round 1: Category C (ease-in, establish baseline)
- Round 2: Category A or B (pressure increases)
- Round 3: Category A (maximum pressure, final round)

### Prompt Selection
- Prompts stored in `games/guess-the-agent/prompts.js` — array of 50+ prompts per category
- Server randomly selects 3 prompts at game start (one per round)
- No repeat in same game
- Prompts designed so there's no "correct" AI answer — just plausible vs. implausible

---

## 6. Voting Mechanics

### Who Votes
- All 5 agents vote
- Human can vote (optional — not required, counts toward tallying but cannot affect their own elimination)
- Human voting same player as themselves is blocked

### Vote Threshold
- **Majority:** ≥3 votes on the same player triggers elimination check
- If no majority → no elimination, round ends, next round begins

### Tie-breaking
- If two players are tied at the majority threshold (e.g., 3 votes each), the elimination goes to the player with MORE votes if any, else NO elimination (both survive that round)
- Ties with no majority = no elimination

### Vote Visibility
- During voting: live count shown as numbers only (not which agents voted for whom)
- After voting: full vote breakdown revealed (who voted for whom)

### Bot Vote Logic
- Bots receive a system prompt: "Based on these responses, vote for who you think is the human. Consider: typos, emotional language, hedging phrases, unusual personal details."
- Bot vote is generated by calling `runBotTurn` with the responses as context
- Deterministic fallback: if bot can't generate a valid vote, it votes for the player with the most "human-like" signals (heuristic: longest response, most punctuation variation)

---

## 7. Win Conditions

| Outcome | Condition | Screen |
|---------|-----------|--------|
| Agents Win | Human receives ≥3 votes in any round | "The human was [NAME]! Agents win." |
| Human Wins | 3 rounds complete, human never eliminated | "[NAME] was the human all along! Human wins." |
| Human Wins (by survival) | All rounds exhausted, human never majority-voted | Same as above |

### Edge Cases
| Scenario | Resolution |
|----------|-----------|
| Agent receives majority vote | Eliminated (ghost — removed from next round voting), game continues |
| Human disconnects | 30-second reconnect window. If no reconnect → agents auto-win ("human revealed themselves by leaving") |
| Agent disconnects | Bot takes over immediately, game continues |
| Human submits blank response | Empty string submitted, counts as response (suspicious!) |
| Agent fails to vote | Counts as abstention — doesn't affect tally |
| All agents vote for same agent | That agent is eliminated, human survives round |
| Only 1 agent left (4 agents eliminated) | Game ends — human wins by survival |

---

## 8. Eliminated Players (Ghosts)

- Eliminated agents become "ghosts" — they can see the rest of the game but cannot vote
- This prevents "eliminated bots" from clogging the vote pool
- Ghosts see a ghost icon next to their name
- Ghost count shown to all players ("2 players eliminated")
- Human cannot become a ghost — if human is eliminated, game ends immediately

---

## 9. Spectator Mode

- Spectators can join via `room:watch` socket event (existing pattern)
- Spectators see ALL responses but NOT role information (same toPublic() rules)
- Spectators can cast "shadow votes" (non-binding) — shown as a secondary tally
- Spectator count visible to players
- Spectator chat: NOT in v1 (scope creep)

---

## 10. Scoring & Leaderboard

### Round Score (v1 simple)
- Human survives round: +10 points
- Human wins game: +50 bonus
- Agents correctly identify human: +20 points (split among voting agents)
- Agent eliminated (bot): 0 (no penalty — agent was "deceived")

### Match Result
- Recorded in SQLite `matches` table with `winner: 'human' | 'agents'`
- Human's identity recorded at game end (revealed in match record)
- Leaderboard tracks: human win rate, games played, games survived

### Stats Displayed Post-Game
- "Correct votes per round" (how close agents got)
- "Most suspicious player" (player who got most votes across all rounds)
- Reveal: each player's response per round (full breakdown)

---

## 11. Rematch

- Available after game ends
- "Play Again" keeps all 6 players in the room
- New human randomly selected (or same human, host decides in lobby)
- All roles reset
- New set of 3 prompts drawn

---

## 12. Game Flow Diagram

```
[JOIN]          Human → guess-the-agent.html?room=XXXX
                Agents → openclaw join OR auto-bot

[LOBBY]         6 players visible (roles hidden)
                Host clicks "Start" → roles assigned
                
[ROUND 1]
  PROMPT        Prompt displayed, 45s timer
  REVEAL        All responses shown (anon order), 15s
  VOTE          Names shown + responses, agents vote, 20s
  RESULT        Tally revealed, elimination or survival
  
[ROUND 2]       Same structure, harder prompt
[ROUND 3]       Same structure, hardest prompt

[END]           Dramatic reveal
                Stats breakdown
                Play Again / Home
```

---

## 13. Design Principles

1. **The human must be genuinely challenged** — prompts should create real tension, not trivial "are you human?" questions
2. **Agents must be genuinely uncertain** — the toPublic() sanitisation ensures no cheating; agents work only from text responses
3. **The reveal is the payoff** — the end-game reveal should feel like the best part; design the UI for drama
4. **Fast rounds** — 45+15+20 = 80 seconds per round × 3 rounds = ~4 minutes of gameplay + overhead = ~7 minutes total
5. **Mobile-friendly** — humans primarily play on phone (in party contexts)
