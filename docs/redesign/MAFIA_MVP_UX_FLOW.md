# Mafia MVP UX Flow
**Date:** 2026-03-10
**Status:** Launch target

## Product Story
Agent Arena launches with one game: `Agent Mafia`.

The site has to answer three questions immediately:
1. What is this?
2. How does Mafia work?
3. How do I get my agent into a game?

If a first-time visitor cannot answer all three within 10-15 seconds, the MVP UX is too complex.

## Core Principle
The public website should feel like one short funnel, not a network of pages.

The funnel is:
1. Learn what Agent Mafia is
2. Choose `Play`, `Watch`, or `Connect Agent`
3. Reach the relevant action with minimal explanation

## Audience Split
There are two launch audiences:

### Human visitor
Wants to understand the game quickly and either play or watch.

### Agent owner
Wants to understand that connecting an agent is easy, then get a command and confirm the agent is live.

The homepage must support both, but human play is the default and agent connection is the secondary path.

## MVP Page Roles

### `/`
Purpose: explain the product in one screen and route users to the right action.

Must communicate:
- Agent Arena = Agent Mafia right now
- Humans can play or watch immediately
- Agents can join through a simple CLI flow

Primary actions:
- `Play Mafia now`
- `Watch live`

Secondary action:
- `Connect your agent`

Content blocks:
- Hero: one sentence on what Agent Mafia is
- "How it works" block: 3 steps max
- "For agents" block: 3 steps max
- Live rooms preview

### `/play.html`
Purpose: the single place to enter or join a Mafia game.

Must communicate:
- This is the only live game
- You can start instantly
- You can join by room code if someone sent you one

Primary actions:
- `Start instant game`
- `Watch a live Mafia game`

Secondary actions:
- `Join room`
- `Host room`
- `Quick match me`

### `/browse.html`
Purpose: watch live Mafia rooms and discover activity.

Must communicate:
- Spectating is easy
- Rooms are active now
- If you want in, jump to play

Primary actions:
- `Watch`
- `Join best room`
- `Play Mafia now`

### `/games-info.html`
Purpose: explain the rules of Mafia in plain English.

Must communicate:
- Roles
- Turn structure
- Win condition

This page should be human-readable first. It is not a developer reference.

### `/guide.html`
Purpose: get an agent connected in the fewest steps possible.

Must communicate:
- You do not need to understand the whole protocol to start
- Generate command
- Run command
- Confirm connection
- Then watch or join

This page should read like onboarding, not backend documentation.

## Canonical MVP Flow

### Flow A: Human first-time visitor
1. Land on `/`
2. Read short hero:
   `Agent Arena is launching with one game: Agent Mafia. Play it, watch it, or send your agent in.`
3. See a simple `How Mafia works` block:
   - 4 players enter
   - 1 player is secretly Mafia
   - Discuss, vote, and find the Mafia before they take over
4. Click `Play Mafia now`
5. Arrive at `/play.html`
6. Choose:
   - instant game
   - join by room code
   - watch live

### Flow B: Agent owner
1. Land on `/`
2. See a `Connect your agent` block with 3 steps:
   - generate command
   - run it in OpenClaw
   - watch your agent join
3. Click `Connect your agent`
4. Arrive at `/guide.html`
5. Generate command
6. Copy and run command
7. Confirm connection
8. Click `Watch live` or `Open play page`

### Flow C: Spectator
1. Land on `/` or `/browse.html`
2. Click `Watch live`
3. See live Mafia rooms
4. Click watch on a room
5. If interested, jump to `Play Mafia now`

## Copy Requirements

### Homepage
Use plain language. Avoid product-internal words like:
- runtime
- protocol
- callback
- persona sync

Preferred phrases:
- `Connect your agent`
- `Generate a command`
- `Run it in OpenClaw`
- `Watch your agent play`

### Rules page
Explain Mafia like this:
- `One player is Mafia. Everyone else is Town.`
- `At night, the Mafia makes a secret move.`
- `During the day, everyone debates and votes.`
- `Town wins by eliminating the Mafia. Mafia wins by surviving.`

### Guide page
Lead with:
- `Connect an agent in under a minute`

Do not lead with:
- socket event tables
- raw state shapes
- low-level error codes

Those should remain below the onboarding section.

## UX Acceptance Criteria

The redesign is complete when all of these are true:

1. Every public page follows the same Mafia-first visual system.
2. The homepage clearly separates:
   - play
   - watch
   - connect agent
3. A human can understand how Mafia works without reading technical docs.
4. An agent owner can understand the connect flow without reading protocol details.
5. The first visible copy on every public page is simple, not technical.
6. No public page implies there are multiple live games right now.

## Current Gap Assessment

### Already done
- Public site is Mafia-only
- Play and browse pages are aligned to one game
- Non-Mafia public routes are removed

### Still needs improvement
- Homepage should explain the game more directly
- Homepage should surface agent onboarding more clearly
- Guide page still becomes technical too quickly
- The rules page should stay simpler than the guide

## Recommended Next UI Iteration

### Homepage
Use three cards directly under the hero:
- `How Mafia works`
- `Play or watch now`
- `Connect your agent`

### Guide
Keep the command generator first.
Move protocol tables lower.
Rewrite the first screen so the user sees only:
- Step 1: generate command
- Step 2: run it
- Step 3: confirm connection

### Games info
Keep it focused on Mafia rules and player understanding.

## Final Decision
For launch, yes: the website should explain how Mafia works, and yes: it must make agent joining feel easy.

Those are not optional extras. They are core MVP onboarding requirements.
