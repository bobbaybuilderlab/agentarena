# Backend Review — 2026-03-13

## Summary

The current Mafia-only MVP backend is good enough to keep building the frontend against, but it is **not done**.

The main remaining backend risks are:

1. owner/session durability silently degrades to in-memory behavior
2. production health can report healthy while durable storage is unavailable
3. stats/history silently degrade to partial in-memory data when persistence is unavailable
4. legacy auto-battle and legacy mutation APIs are still live in the production process
5. the existing backend QA worktree is useful for tests, but its report is partly stale and its outputs are only partially adopted

## Findings

### 1. High — auth and ownership degrade silently to in-memory state

The current owner-watch flow can return `ok: true` even when the durable session path is unavailable.

Evidence:
- `/api/auth/session` falls back to issuing an in-memory-only session on error instead of failing closed.
- `resolveSiteSession()` falls back to the in-memory `sessions` map when DB lookup fails.
- the in-memory session objects do not carry or enforce expiry.
- `bindOwnedAgent()` treats DB persistence as best-effort and still updates the in-memory session map.

References:
- [server.js:3146](/Users/bobbybola/Desktop/agent-arena/server.js#L3146)
- [server.js:3173](/Users/bobbybola/Desktop/agent-arena/server.js#L3173)
- [server.js:3183](/Users/bobbybola/Desktop/agent-arena/server.js#L3183)
- [server.js:2756](/Users/bobbybola/Desktop/agent-arena/server.js#L2756)
- [server.js:2778](/Users/bobbybola/Desktop/agent-arena/server.js#L2778)
- [server.js:2794](/Users/bobbybola/Desktop/agent-arena/server.js#L2794)

Why it matters:
- the product now promises owner-watch behavior tied to a site session
- on DB failure or no-DB mode, the flow still looks successful but becomes restart-volatile and process-local
- fallback sessions can also outlive their intended expiry because the in-memory path does not check expiry

### 2. High — `/health` masks missing durable storage in production

The service health endpoint reports `healthy` even when the database is `unavailable`.

Evidence:
- Render uses `/health` as the deployment health check
- `/health` maps both `ok` and `unavailable` database states to `healthy`
- the docs and new persistence work clearly treat `DATABASE_URL` as the intended durable hosted path

References:
- [render.yaml:8](/Users/bobbybola/Desktop/agent-arena/render.yaml#L8)
- [server.js:4597](/Users/bobbybola/Desktop/agent-arena/server.js#L4597)
- [server.js:4602](/Users/bobbybola/Desktop/agent-arena/server.js#L4602)
- [server.js:4607](/Users/bobbybola/Desktop/agent-arena/server.js#L4607)
- [server/db/index.js:944](/Users/bobbybola/Desktop/agent-arena/server/db/index.js#L944)

Why it matters:
- a hosted deploy can look green while user sessions, stats, and history are non-durable
- this makes the current Render health signal untrustworthy for the actual MVP promise

### 3. Medium — no-DB fallback silently serves partial stats and history

When persistence is unavailable, match data is kept only in the in-memory `completedMatchRecords` array, capped at 500 records, and several endpoints fall back to that state without clearly surfacing the limitation.

Evidence:
- completed matches are cached in memory and truncated to 500
- `/api/stats` always returns the fallback aggregate without exposing the source
- owner stats and match history also fall back to the same in-memory cache

References:
- [server.js:2203](/Users/bobbybola/Desktop/agent-arena/server.js#L2203)
- [server.js:2204](/Users/bobbybola/Desktop/agent-arena/server.js#L2204)
- [server.js:2402](/Users/bobbybola/Desktop/agent-arena/server.js#L2402)
- [server.js:2455](/Users/bobbybola/Desktop/agent-arena/server.js#L2455)
- [server.js:3495](/Users/bobbybola/Desktop/agent-arena/server.js#L3495)

Why it matters:
- after enough matches, lifetime stats become "last 500 matches in this process"
- after restart, history disappears entirely in no-DB mode
- the caller cannot reliably tell that `/api/stats` changed source or quality

### 4. Medium — legacy auto-battle and legacy mutation APIs are still in the production process

The backend still runs the older roast/auto-battle subsystem even though the product has pivoted to Mafia-only onboarding and owner-watch.

Evidence:
- seed agents are still created for the old arena mode
- `runAutoBattle()` still runs on startup and every 20 seconds unless disabled
- the current Render config does not disable it
- legacy public mutation routes remain exposed for agent creation, stub OpenClaw connection, and deploy toggling

References:
- [server.js:2690](/Users/bobbybola/Desktop/agent-arena/server.js#L2690)
- [server.js:2973](/Users/bobbybola/Desktop/agent-arena/server.js#L2973)
- [server.js:3312](/Users/bobbybola/Desktop/agent-arena/server.js#L3312)
- [server.js:3340](/Users/bobbybola/Desktop/agent-arena/server.js#L3340)
- [server.js:3358](/Users/bobbybola/Desktop/agent-arena/server.js#L3358)
- [server.js:4705](/Users/bobbybola/Desktop/agent-arena/server.js#L4705)
- [render.yaml:1](/Users/bobbybola/Desktop/agent-arena/render.yaml#L1)

Why it matters:
- extra moving parts are still mutating shared state in production
- the legacy routes expand the public write surface even though they are not the intended product path anymore
- this increases backend complexity and review cost without helping the current Mafia MVP

### 5. Medium — persistence implementation is split across incompatible patterns

The new durability work mixes two different persistence strategies:

- SQLite uses versioned migrations
- Postgres applies a whole schema file at startup
- once startup falls back to `kind: none`, the process does not retry DB initialization

References:
- [server/db/index.js:18](/Users/bobbybola/Desktop/agent-arena/server/db/index.js#L18)
- [server/db/index.js:83](/Users/bobbybola/Desktop/agent-arena/server/db/index.js#L83)
- [server/db/index.js:100](/Users/bobbybola/Desktop/agent-arena/server/db/index.js#L100)
- [server/db/index.js:118](/Users/bobbybola/Desktop/agent-arena/server/db/index.js#L118)

Why it matters:
- schema drift risk is higher because Postgres and SQLite do not share the same migration path
- transient startup DB failure leaves the process permanently degraded until restart
- this is workable for local MVP iteration, but brittle for hosted durability

### 6. Medium — the default green test signal is narrower than the backend surface we now rely on

`npm test` is currently a focused MVP subset, not a broad backend gate.

Evidence:
- `test:mvp` only runs a small set of files
- the repo now also contains `agent-mafia`, `qa-backend-edge-cases`, `kpi-ops`, `play-rooms`, and other backend-heavy suites
- the older backend QA worktree report still describes issues that have already been fixed in `main`, which means the report has decayed while the test assets remain useful

References:
- [package.json:12](/Users/bobbybola/Desktop/agent-arena/package.json#L12)
- [package.json:14](/Users/bobbybola/Desktop/agent-arena/package.json#L14)
- [QA_BACKEND_REPORT.md:25](/Users/bobbybola/Desktop/agent-arena-qa-backend-001/QA_BACKEND_REPORT.md#L25)
- [QA_BACKEND_REPORT.md:58](/Users/bobbybola/Desktop/agent-arena-qa-backend-001/QA_BACKEND_REPORT.md#L58)
- [server.js:1252](/Users/bobbybola/Desktop/agent-arena/server.js#L1252)

Why it matters:
- the default "green" status understates backend regression risk
- the `arena-qa-backend-001` worktree is still valuable mainly as test/artifact input, not as an up-to-date bug list

## Subagent / Worktree Notes

### `arena-qa-backend-001`

Still useful:
- `QA_BACKEND_REPORT.md` as historical context
- `test/qa-backend-edge-cases.test.js` as edge-case coverage inventory
- `artillery-load-test.yml` as a starting point for soak/load validation

Not current enough to trust verbatim:
- the report’s "critical bug" section is no longer source of truth
- at least the null-payload `mafia:room:create` issue is already fixed in current `main`

### Other worktrees

The other active worktrees are mostly UI, gameplay, or GTB-oriented. They do not look like the best source of truth for current Mafia backend hardening. The one backend-specific worktree worth mining was `arena-qa-backend-001`.

## Validation Notes

What I ran:
- `npm test` — passed
- `node --test test/agent-mafia.test.js` — passed
- `npm run test:full` — not usable as a validation gate in this sandbox because many tests try to open listeners and fail with `EPERM`

Interpretation:
- the focused MVP gate is currently green
- the broader backend test surface exists, but the default signal does not exercise most of it
- the repo is ready for frontend work to continue, but the backend should still be treated as needing one explicit hardening pass
