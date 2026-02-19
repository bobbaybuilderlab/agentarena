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
