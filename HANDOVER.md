# Claw of Deceit Handover

Last updated: 2026-03-13

## Current Checkpoint — 2026-03-13 Backend Trim

This repo is now at a clear **Mafia-only checkpoint**.

What changed in the current working state:

- the active backend/runtime surface was trimmed down toward Mafia-only
- non-Mafia game modes were removed from the live architecture path:
  - `agent-villa`
  - `agents-among-us`
  - `guess-the-agent`
- legacy roast / auto-battle / canary / eval endpoints were removed from the active backend surface
- `/health` now fails closed in production when durable storage is unavailable
- auth/session responses now expose durability and expiry metadata
- stats and match history responses now expose whether they are coming from durable storage or capped in-memory fallback
- the test surface was simplified to focus on the current Mafia MVP instead of legacy modes

This means the repo is no longer in the phase of proving "can agents play a game at all?"

The backend question is now narrower:

`is the Mafia-only hosted runtime operationally honest, durable enough for owner-watch, and small enough to maintain cleanly while frontend work continues?`

### What is done

- Mafia is the only intended supported game mode for the current MVP.
- The live backend contract is being narrowed to match that scope.
- The founder dry run already proved the published connector path can connect a fresh agent to the hosted runtime.
- The backend review for this phase has been written in:
  - `docs/backend-review-2026-03-13.md`

### What is still not finished

- `server.js` still contains legacy helper code that is now effectively dead and should be deleted in a follow-up trim pass.
- owner/session durability still degrades to in-memory fallback instead of failing closed when the database is unavailable.
- stats/history still have an intentional capped in-memory fallback path for no-DB mode.
- the persistence layer still uses split strategies:
  - SQLite-style migrations
  - Postgres schema bootstrap
- the default green test signal is still narrower than the full backend surface we now rely on.

### Recommended next backend pass

1. Finish deleting dead non-Mafia helper code from `server.js` so the process shape matches the product scope.
2. Decide whether hosted auth/session flows are allowed to fall back to memory at all. If not, fail closed when `DATABASE_URL` is unavailable.
3. Unify the persistence path:
   - either make Postgres the only hosted truth and demote SQLite/local fallback explicitly
   - or put both backends on one migration model
4. Expand the default backend gate so current Mafia-only runtime coverage is part of the standard pre-push signal.
5. After the cleanup/hardening pass, run:
   - blind external human onboarding test
   - hybrid founder floor test: 1 manual agent + 5 automated agents

### Verification snapshot for this checkpoint

- `node --check server.js`
- `node --check public/app.js`
- `node --check public/games.js`
- `npm test`

Broader direct `node --test` coverage is still useful, but `npm run test:full` has been unreliable in the sandbox because some runs hit listener permission errors under script orchestration.

## Dashboard Reality Check

### What "connect your agent" means today

In the current implementation, the website dashboard does **not** connect to OpenClaw directly.

What actually happens is:

1. the user connects through the OpenClaw connect-session flow
2. the browser polls `/api/openclaw/connect-session/:id`
3. when that session becomes `connected`, the frontend stores `clawofdeceit_agent_id` in browser `localStorage` (with a legacy fallback read from `agentarena_agent_id`)
4. the dashboard reads that one stored `agentId`
5. the dashboard fetches:
   - `/api/agents/:id`
   - `/api/matches?userId=<agentId>`
   - `/api/leaderboard`

So the dashboard is currently:

- browser-local
- single-agent
- tied to "the last agent this browser connected"
- not tied to a durable owner account
- not designed for rotating across multiple OpenClaw setups or multiple gateways

### What this means for users

The current public wording can be misleading.

When the site says `Connect your agent`, many users will reasonably infer:

- they can attach their OpenClaw identity to the website itself
- they can come back later from another device and still see the same agent
- they can switch between multiple agents they own
- the dashboard is their main owner control surface

That is **not** what the current product does.

Today the real source of truth is:

- OpenClaw handles connection
- the runtime stays alive in OpenClaw
- the website mostly watches and reflects state

The dashboard is only a lightweight review page for the last connected agent in that browser.

### Gateway-native stats reality

The product direction already says the website should be thin and OpenClaw/gateway should be primary.

That matches the code more than the current dashboard copy does.

Right now:

- the connector prints watch and leaderboard URLs after connect
- the connector prints runtime status like queue state and live room changes
- the backend already exposes enough data for richer stats:
  - `/api/agents/:id`
  - `/api/matches?userId=<agentId>`
  - `/api/leaderboard`
  - `/api/matches/mine` exists as an auth-shaped primitive

What does **not** exist yet:

- a real gateway-native `stats` command
- owner-scoped multi-agent stats
- a website flow for switching between multiple owned agents
- a durable "my agents" model that works across browsers/devices

## MVP Recommendation

### Recommendation

For the publishable Mafia MVP, do **not** treat the dashboard as a core product promise.

The clean MVP should be:

- website:
  - understand the product
  - `Join the game`
  - `Copy message for your agent`
  - `Watch live`
  - maybe public leaderboard
- OpenClaw / gateway:
  - connect
  - stay online
  - customize strategy
  - eventually see owner stats

### What to cut or demote now

- Do not make the dashboard central to onboarding.
- Do not imply the website is where users "connect" ownership.
- Do not build multi-agent website account flows before the basic onboarding loop is proven.
- Do not let `Dashboard` become a required concept for first successful play.

### What to say instead

If we keep the page for now, it should be described much more narrowly:

`This page shows the last agent this browser connected. Use OpenClaw as the main control surface.`

But the stronger MVP move is:

- remove or demote public dashboard mentions from the main join flow
- keep the page as secondary/internal review UI
- focus public language on:
  - connect in OpenClaw
  - watch on the website

## Product Decision Suggested

The most coherent MVP decision is:

`no public dashboard as a core promise`

More concretely:

- keep the website focused on joining and spectating
- keep leaderboard public if useful
- move owner stats and agent management toward the gateway path later
- only revive a serious website dashboard once there is a real owner identity and multi-agent model

## If Dashboard Survives Later

If we want a real dashboard later, it should be rebuilt around owner identity, not browser local state.

That later version would need:

- owner-scoped auth or owner session
- a `my agents` list
- explicit agent switching
- cross-browser persistence
- gateway + website parity for stats and history

Until then, the current dashboard should be treated as:

`secondary review UI for one locally remembered agent`

## Current State

- Launch scope is one game only: `Agent Mafia`.
- The core game/runtime loop is working locally.
- The current product question is no longer "can agents play Mafia?".
- The current product question is:

`can a brand-new OpenClaw user onboard to Claw of Deceit in one click / one message / under 10 seconds without hidden setup knowledge?`

## Verification Snapshot

- On 2026-03-12, `npm test` passed locally.
- On 2026-03-12, `npm run test:e2e:openclaw:coldstart` passed locally with a fresh `HOME` plus the packaged local tarball path.
- On 2026-03-12, `npm run test:e2e:openclaw:packaged` passed locally and finished live Mafia matches.
- On 2026-03-12, `npm view @clawofdeceit/clawofdeceit-connect version` returned `0.1.0`, confirming the public package publish.
- On 2026-03-12, `node scripts/run-openclaw-coldstart.js --base-url https://agent-arena-xi0b.onrender.com --pack-local` passed against the free Render deployment.
- On 2026-03-12, `node scripts/run-openclaw-e2e.js --base-url https://agent-arena-xi0b.onrender.com --pack-local` passed after the runner was updated to fall back to public match history when the admin-only baseline endpoint is unavailable.
- That local packaged path still emits OpenClaw trust/provenance warnings because the tarball is treated as untracked local code. This is acceptable for internal validation, but not the final public distribution path.
- On 2026-03-12, `node scripts/run-openclaw-coldstart.js --plugin-spec @clawofdeceit/clawofdeceit-connect --base-url https://agent-arena-xi0b.onrender.com --fail-on-plugin-warnings` passed against the published npm package with `pluginWarningCount: 0`.
- On 2026-03-12, `node scripts/run-openclaw-e2e.js --plugin-spec @clawofdeceit/clawofdeceit-connect --base-url https://agent-arena-xi0b.onrender.com --fail-on-plugin-warnings` passed against the published npm package with six agents and `Plugin warning count: 0`.
- Earlier on 2026-03-12, the free Render site was redeployed to the Claw of Deceit branch state.
- On 2026-03-13, the hosted founder dry run passed with a fresh `HOME` via `node scripts/run-openclaw-coldstart.js --plugin-spec @clawofdeceit/clawofdeceit-connect --base-url https://agent-arena-xi0b.onrender.com --fail-on-plugin-warnings --home /tmp/claw-dryrun-20260313 --profile founder-dryrun --agent founder_dryrun`; the run reported `queueStatus: idle`, `connectedAgents: 1`, `missingAgents: 5`, and `pluginWarningCount: 0`.
- On 2026-03-13, the hosted `guide.html` and `skill.md` were manually checked and still matched the one-message onboarding contract plus the public install fallback.

## What Is Implemented

### Product direction

- Onboarding is now **agent-native**.
- The main website action is `Copy message for your agent`.
- The site exposes a hosted `skill.md` and a lightweight trust path via `View skill`.
- X is optional and post-connect only.
- The website is intentionally lean and should not become a heavy dashboard for onboarding.

### Runtime and game loop

- OpenClaw agents can complete the secure connect-session + callback flow.
- Runtime-connected agents register over Socket.IO and enter the live Mafia queue.
- The server auto-seats agents into Mafia matches and the match loop completes.
- Watch/live paths and basic history are in place.
- The bundled starter Mafia strategy now supports a real `Play now` path.

### Docs and source of truth

- Canonical onboarding scope: `docs/agent-native-onboarding-scope.md`
- Launch phase and cuts: `docs/launch-roadmap.md`
- Cloud state and infra limits: `docs/mafia-cloud-state.md`
- Product direction: `docs/product-direction-openclaw-led.md`

## What Has Been Proven

- The local Mafia MVP test gate passes.
- The backend/runtime loop is working.
- The agent-native website/message/skill flow is implemented in the product surface.
- A fresh-profile local cold-start can install the packaged local connector artifact, connect, and report online against a clean local Claw of Deceit runtime.
- The hosted Render deployment can accept fresh packaged runtimes, open live Mafia rooms, and finish matches.
- The published npm package path now works end-to-end with zero plugin warnings in the automated hosted cold-start and six-agent smoke gates.
- A founder-run hosted fresh-profile dry run can reach a connected runtime from the live website contract plus the published npm package, with the watch API reflecting the expected waiting state.

## What Has Not Been Proven Yet

- A true blind external human dry run where a fresh OpenClaw user starts from the public website and succeeds without repo knowledge.

That is now the main unresolved task.

## Next Task

Run a **blind external human cold-start onboarding dry run** from the public website using the live published connector flow.

### Goal

Prove or falsify:

`a brand-new OpenClaw user can onboard to Claw of Deceit from the hosted website message plus the published install command alone`

### Test setup

- Run the hosted Claw of Deceit site as the product under test.
- Use a fresh OpenClaw profile or fresh `HOME`.
- Prefer a separate macOS user if available for stronger isolation.
- The OpenClaw instance should only rely on:
  - its own folder/state
  - the website
  - the copied onboarding message
- Do not let the dry run depend on repo knowledge, hidden config, or manual internal steps.

### What to observe

- Can the user understand the site immediately?
- Can the user copy the message and send it to the agent without confusion?
- Can the agent read `skill.md` and explain the next step coherently?
- Does `Play now` lead toward a real connected Mafia-capable agent?
- Does `Customize first` stay coherent?
- If the flow fails, where exactly does it fail?

### Pass / fail bar

Pass:
- a fresh OpenClaw user can make meaningful progress from the website message alone, ideally all the way to a connected or clearly-connecting agent

Fail:
- the user needs hidden setup knowledge
- the agent cannot complete or meaningfully advance the flow
- the experience depends on repo-local assumptions

### Most likely useful outcome

Even a failure is useful if it clearly identifies the real bottleneck:
- unclear website message
- unclear `skill.md`
- missing OpenClaw capability
- missing packaging/distribution
- hidden setup assumptions

## Important Current Truth

The game itself is not the main blocker right now.

The main blocker is public distribution plus onboarding smoothness for a true new user.

That means the next work should stay tightly focused on:
- npm publish / public installability
- hosted cold-start validation
- friction discovery
- reducing onboarding setup burden

## Remaining Production Gaps

Beyond the onboarding dry run, the main gaps before production are:

- paid always-on hosting instead of free Render
- less restart-sensitive live state and clearer recovery behavior
- durable persistence for critical match and operational state
- simpler connector/setup distribution if the cold-start test exposes setup friction
- basic production ops hardening:
  - deploy smoke checks
  - restart/reconnect runbook
  - health/log review for disconnects and queue health
- honest public-beta positioning so we do not over-promise reliability before those pieces are in place

## Production Sequence

The intended order remains:

1. publish `@clawofdeceit/clawofdeceit-connect`
2. prove hosted cold-start onboarding with a fresh OpenClaw user
3. move to one paid always-on Render service
4. fix any connector/setup friction exposed by the dry run
5. add basic production runbook and smoke checks
6. improve durability and persistence before calling the service production-ready

## What To Avoid Next

- Expanding scope into non-Mafia work
- Building extra dashboard/account complexity
- Treating the website as the main operational UI
- Declaring onboarding solved before the published-package human dry run is complete
