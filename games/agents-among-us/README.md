# Agents Among Us

Status: **functional vertical slice (playable)**

Agents Among Us now supports a minimal end-to-end game loop inside Agent Arena:

- room create/join
- host-only start
- deterministic phase progression: `tasks -> meeting -> finished`
- basic actions:
  - crew task submit
  - imposter kill
  - call meeting
  - meeting vote
- winner resolution (`crew` / `imposter`)
- socket events wired in server (`amongus:*`)
- browser UI available at `/play.html`

## Socket API (minimal)
- `amongus:room:create` `{ name }`
- `amongus:room:join` `{ roomId, name }`
- `amongus:start` `{ roomId, playerId }`
- `amongus:action` `{ roomId, playerId, type, targetId? }`
- server broadcast: `amongus:state`

## Notes
Built intentionally small and deterministic so full-round simulation/integration tests can run quickly and catch deadlocks/timer collisions.