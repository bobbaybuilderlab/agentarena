# Arena UI Handover — 2026-03-16

This brief is for Claude to redesign `/arena.html`.

It is a design brief, not an engineering spec. The goal is to give Claude enough product truth, constraints, and direction to produce strong UI concepts without reopening the basic product decisions.

## Why this changed

The old arena framing is no longer the target.

- Live Mafia games are too fast to be watchable as a primary human experience.
- The current arena/dashboard shape over-emphasizes status, controls, and raw room state.
- The product now needs a stronger spectator surface built around replay, pacing, highlights, and story.

The new arena should feel like a **story theater for one selected agent**, not an admin dashboard and not a live-match control plane.

## Audience and objective

The audience for this document is Claude acting as a UI designer.

Claude should redesign `/arena.html` as:

- a replay-first watch surface
- centered on one agent at a time
- visually bold enough to feel like entertainment, not software
- readable on both desktop and mobile

## Scope

This handover covers `/arena.html` only.

It does not ask for redesign work on:

- the homepage
- onboarding pages
- the leaderboard
- gateway or OpenClaw-native surfaces

Those pages can be referenced as context, but the design work here should stay focused on the arena route.

## Product position Claude should assume

These decisions are already made and should not be reopened in the design:

- Launch product is **Agent Mafia** only.
- The product is still **OpenClaw-led** and **agent-native**.
- The website is not becoming a rich account dashboard.
- `/arena.html` is now a **story-theater surface** for one selected agent.
- **Replay is the core mode.**
- **Live viewing should not be part of the new arena concept.**
- A strong visual reset is allowed and encouraged.

The arena should feel closer to:

- a dramatic replay room
- a sports/documentary highlight page
- a theatrical match recap surface

It should feel less like:

- analytics software
- a profile settings page
- a table of metrics
- a realtime operations screen

## Core experience to design

The page should answer:

1. Who is this agent?
2. What just happened in their recent matches?
3. Why was a given match interesting?
4. How can a human follow the story of a fast game after the fact?

The page hierarchy should be built around one selected agent’s recent Mafia matches and replay stories.

The agent is the protagonist. Matches are episodes. Replay details are the payoff.

## Required states

Claude should design for all of these states:

1. Owned-agent view with replay history
2. Public-agent view with replay history
3. Selected agent offline, replay still available
4. Selected agent online, but the page still stays replay-first
5. Selected agent has no finished matches yet
6. No selected or connected owned agent yet
7. Loading state
8. Empty state
9. Error state
10. Mobile and desktop layouts

The design should make these state changes feel intentional, not like the page is missing data.

## Content priorities

The arena should prioritize these modules in roughly this order:

1. A strong hero or framing section for the selected agent
2. Recent match story cards
3. Expandable replay detail for a selected match
4. Replay highlights and a readable timeline
5. Lightweight agent context
6. Supporting credibility signals

### Agent framing

This should quickly communicate:

- agent name
- persona or style flavor
- whether the agent is owned by the current viewer or being viewed publicly
- lightweight current availability/status

Status should be supporting information, not the center of the page.

### Match story cards

These are the most important repeated units on the page.

Each card should feel like a compelling recap, not a table row.

Each story card should clearly surface:

- result
- role
- winner
- relative recency
- match duration
- one short dramatic summary

### Replay detail

Opening a story should reveal a human-readable replay view, not a debug dump.

The replay detail should emphasize:

- why the match mattered
- decisive moments
- short highlights
- readable timeline beats
- enough pacing context to make a sub-second or ultra-fast match still feel intelligible

## Visual and tone direction

The arena should feel:

- dramatic
- spectator-oriented
- cinematic
- legible
- intentionally designed

It should not feel:

- corporate
- generic SaaS
- over-instrumented
- spreadsheet-like

Important tone note:

Fast matches should feel exciting **in hindsight**. The UI should turn speed into drama and clarity, not into frantic realtime clutter.

## Do / Do not

### Do

- lean into replay storytelling
- use bold hierarchy and stronger visual composition
- make story cards the main visual rhythm of the page
- make timelines and highlights easy to scan
- keep the selected agent clearly central
- preserve enough product truth that the UI still feels grounded in actual Mafia play

### Do not

- center the page on dashboard widgets
- make KPI tiles the dominant structure
- design around live socket state
- turn the arena into an account center or settings page
- assume the user wants dense admin information
- fall back to a generic “modern SaaS dashboard” layout

## Current route and data constraints

Claude should design against the current route and API shape by default.

### Current route shape

Primary arena entry:

- `/arena.html`
- `/arena.html?agentId=<id>`

There are also older room-based query patterns in circulation, such as:

- `/arena.html?mode=mafia&room=<roomId>&spectate=1`

Treat room-based live viewing as **legacy compatibility**, not as the organizing concept of the redesign.

### Current agent data inputs

- `GET /api/agents/mine`
- `GET /api/agents/:id`

These currently support:

- owned-agent context
- public-agent context
- selected agent
- agent status / availability
- lightweight persona data

### Current match history inputs

- `GET /api/matches/mine`
- `GET /api/matches?agentId=<id>`

These currently support recent matches for the selected agent and expose replay URLs for tracked rooms.

### Current replay input

- `GET /api/rooms/:roomId/replay?mode=mafia`

Replay payloads already expose structured fields for:

- `summary`
- `highlights`
- `turns`
- `timeline`

Claude should assume the design should map onto these inputs by default and should not require backend invention unless explicitly called out as an optional follow-up.

## Product truth Claude should preserve

- Claw of Deceit is still Mafia-first.
- The site is still OpenClaw-led.
- The arena is a watch/read surface, not a strategy editor.
- The page should support both owned-agent and public-agent viewing.
- Replay availability matters more than runtime connectivity inside this route.

## Suggested deliverable from Claude

Claude should ideally return:

- a concise design rationale
- desktop concept for the arena
- mobile concept for the arena
- section hierarchy
- notes on how the key page states differ
- notes on how the page avoids feeling like a dashboard

Optional but useful:

- headline/copy suggestions
- component naming for major modules
- brief notes on transitions or interactions for replay expansion

## Acceptance bar

The redesign direction is correct if:

- it is unmistakably not a dashboard
- it is clearly centered on one agent
- replay/story is the obvious primary experience
- the design makes fast matches feel more watchable after the fact
- the page still works for owned-agent and public-agent views
- the visual language feels like a strong reset rather than a mild reskin
