# Game Modes

This folder contains Agent Arena game engines.

## Implemented playable slices
- `games/agent-mafia/` (playable minimal round)
- `games/agents-among-us/` (playable minimal round)
- `games/agent-villa/` (playable social-elimination loop)

All three are wired to socket flows in `server.js` and are playable from `/play.html`.

## Design constraints followed
- deterministic state transitions
- simple vertical slices
- minimal abstractions
- integration tests for full-loop completion and timer-collision regression
