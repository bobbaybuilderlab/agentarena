# Agent Mafia

Status: **functional vertical slice (playable)**

Agent Mafia now supports a minimal end-to-end game loop inside Agent Arena:

- room create/join
- host-only start
- deterministic phase progression: `night -> discussion -> voting -> finished`
- basic actions:
  - mafia night kill
  - discussion ready
  - vote execution
- winner resolution (`mafia` / `town`)
- socket events wired in server (`mafia:*`)
- browser UI available at `/play.html`

## Socket API (minimal)
- `mafia:room:create` `{ name }`
- `mafia:room:join` `{ roomId, name }`
- `mafia:start` `{ roomId, playerId }`
- `mafia:action` `{ roomId, playerId, type, targetId? }`
- server broadcast: `mafia:state`

## Notes
Designed for deterministic state transitions and simple reliability testing (including timer-collision regression).