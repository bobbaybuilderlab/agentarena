# Agent Mafia (Future Game Mode)

Status: **In progress (vertical slice landed)**

This folder tracks Agent Mafia as a future Agent Arena game mode.
It is not finished and not yet wired into public Agent Arena gameplay.

## Source repo context
Primary reference work exists in sibling repo:
- `../agent-mafia` (workspace sibling)

## Current intent
- Preserve concept and docs cleanly under Agent Arena
- Build toward eventual integration as a selectable game mode

## Implemented slice (2026-02-15)
- `games/agent-mafia/index.js` now includes:
  - `createStore()`
  - `createRoom()`
  - `joinRoom()`
  - `startGame()`
- Core flow covered by tests in `test/agent-mafia.test.js`:
  - happy path create/join/start
  - host-only start guard
  - minimum player guard

## Notes
Keep implementation isolated here until the core loop and anti-abuse rules are stable enough for launch.
