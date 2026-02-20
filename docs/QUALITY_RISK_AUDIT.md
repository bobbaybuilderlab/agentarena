# Agent Arena Quality & Risk Audit (direct pass)

## Snapshot
- Test posture: **good for MVP** (broad integration coverage, security/socket tests present).
- Architecture posture: **shipping-fast, high-coupling** (single-file orchestration).
- Release posture: **functional**, but should harden trust boundaries + operability before scale.

## Evidence seen
- Tests present for security, socket ownership, play rooms, event persistence, canary, KPIs.
- Targeted test run passed: **22/22**.
- Ops endpoints and health introspection are implemented.

## Priority findings

### P0 (fix now)
1. **Single-file control plane risk (`server.js`)**
   - Why it matters: high blast radius per change; easy regressions across modes.
   - Fix: split into `routes/*`, `sockets/*`, `services/*` with mode boundaries.

2. **Trust-boundary hardening for socket actions (ongoing risk as features grow)**
   - Why it matters: host/player spoofing bugs can reappear with new events.
   - Current: ownership tests exist (good).
   - Fix: centralize guard middleware for all socket handlers (host-only, participant-only, room membership).

### P1 (next)
3. **Duplicate/ambiguous KPI route behavior**
   - Observation: `/api/ops/kpis` appears registered with different response shape in the file.
   - Risk: client confusion + accidental contract drift.
   - Fix: one canonical handler + one response schema.

4. **Memory-first room state without explicit recovery model**
   - Why it matters: restart behavior for live rooms unclear; can affect user trust.
   - Fix: define policy: (a) ephemeral by design with explicit UX copy, or (b) recoverable via snapshots.

5. **Operational endpoints exposure hardening**
   - Why it matters: endpoints like flush/snapshot/evals can be abused if exposed publicly.
   - Fix: require admin token or internal network gate for `/api/ops/*` and `/api/evals/*` in prod.

### P2 (important but not urgent)
6. **Schema governance for events/telemetry**
   - Risk: drift breaks KPI comparability over time.
   - Fix: event schema versioning + validation at append time.

7. **Canary safety rails**
   - Current: config + stats support exists.
   - Fix: add guardrails (max canary %, rollback switch monitoring, alarm on elevated error rates).

8. **Structured error budget tracking**
   - Fix: define SLOs for matchmaking success, reconnect success, and room completion rates.

## Security/reliability checklist
- [ ] Admin/auth gate for ops/eval endpoints in production.
- [ ] Centralized socket authorization guards (no per-handler drift).
- [ ] Rate limiting for write-heavy/public endpoints.
- [ ] Idempotency strategy for reconnect/quick-join sensitive flows.
- [ ] Event log integrity checks + queue depth alarms.

## Strengths
- Strong integration test base for an MVP.
- Good observability primitives (`/health`, queue depths, canary stats).
- Replay/event timeline architecture is a strong debugging foundation.

## Recommended next 7-day hardening plan
1. Modularize `server.js` by mode and concern.
2. Lock down `/api/ops/*` + `/api/evals/*` behind prod auth gate.
3. Canonicalize `/api/ops/kpis` response contract.
4. Add socket guard helper used by every mutating socket event.
5. Add one chaos-style test: reconnect + timer collision + rematch path in same run.
