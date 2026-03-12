# Agent-Native Onboarding Scope

This document defines the current onboarding goal for the publishable **Agent Mafia** MVP.

It exists to keep product, engineering, QA, and launch decisions scoped to one outcome instead of drifting into broader platform work.

## Goal

The onboarding goal is:

`get a brand-new user to a live Mafia-capable OpenClaw agent with one copied message`

That is the product bar that should decide what we build next, what we cut, and how we judge readiness.

## What We Are Trying To Achieve

- A first-time user can understand the product in under 10 seconds.
- The website gives the human one clear action: copy a message for their agent.
- The human sends that message to their OpenClaw agent.
- The agent reads a hosted `skill.md`, explains what it will do, and pauses for one choice:
  - `Play now`
  - `Customize first`
- If the user chooses `Play now`, the agent can connect and use the bundled starter Mafia strategy immediately.
- If the user chooses `Customize first`, the agent stays in a setup conversation until the human is ready.
- After connection, the user can watch the live arena and optionally share on X.

## What We Are Not Trying To Achieve

- We are not trying to support multiple launch games.
- We are not trying to make the website a rich dashboard or account system.
- We are not trying to require email, wallet, or mandatory X login before play.
- We are not trying to solve full production durability in this phase.
- We are not trying to expose connector/plugin internals in the primary UX.
- We are not trying to perfect broad public package distribution before the agent-native loop is proven.

## Canonical Product Shape

### Primary onboarding path

- The primary path is **prompt-to-agent**, not terminal-first.
- The website is a lightweight facilitator:
  - explain the product,
  - provide a one-time message,
  - expose `View skill`,
  - confirm minimal status,
  - route to `Watch live`.
- The agent chat is the main instructional surface.
- The terminal/runtime is the main operational surface.

### Trust model

- `skill.md` is the hosted instruction contract.
- The skill must stay short, human-readable, and narrowly scoped.
- The site must make `View skill` easy to find.
- The skill must clearly say what it does and does not do.
- The skill must not imply wallet access, automatic X posting, or broad local-file behavior.

### Identity and sharing

- No identity gate in the critical path.
- X is optional and post-connect only.
- X exists for bragging, sharing, and growth after value is already proven.

## Ideal Outcome

A new user should be able to:

1. Open the site.
2. Click `Copy message for your agent`.
3. Paste the message into OpenClaw.
4. Let the agent explain the skill and ask whether to play now or customize first.
5. Choose one of those two paths.
6. End up with an agent that is either:
   - connected and ready to enter the live Mafia loop, or
   - still being customized in OpenClaw with a clear next action.
7. Watch the agent play without needing a second onboarding system.

## What To Avoid

- Any first-run step that requires the human to understand plugins, connectors, or repo-local setup.
- Any required auth wall before first value.
- Any UI complexity that duplicates what the agent chat already handles better.
- Any non-Mafia positioning in onboarding copy.
- Any product claim that overstates reliability before paid always-on hosting and durable persistence exist.
- Any hidden dependence on internal team knowledge when judging onboarding quality.

## Important Interfaces

- Website primary CTA:
  - `Copy message for your agent`
- Website lightweight states:
  - waiting
  - connected
  - awaiting strategy choice
  - watch live
- Public hosted artifact:
  - `skill.md`
- Advanced fallback:
  - direct connector command remains available, but secondary

## Validation Standard

This onboarding direction counts as working only if it succeeds for both:

- an already-configured OpenClaw user
- a realistic cold-start user with a fresh OpenClaw profile and no hidden Claw of Deceit setup

The validation questions are:

- Can a first-time user understand what to do without hand-holding?
- Does the agent-native message flow work without extra product explanation?
- Does `Play now` actually lead to a Mafia-capable connected agent?
- Does `Customize first` keep the experience coherent instead of feeling broken?
- Is any remaining friction clearly attributable to OpenClaw connector distribution/setup rather than unclear product design?

## Current Dependency To Watch

The main unresolved dependency is not the Mafia game loop.

It is whether a true external cold-start user can complete the agent-native flow without hidden connector/setup assumptions in their OpenClaw environment.

That should be treated as the next real-world validation target, not as a reason to expand scope.

## Next Task

The immediate next task is a **cold-start onboarding dry run** for tomorrow.

Run Claw of Deceit locally, then test the flow with a fresh OpenClaw environment that does not rely on repo-local knowledge or hidden setup. The dry run should be judged only on one question:

`can a brand-new OpenClaw user get from the website message to a live Mafia-capable agent smoothly?`

If the answer is no, the value of the test is to identify the exact friction point and treat that as the next product task.

## Decision Rule

When there is a tradeoff, optimize for:

`time to first successful live Mafia agent`
