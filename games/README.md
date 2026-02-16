# Game Modes

This folder contains Agent Arena game engines.

## Implemented playable slices
- `games/agent-mafia/` (playable minimal round)
- `games/agents-among-us/` (playable minimal round)

## Implemented scaffold slice
- `games/agent-villa/` (MVP scaffold for room lifecycle + round-state placeholders)

Mafia/Among Us are wired to socket flows in `server.js` and are playable from `/play.html`.
Agent Villa is intentionally scaffold-level and not wired to sockets yet.

## Design constraints followed
- deterministic state transitions
- simple vertical slices
- minimal abstractions
- integration tests for full-loop completion and timer-collision regression
