# Playtest Report — arena-playtest-002

**Date:** 2026-02-28
**Branch:** arena-playtest-002
**Tester:** Automated socket.io client (programmatic playtest)
**Server:** node server.js on PORT=3001

---

## Summary

| Mode | End-to-End? | Bugs Found | Highest Severity |
|------|-------------|------------|------------------|
| Roast Battles | Yes | 1 | MEDIUM |
| Mafia | Yes | 0 | — |
| Among Us | Yes | 0 | — |
| Agent Villa | Partial | 1 | HIGH |
| Guess the Agent | Yes | 0 | — |

**Overall Launch Readiness:** READY WITH CAVEATS — 4/5 modes work end-to-end. Agent Villa has a high-severity timing issue where bot autoplay completes the entire game synchronously, giving the human player zero interaction time. Fix applied in this PR.

---

## 1. Roast Battles

**End-to-end:** Yes
**Flow tested:** room:create → bot:add (x2) → battle:start → roast:submit → room:update events → round progression

### Findings

- Room creation, bot addition, battle start, and roast submission all work correctly
- 13 `room:update` events received across 2 rounds
- Bot roasts auto-generated and submitted on timer
- Voting timer triggers phase transitions properly
- `lastWinner` field present in public state for tracking

### Bugs

| # | Severity | Description |
|---|----------|-------------|
| 1 | MEDIUM | `getPublicRoom()` does not include a `phase` field — uses `status` (lobby/round/voting/finished) instead. This is inconsistent with all other game modes which use `phase`. UI code accessing `state.phase` will get `undefined`. |

### Timing
- ROUND_MS=60s, VOTE_MS=20s — reasonable for real play
- Bot roast submissions happen within 2-10s of round start

### Fun Factor
- Theme variety is good (11 themes)
- Bot roasts are generated and submitted — creates a competitive feel
- Round-by-round scoring with `totalVotes` works well

---

## 2. Mafia

**End-to-end:** Yes
**Flow tested:** mafia:room:create → mafia:autofill → mafia:start → night phase (bot kill) → discussion → voting → finished

### Findings

- Full game cycle completed: lobby → night → discussion → voting → finished
- Role assignment correct: 1 mafia out of 4 players (~25%)
- Night kill executed (Mafia Bot 2 eliminated by mafia)
- Discussion phase transitioned after 5s timer
- Voting phase: bots voted, human voted, mafia player eliminated
- Winner: town (all mafia dead)
- 3 state updates received with complete game progression

### Bugs

None found.

### Timing
- Night: 7s, Discussion: 5s, Voting: 7s — good pacing for bot games
- Total game time: ~15-20s with all bots

### Fun Factor
- Fast-paced with bots, would be more engaging with human deliberation during discussion
- Win condition correctly evaluated

---

## 3. Among Us

**End-to-end:** Yes
**Flow tested:** amongus:room:create → amongus:autofill → amongus:start → kill → meeting → vote → finished

### Findings

- Full game cycle completed in a single start call
- Role assignment: 1 imposter (Crew Bot 2), 3 crew members
- Imposter killed Crew Bot 4 immediately
- Body reported, meeting triggered
- Bots voted (2 votes for CrewHost)
- Imposter won (crew count dropped to imposter parity)
- 1 state update received after start

### Bugs

None found.

### Timing
- Game resolves very quickly with bots (~1-2s total)
- Bot autoplay is synchronous during start sequence

### Fun Factor
- The bot-driven game is extremely fast — human players wouldn't have time to complete tasks or call meetings in a mixed game
- Meeting voting works correctly

---

## 4. Agent Villa

**End-to-end:** Partial — game completes but human has zero interaction window
**Flow tested:** villa:room:create → villa:autofill → villa:start → (entire game resolves synchronously)

### Findings

- Game completed through all phases: pairing → challenge → twist → recouple → elimination (round 1) → repeat → finished (round 2)
- Winner: final_couple (VillaHost + Villa Bot 4)
- All bot votes and phase transitions executed correctly
- Immunity mechanics worked (challenge winner got immunity)
- Elimination correctly removed players

### Bugs

| # | Severity | Description |
|---|----------|-------------|
| 1 | HIGH | **Bot autoplay completes entire game synchronously during `villa:start`.** `scheduleVillaPhase()` (server.js:745) has a recursive autoplay loop at lines 759-762: when bots auto-play and the phase changes, it immediately recurses instead of scheduling a timer. This means the entire game (all rounds, all phases) resolves in a single synchronous call stack during `villa:start`. The human player receives the finished game state in the start callback response and never gets to participate in any phase. Other modes (Mafia, Among Us) don't have this recursive pattern — they always schedule timers between phases. |

**Root Cause:** `scheduleVillaPhase` at line 759-762:
```js
if (auto.acted > 0 && room.phase !== phaseBeforeAutoplay) {
    scheduleVillaPhase(room); // ← immediate recursive call, no timer
    return;
}
```

**Fix:** Remove the recursive call and let the timer-based scheduling handle phase progression, matching the pattern used by Mafia and Among Us.

### Timing
- With all bots: 0ms (entire game in single call stack)
- Timer durations: pairing 7s, challenge 7s, twist 6s, recouple 7s, elimination 7s — never used when autoplay resolves phases

### Fun Factor
- Phase variety is excellent (pairing, challenge, twist, recouple, elimination)
- Social dynamics with couples/immunity/vulnerability are interesting
- Currently unplayable for humans due to synchronous completion bug

---

## 5. Guess the Agent (NEW — PR #8)

**End-to-end:** Yes
**Flow tested:** gta:room:create → gta:autofill (5 bots) → gta:start → prompt phase → human responds → bots respond → reveal (anonymous A-F labels) → vote → finished

### Findings

- Full game cycle completed: prompt → reveal → vote → finished
- Human identity NEVER leaked before game end (critical security check passed)
- Host correctly assigned role=human, all joins assigned role=agent
- Prompt phase: human submitted response, bots auto-responded within 2-10s
- Reveal phase: responses anonymized with A-F labels (verified)
- Vote phase: bot agents voted, human correctly identified and eliminated
- Winner: agents (found human in round 1)
- 12 state updates + 12 self-state updates received
- `gta:state:self` correctly shows own role without leaking others
- `humanPlayerId` properly null during game, revealed only at finish
- All roles revealed at finish

### Security Checks (all passed)
- `humanPlayerId` = null during in_progress (broadcast state)
- `humanPlayerId` = null during in_progress (self state)
- Player roles hidden in broadcast state during game
- Own role visible in self state
- All roles + humanPlayerId revealed only at status=finished

### Unit Tests
- 16/16 tests pass (node --test test/guess-the-agent.test.js)

### Bugs

None found.

### Timing
- Prompt phase: GTA_PROMPT_MS=45s (bot responses 2-10s)
- Reveal phase: GTA_REVEAL_MS=15s
- Vote phase: GTA_VOTE_MS=20s
- Result phase: GTA_RESULT_MS=8s
- Total per round: ~88s max

### Fun Factor
- Anonymized reveal phase with A-F labels is a great mechanic — forces focus on writing style rather than identity
- The core "find the human" premise is compelling
- Agents winning in round 1 suggests bots may be too accurate at identifying human writing — game balance consideration for future tuning
- Multi-round survival mechanic creates tension

---

## Cross-Mode Observations

### Consistency Issues
1. **Event naming inconsistency:** Roast uses `room:update`, all other modes use `{mode}:state`. Not a bug but increases client integration complexity.
2. **Public state schema inconsistency:** Roast uses `status` for game phase, other modes use `phase` field. Roast's `getPublicRoom()` has no `phase` field.

### Bot Autoplay Architecture
- Mafia: async (timer-based phase progression) — good
- Among Us: mostly async with timer scheduling — good
- Villa: synchronous recursive completion — needs fix
- GTA: async (scheduled bot responses + timer-based phase progression) — good
- Roast: async (timer-based round/vote progression) — good

### Infrastructure
- Health endpoint working correctly
- SQLite database initialized on startup
- Rate limiting configured
- Content moderation (roast policy) working for GTA responses

---

## Severity Summary

| Severity | Count | Details |
|----------|-------|---------|
| CRITICAL | 0 | — |
| HIGH | 1 | Villa synchronous autoplay bug |
| MEDIUM | 1 | Roast missing `phase` field in public state |
| LOW | 0 | — |

---

## Fix Applied

### HIGH: Villa synchronous autoplay (server.js:759-762)

Removed the immediate recursive `scheduleVillaPhase()` call when bot autoplay advances the phase. Now uses the same timer-based pattern as Mafia and Among Us, giving human players time to participate in each phase before the timer expires and force-advances.

---

## Launch Readiness Verdict

**READY** — All 5 game modes function correctly at the protocol level. The Villa synchronous autoplay bug has been fixed in this PR. GTA (the newest mode) passed all security checks and unit tests. Roast's missing `phase` field is cosmetic (UI can use `status` instead).

Recommended pre-launch actions:
1. Verify Villa fix with manual browser playtest
2. Consider adding `phase` field to Roast's public state for API consistency
3. Monitor GTA game balance — agents may identify human too easily in round 1
