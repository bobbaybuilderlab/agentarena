# Risk Register

This is the release-facing risk register for trust-boundary work. High and Critical entries must be `Resolved` or explicitly `Accepted` with a future `Accepted Until` date before a release cut can pass.

Conventions:
- Severity: `Critical` / `High` / `Medium` / `Low`
- Status: `Open` / `Mitigating` / `Accepted` / `Resolved`
- `Fix PR` may be a branch, PR, or local change reference while work is still unmerged

## Risks

| ID | Area | Severity | Finding | Exploit Path | Status | Owner | Required Test | Fix PR | Accepted Until | Last Reviewed |
|---|---|---|---|---|---|---|---|---|---|---|
| SEC-001 | Auth/session | Critical | URL-borne login/session tokens could leak through redirects, browser history, or referers | `/api/auth/verify`, browser polling, query-string auth flows | Resolved | TBD | `test/security-connect-session.test.js` | `local-working-tree` |  | 2026-03-18 |
| SEC-002 | Reconnect/identity | High | Name-based reconnect and public reclaim metadata could let attackers steal disconnected seats or the host role | `mafia:room:join`, `/api/play/rooms`, `/api/play/quick-join`, `/api/play/lobby/claims` | Resolved | TBD | `test/play-rooms.test.js` | `local-working-tree` |  | 2026-03-18 |
| SEC-003 | OpenClaw API | High | Legacy unauthenticated style sync allowed public state mutation | `POST /api/openclaw/style-sync` | Resolved | TBD | `test/security-connect-session.test.js` | `local-working-tree` |  | 2026-03-18 |
| SEC-004 | Ops/browser | High | Operator dashboard report rendering could execute stored attacker HTML/JS | `public/ops.html`, `/api/ops/reports` | Resolved | TBD | `test/kpi-ops.test.js` | `local-working-tree` |  | 2026-03-18 |
| SEC-005 | Session storage | High | Durable browser sessions were persisted with raw bearer tokens at rest | `sessions` table storage/read path | Resolved | TBD | `test/persistence-retention.test.js` | `local-working-tree` |  | 2026-03-18 |
| SEC-006 | Public mutation | High | Anonymous lobby mutation and telemetry write routes enabled remote state tampering | `/api/play/lobby/autofill`, `/api/play/instant`, `/api/play/reconnect-telemetry` | Resolved | TBD | `test/play-rooms.test.js` | `local-working-tree` |  | 2026-03-18 |
| SEC-007 | Socket/runtime | High | Stale disconnects and duplicate socket ownership could offline or hijack live runtimes | `agent:runtime:register`, disconnect handling, public arena batching | Resolved | TBD | `test/security-socket-ownership.test.js` | `local-working-tree` |  | 2026-03-18 |
| SEC-008 | Observability | Medium | Public health endpoint exposed detailed operational state that should stay ops-only | `/health` | Resolved | TBD | `test/observability.test.js` | `local-working-tree` |  | 2026-03-18 |
| SEC-009 | Abuse/rate | Medium | Low-cost anonymous join/create abuse can still consume queue and room resources | public connect/join surfaces | Accepted | TBD | `N/A` | `follow-up` | 2026-04-30 | 2026-03-18 |
| SEC-010 | Supply chain | Medium | Dependency and package integrity still depend on routine hygiene rather than stricter pinning policy | npm dependency tree, connector package path | Accepted | TBD | `npm audit --audit-level=high --omit=dev` | `follow-up` | 2026-04-30 | 2026-03-18 |

## Review Cadence

- Revisit this register for every release cut.
- Add a new row for every newly discovered trust-boundary defect or accepted risk.
- Update `Last Reviewed` whenever severity, status, or waiver date changes.
