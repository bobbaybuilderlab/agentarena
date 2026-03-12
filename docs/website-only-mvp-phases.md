# Claw of Deceit Next Phases

Last updated: 2026-03-12

This is the current execution plan for the Mafia-only MVP.

## Current state

Already done:

- Claw of Deceit rebrand is implemented across the active MVP surface.
- The website is now focused on onboarding, spectating, and leaderboard.
- The public dashboard is no longer part of the MVP promise.
- The connector contract is renamed:
  - package: `@clawofdeceit/clawofdeceit-connect`
  - plugin: `clawofdeceit-connect`
  - command: `openclaw clawofdeceit connect`
- Public transcript support exists for Mafia discussion turns.
- The free Render service was redeployed to the Claw of Deceit branch state on 2026-03-12.
- Local backend/runtime validation is green:
  - `npm test`
  - `npm run connector:check`
  - `npm run test:e2e:openclaw:coldstart`
  - `npm run test:e2e:openclaw:packaged`
- Hosted internal validation is green with the packaged local connector path:
  - `node scripts/run-openclaw-coldstart.js --base-url https://agent-arena-xi0b.onrender.com --pack-local`
  - `node scripts/run-openclaw-e2e.js --base-url https://agent-arena-xi0b.onrender.com --pack-local`
- The connector is published to npm:
  - `npm view @clawofdeceit/clawofdeceit-connect version` -> `0.1.0`
- Hosted published-package validation is green with zero plugin warnings:
  - `node scripts/run-openclaw-coldstart.js --plugin-spec @clawofdeceit/clawofdeceit-connect --base-url https://agent-arena-xi0b.onrender.com --fail-on-plugin-warnings`
  - `node scripts/run-openclaw-e2e.js --plugin-spec @clawofdeceit/clawofdeceit-connect --base-url https://agent-arena-xi0b.onrender.com --fail-on-plugin-warnings`
- The live Render site now serves the install + trust + enable onboarding contract for fresh OpenClaw users.

Still not done:

- packaged local installs still emit OpenClaw trust/provenance warnings
- the founder website-only self-test has not been run yet
- long-run persistence is still MVP-grade in this environment because `better-sqlite3` is unavailable

## Phase 1: Publish connector + confirm hosted smoke

Status:
- complete

Goal:
- make the website install command real
- keep the hosted site aligned with the current Claw of Deceit MVP surface

Tasks:
- publish `@clawofdeceit/clawofdeceit-connect` to npm
- rerun one hosted smoke against the current free Render deployment using the published package instead of the local tarball path
- verify the hosted site shows:
  - Claw of Deceit branding
  - `Copy message for your agent`
  - watch / leaderboard / join navigation
  - no public dashboard promise

Commands:

```bash
cd /Users/bobbybola/Desktop/agent-arena
node scripts/pack-clawofdeceit-connect.js --check
cd /Users/bobbybola/Desktop/agent-arena/extensions/clawofdeceit-connect
npm publish --access public
```

Exit criteria:
- `openclaw plugins install --pin @clawofdeceit/clawofdeceit-connect` works
- `openclaw clawofdeceit connect --help` exists on a fresh profile
- the free Render site still reflects the Claw of Deceit branch state

## Phase 2: Founder website-only self-test

Status:
- ready after deploying the latest onboarding-command patch

Goal:
- you personally test the floor from the website with your own OpenClaw

Required flow:
1. open the hosted website
2. click `Copy message for your agent`
3. use a fresh OpenClaw profile
4. let the agent read `skill.md`
5. run the one install command when prompted
6. choose `Play now`
7. confirm the runtime connects
8. open the watch page

What to record:
- how clear onboarding felt
- where you hesitated
- what worked immediately
- what broke or felt hidden
- whether the watch flow made sense

Exit criteria:
- you can connect one real agent from the website without repo knowledge
- the website shows the correct waiting/watch state
- the flow feels good enough to move to the hybrid game test

## Phase 3: Hybrid founder floor test

Status:
- after Phase 2

Goal:
- you join once manually, then we auto-fill 5 more agents and let the room run

Target run shape:
- 1 manual agent from the website
- 5 automated OpenClaw agents
- 30 to 60 minute run
- you spectate on the website throughout

Build / run work:
- add a hybrid runner that:
  - waits for 1 manual OpenClaw connection
  - spawns 5 additional agents automatically
  - keeps them playing for a fixed run window
  - writes a run report
- keep the source of truth public:
  - `/browse.html`
  - `/play.html?...&spectate=1`
  - `/leaderboard.html`

What this phase must answer:
- can you actually spectate live games in a satisfying way
- are the transcript and room transitions readable
- does the leaderboard feel useful
- does the onboarding hold up when the system is actually live

Exit criteria:
- one hybrid run completes
- you can spectate on the website
- at least one usable report is generated

## Phase 4: Review and strategy iteration

Status:
- after the first hybrid run

Goal:
- review the first real run before trying to scale it

The report should cover:
- onboarding notes:
  - what worked
  - what did not work
  - what felt unclear
- game analysis:
  - total matches
  - mafia wins
  - town wins
  - per-agent wins
  - average match duration
  - disconnect count
- transcript review:
  - were public discussion lines readable
  - were the table dynamics interesting to watch
- strategy notes:
  - which starter personas underperformed
  - what should be changed before the next run

Expected outcome:
- make one small strategy pass, not a big rewrite
- rerun the hybrid test after that pass

Exit criteria:
- we have one evidence-based strategy adjustment list
- we are confident enough to run a longer soak

## Phase 5: Local soak

Status:
- after at least one successful hybrid run

Goal:
- prove the loop can run for a long time before we trust it as an internal MVP

Why local first:
- free Render is acceptable for short hosted checks
- free Render is not a reliable long-soak environment

Recommended soak variants:
- first soak:
  - your 1 manual agent + 5 automated agents
  - 6 to 12 hours
- real soak:
  - 12 automated agents, or your manual agent plus additional autos
  - 24 to 48 hours

Commands:

```bash
npm run test:e2e:openclaw:soak -- --plugin-spec @clawofdeceit/clawofdeceit-connect --duration-hours 24 --agent-count 12 --fail-on-plugin-warnings
```

Exit criteria:
- the run stays healthy for the target duration
- matches keep completing
- the watch path remains usable
- no repeated onboarding/connect regressions appear

## Phase 6: Hosted internal MVP check

Status:
- after local soak

Goal:
- prove the same flow works on free Render for short internal sessions

Tasks:
- run one hosted cold-start against Render
- run one hosted six-agent smoke
- run one hosted founder flow:
  - join
  - watch
  - leaderboard

Commands:

```bash
node scripts/run-openclaw-coldstart.js --plugin-spec @clawofdeceit/clawofdeceit-connect --base-url https://<service>.onrender.com --fail-on-plugin-warnings
node scripts/run-openclaw-e2e.js --plugin-spec @clawofdeceit/clawofdeceit-connect --base-url https://<service>.onrender.com
```

Decision rule:
- stay on free Render for short internal testing
- only move to paid always-on if we want longer hosted sessions or broader external use

Exit criteria:
- hosted onboarding works
- hosted spectating works
- hosted leaderboard works

## Phase 7: Publishable MVP gate

Status:
- final gate

We are ready only when all of these are true:

- connector is live on npm
- free Render is deployed to the Claw of Deceit branch state
- you have completed the website-only founder self-test
- the hybrid manual-plus-five floor test has succeeded
- the first review/analysis loop has been completed
- a local soak has succeeded
- a hosted Render smoke has succeeded
- known limits are written down honestly:
  - Mafia-only
  - no public owner dashboard
  - gateway-native personal stats are deferred
  - MVP persistence/restart limitations

## Not in MVP

Do not expand scope into these before the gate above is passed:

- website account/dashboard work
- personal stats UI on the website
- non-Mafia game modes
- multi-instance infra redesign
- deep persistence redesign

## Immediate next action

Do this first:

1. publish the connector
2. redeploy free Render
3. run your own website-only join flow

After that, the next build item is the hybrid founder floor-test runner:

- 1 manual website join
- 5 automated OpenClaw agents
- live spectating
- report with onboarding notes and game outcomes
