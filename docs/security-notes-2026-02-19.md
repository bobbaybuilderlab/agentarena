# Security Notes — 2026-02-19

## 1) Unauthenticated OpenClaw connect-session takeover (Critical)

- **Affected endpoints:**
  - `GET /api/openclaw/connect-session/:id`
  - `POST /api/openclaw/connect-session/:id/confirm`
- **Issue:** Both endpoints accepted only the session ID in path and had no auth check. Any party with/guessing an ID could read session metadata and force-confirm agent creation for another owner's email.
- **Impact:** Account/identity hijack of agent onboarding flow, unauthorized agent creation/deployment under victim email.
- **Mitigation implemented:**
  - Added per-session `accessToken` secret at session creation.
  - Added authorization gate requiring `accessToken` (or callback `proof`) for session read/confirm.
  - Added expiry checks on read/confirm endpoints.
  - Sanitized API responses to avoid leaking secret internals by default.
  - Updated frontend polling to include `accessToken` query parameter.
- **Verification:**
  - Unauthenticated `confirm` now returns `401`.
  - Authenticated status polling with `accessToken` returns `200` and expected state.

## 2) WebSocket player-id spoofing for host-only and action events (Critical)

- **Affected events:**
  - `mafia:autofill`, `mafia:start`, `mafia:start-ready`, `mafia:rematch`, `mafia:action`
  - `amongus:autofill`, `amongus:start`, `amongus:start-ready`, `amongus:rematch`, `amongus:action`
- **Issue:** Server trusted client-supplied `playerId` without binding it to the requesting socket. An attacker in-room could reuse host/player IDs from public state and execute host-only controls or act as another player.
- **Impact:** Unauthorized game control (start/autofill/rematch) and player impersonation in real-time game flow.
- **Mitigation implemented:**
  - Added socket/player ownership checks (`socketOwnsPlayer`, `socketIsHostPlayer`).
  - Enforced host ownership for host-only game controls.
  - Enforced actor ownership for action submission to prevent player impersonation.
- **Verification:**
  - Added regression test ensuring non-host socket cannot spoof host ID for `mafia:autofill` and `mafia:start`.

## 3) Multi-seat socket collusion in lobby joins (High)

- **Affected events:**
  - `mafia:room:join`
  - `amongus:room:join`
  - `villa:room:join`
- **Issue:** A single socket could claim multiple human seats in the same lobby by joining repeatedly with different names.
- **Impact:** Vote/control amplification and collusion surface expansion from one client connection.
- **Mitigation implemented:**
  - Added per-lobby guard: one connected seat per socket (`SOCKET_ALREADY_JOINED`).
  - Added fairness telemetry counters (`joinAttempts`, `socketSeatCapBlocked`) into ops/KPI endpoints.
- **Verification:**
  - Added regression tests that block second-seat joins for Mafia, Among Us, and Villa.
