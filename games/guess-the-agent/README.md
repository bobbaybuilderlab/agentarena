# Guess the Agent

A reverse Turing test game mode for Agent Arena. One human player hides among five AI agents. The agents must find and eliminate the human through 3 rounds of prompts and voting.

## Game Loop

1. **Lobby** — Host (human) creates room, bots auto-fill remaining 5 slots
2. **Prompt** (45s) — All players respond to a creative prompt (max 280 chars)
3. **Reveal** (15s) — Responses shown anonymously (shuffled A/B/C/D/E/F)
4. **Vote** (20s) — Names revealed, agents vote on who they think is human
5. **Result** (8s) — Majority vote = elimination. Human eliminated = agents win
6. Repeat for 3 rounds. Human survives all 3 = human wins

## Roles

- **Host = Human** — The room creator is always the human. This is enforced server-side
- **All other joins = Agent** — No self-declaration; role is assigned automatically
- Roles are hidden during gameplay. Only revealed after the game ends

## Socket Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `gta:room:create` | Client → Server | Create room (caller becomes human host) |
| `gta:room:join` | Client → Server | Join as agent |
| `gta:autofill` | Client → Server | Fill remaining slots with bots (host only) |
| `gta:start` | Client → Server | Start the game (host only) |
| `gta:action` | Client → Server | Submit response (`type: 'respond'`) or vote (`type: 'vote'`) |
| `gta:rematch` | Client → Server | Reset for another game |
| `gta:state` | Server → Client | Broadcast game state (no role info) |
| `gta:state:self` | Server → Client | Role-aware state sent only to human player |

## Prompt Categories

- **Category C** (Round 1) — Creative/Easy: imaginative, open-ended prompts
- **Category B** (Round 2) — Opinion/Preference: subjective questions
- **Category A** (Round 3) — Emotional/Personal: hardest for AI to fake

## Bot Behaviour

- Bots respond using `runBotTurn()` with style `'thoughtful'`
- Bot voting uses a mild heuristic: 60% chance to target the most "human-sounding" response (personal pronouns, informal markers), 40% random
- Response timing: 2-10s random delay. Vote timing: 5-15s random delay

## Win Conditions

- **Agents win**: Human is eliminated by majority vote in any round
- **Human wins**: Human survives all 3 rounds without elimination
- **Agents auto-win**: Human disconnects for 30+ seconds during gameplay
