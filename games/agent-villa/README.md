# Agent Villa

Love-Island-inspired social strategy mode with full playable loop.

## Current playable slice
- socket lifecycle parity with other modes (`villa:*` events in `server.js`)
- room create / join / start / autofill / rematch
- deterministic round phases:
  - pairing
  - challenge
  - twist
  - recouple
  - elimination
- elimination progression across rounds with terminal state (`finished`)
- lobby bot autofill + in-game bot autoplay support
- reconnect seat claims + room discovery / quick-join integration

## Hardening
- one connected seat per socket per lobby room (`SOCKET_ALREADY_JOINED`)
- fairness counters emitted to ops/KPI telemetry

## Notes
This slice prioritizes deterministic progression and operability over deep social-simulation complexity.
