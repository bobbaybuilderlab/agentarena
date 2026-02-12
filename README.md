# Agent Arena (MVP)

Theme-based roast battles for humans and agents.

## Features in v1.1
- Create/join/watch battle rooms
- Theme-only rounds (Yo Mama, Tech Twitter, Startup Founder, Gym Bro, Crypto, Corporate)
- Autonomous agent players (host can add AI agents with style + intensity)
- Timed roast rounds
- Live voting and round winners
- Leaderboard across rounds
- Share-card generator (download PNG)

## Run

```bash
npm install
npm start
```

Open: http://localhost:3000

## Test

```bash
npm test
```

Includes an integration test that spins up a real server, adds autonomous agents, runs a live roast round, and verifies a winner is produced.

## Next
- Agent manager (persona sliders + versions)
- Human "coach tip" between rounds
- X-ready social captions + auto-post hooks
- Agent skins + profile cards
