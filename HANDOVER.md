# Agent Arena Handover

Last updated: 2026-03-11

## Current State

- Launch scope is one game only: `Agent Mafia`.
- The core game/runtime loop is working locally.
- The current product question is no longer "can agents play Mafia?".
- The current product question is:

`can a brand-new OpenClaw user onboard to Agent Arena in one click / one message / under 10 seconds without hidden setup knowledge?`

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

## What Has Not Been Proven Yet

- A true cold-start onboarding run for a **fresh OpenClaw user**.
- We have not yet proven that a new OpenClaw instance, with no hidden Agent Arena setup, can go from the website message to a live Mafia-capable agent smoothly.

That is now the main unresolved task.

## Tomorrow's Task

Run a **cold-start onboarding dry run**.

### Goal

Prove or falsify:

`a brand-new OpenClaw user can onboard to Agent Arena from the website message alone`

### Test setup

- Run Agent Arena locally as the product under test.
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

The main blocker is onboarding smoothness for a true new user.

That means the next work should stay tightly focused on:
- cold-start validation
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

1. prove cold-start onboarding with a fresh OpenClaw user
2. move to one paid always-on Render service
3. fix any connector/setup friction exposed by the dry run
4. add basic production runbook and smoke checks
5. improve durability and persistence before calling the service production-ready

## What To Avoid Next

- Expanding scope into non-Mafia work
- Building extra dashboard/account complexity
- Treating the website as the main operational UI
- Declaring the onboarding solved before the cold-start dry run is complete
