# UI Design Handover — Claw of Deceit

Date: 2026-03-13
Owner: Bobby
Intended pickup: Claude handling the next frontend design pass
Current live deploy: `4f92f1e` (`Ship install-first onboarding and owner watch`)
Hosted URL: `https://agent-arena-xi0b.onrender.com`

## Why this doc exists

The product direction changed materially on 2026-03-13.

The site is no longer trying to be a public live-room browser first. It is now:

1. install the OpenClaw connector
2. generate a one-time message
3. connect your agent
4. watch your own agent play Mafia

The next pass should be frontend design and UX polish only. The backend/session/watch plumbing for this new direction is already live. Claude should improve the visual system, hierarchy, readability, and emotional payoff without redesigning the product back toward public room browsing.

## Current product decisions that should be treated as locked

- One public game only: Mafia.
- The main product loop is agent-owner-first, not human-instant-play-first.
- The website should be install-first:
  - Step 1: install connector
  - Step 2: generate one-time message
- `Watch` is now "watch your own agent", not "browse random live tables".
- `Leaderboard` stays public.
- Public browsing of other rooms is not the main MVP story.
- No Moltbook-style human claim link in this pass.
- No guest-seat / simulated-bot marketing in the primary UX.
- OpenClaw remains the place to tweak prompts, stats, and runtime behavior.
- The browser is the place to watch the agent.

## What shipped in the latest deploy

- Homepage is Mafia-only and install/watch oriented.
- `guide.html` now uses the install-first two-step flow.
- Customization now encourages a short style phrase, not a single word.
- `browse.html` is now an owner-watch page.
- `/play.html` is a compatibility redirect to `/browse.html`.
- Session-bound ownership is live:
  - the site can resolve "my agent" and "my room"
  - the watch page should center that relationship visually
- Leaderboard page was simplified to a large scoreboard.
- Rules copy on the site now explains Mafia in simpler language.

## Direct user feedback from the dry run

This is the most important design input for the next pass:

- The old flow felt wrong because the user copied a message first, and that message then told them to install anyway.
- The correct order is install first on the website, then paste the message.
- Customization should invite creativity. "One word" felt too constrained.
- Connection felt slow.
- Watching the games was hard even when the loop worked.
- The most interesting part is seeing what the OpenClaw agents actually say during discussion.
- Spectating random rooms is weaker than watching your own agent.

## What still feels weak after the latest deploy

- The UX logic is clearer, but the design still feels like a functional internal tool.
- The visual system is still close to a generic AI/dark-dashboard aesthetic.
- Homepage copy is clearer, but the page does not yet feel memorable or premium.
- The join page works, but it still looks procedural rather than high-trust and high-conviction.
- The watch page has the right data, but not enough drama, hierarchy, or focus.
- Waiting states still feel like waiting, not anticipation.
- The transcript exists, but your own agent is not yet emotionally centered enough.
- Leaderboard is cleaner, but visually flat.
- Mobile needs explicit attention, especially on the watch page.

## Reuse older redesign docs carefully

These docs are still useful:

- [UX_AUDIT.md](/Users/bobbybola/Desktop/agent-arena/docs/redesign/UX_AUDIT.md)
- [UX_REDESIGN_SPEC.md](/Users/bobbybola/Desktop/agent-arena/docs/redesign/UX_REDESIGN_SPEC.md)
- [MAFIA_MVP_UX_FLOW.md](/Users/bobbybola/Desktop/agent-arena/docs/redesign/MAFIA_MVP_UX_FLOW.md)

But they predate the owner-watch pivot.

Claude should reuse:

- the "aha moment" framing
- the need for a narrative event feed
- the idea that the UI should make the game legible and dramatic

Claude should ignore or heavily discount:

- human-first instant play as the default story
- public live-room browsing as the main watch mode
- multi-game assumptions
- lobby/room-browser expansion ideas
- anything that reintroduces a separate "Live room" primary nav concept

## Current page roles

### `/`

Purpose:
- explain the product in one screen
- tell the user this is OpenClaw agent Mafia
- route them into install-first onboarding or watch

Current strengths:
- simpler nav
- clearer install/watch framing
- simple Mafia explanation

Current design weakness:
- still too cardy and product-doc-like
- not enough visual identity
- does not yet create anticipation for the agent discussion experience

### `/guide.html`

Purpose:
- onboarding only
- install first, then generate one-time message

Current strengths:
- flow order is finally correct
- checklist reflects the real funnel
- customization guidance is now better

Current design weakness:
- page still reads like a procedural setup document
- status and trust cues are not visually strong enough
- the "why this is worth it" layer is still thin

### `/browse.html`

Purpose:
- watch your own agent

Current strengths:
- owner-first structure is correct
- idle vs live vs no-agent states exist
- transcript and room summary are already wired

Current design weakness:
- the page still feels like a state console more than a spectator experience
- your agent's latest public line should feel much more central
- the visual hierarchy between agent spotlight, match state, and transcript can be much stronger
- queue / waiting states need more intentional design

### `/leaderboard.html`

Purpose:
- public scoreboard

Current strengths:
- simplified
- less clutter

Current design weakness:
- too plain
- lacks a sense of prestige or momentum

### `/games-info.html`

Purpose:
- explain Mafia in plain language

Current strengths:
- simple
- correct MVP framing

Current design weakness:
- could feel more like a crisp "how the game works" explainer and less like generic content blocks

## Design goals for Claude

### Goal 1: Make the owner-watch flow feel special

The product should feel like:

> I connected my OpenClaw agent, and now I can watch what it says, how it votes, and whether it survives.

The watch page should create that feeling immediately.

### Goal 2: Surface discussion as the star

The most valuable thing on the watch page is not abstract state.
It is:

- what my agent just said
- what other agents said around it
- how the room reacted
- whether that changed the vote or outcome

### Goal 3: Improve perceived speed

If backend latency is unchanged, the UI should still feel better by making status explicit:

- install complete
- message ready
- waiting for OpenClaw
- connected
- waiting for 6 agents
- live now
- match finished

### Goal 4: Make onboarding feel trustworthy and lightweight

The join page should feel high-trust and calm, not technical or fragile.

### Goal 5: Establish a stronger visual identity

Claude should feel free to replace the current visual system.

Current system uses:
- Inter / Plus Jakarta Sans / Sora / Space Mono
- dark blue AI dashboard styling
- warm docs theme on docs pages

That can be replaced.

The next visual pass should avoid generic "AI app" aesthetics.

## Strong recommendations for the next FE design pass

### Homepage

- Keep the simplified nav: `Watch`, `Leaderboard`, `Join`.
- Keep the install/watch framing.
- Push the value of discussion and deception higher.
- Make the hero feel sharper and more opinionated.
- Show that the browser is for watching a specific agent, not a generic dashboard.
- Consider a more editorial or theatrical feel instead of "tool UI".

### Join page

- Make the two-step sequence feel unmistakable.
- Step 1 should visually read as "safe install/trust step".
- Step 2 should visually read as "now generate the short-lived message".
- The customization note should invite personality and creativity.
- Add stronger progress/state styling without changing the flow.
- Make the "same OpenClaw profile" warning legible without making the page feel scary.

### Watch page

- Make the agent spotlight section dominant.
- Your agent's latest public line should feel like the primary narrative object.
- Queue and waiting states should be atmospheric and informative, not dead.
- When live:
  - room
  - phase
  - status
  - public transcript
  - your agent's lines
  should be instantly scannable.
- Your agent's lines/actions should have clear visual priority.
- End-of-match and "waiting for next table" states should feel intentional.

### Leaderboard

- Keep it simple.
- Make it feel important.
- The table should feel more like a ranking surface than a leftover list.

### Rules page

- Keep it short.
- Make the game structure legible in seconds.

## Non-goals for this pass

Claude should not:

- reintroduce a `Live room` primary nav item
- turn `browse.html` back into a public room directory
- add new backend/API requirements
- add claim/recovery/auth ownership features
- redesign the product around human instant-play
- add new game modes
- build a social feed or public roam flow back into the main journey

## Technical constraints and FE guardrails

This is the most important implementation section.

Claude can redesign the markup and CSS aggressively, but should preserve routes, data flow, and key JS hooks unless updating the corresponding JS carefully.

### Core frontend files

- [public/index.html](/Users/bobbybola/Desktop/agent-arena/public/index.html)
- [public/guide.html](/Users/bobbybola/Desktop/agent-arena/public/guide.html)
- [public/browse.html](/Users/bobbybola/Desktop/agent-arena/public/browse.html)
- [public/leaderboard.html](/Users/bobbybola/Desktop/agent-arena/public/leaderboard.html)
- [public/games-info.html](/Users/bobbybola/Desktop/agent-arena/public/games-info.html)
- [public/styles.css](/Users/bobbybola/Desktop/agent-arena/public/styles.css)
- [public/app.js](/Users/bobbybola/Desktop/agent-arena/public/app.js)
- [public/games.js](/Users/bobbybola/Desktop/agent-arena/public/games.js)

### Backend/API pieces already live and should be treated as stable

- [server.js](/Users/bobbybola/Desktop/agent-arena/server.js)
- [server/routes/openclaw.js](/Users/bobbybola/Desktop/agent-arena/server/routes/openclaw.js)
- [server/services/connect-sessions.js](/Users/bobbybola/Desktop/agent-arena/server/services/connect-sessions.js)
- [server/services/onboarding-contract.js](/Users/bobbybola/Desktop/agent-arena/server/services/onboarding-contract.js)

### Routes to preserve

- `/`
- `/guide.html`
- `/browse.html`
- `/leaderboard.html`
- `/games-info.html`
- `/play.html` as compatibility redirect only

### Keep these key IDs unless the JS is updated with the same pass

#### Guide / onboarding hooks

- `installCommand`
- `copyInstallBtn`
- `generateCmdBtn`
- `cliBox`
- `cliCommand`
- `advancedCommand`
- `copyCmdBtn`
- `checkStatusBtn`
- `status`
- `shareRow`
- `watchLiveBtn`
- `stepInstall`
- `stepMessage`
- `stepWatch`

#### Watch page hooks

- `ownerWatchCard`
- `ownerWatchStatus`
- `ownerWatchAgentName`
- `ownerWatchQueue`
- `ownerWatchRoom`
- `ownerWatchQuote`
- `startArenaBtn`
- `gamePicker`
- `matchHudSection`
- `matchStatusLine`
- `matchRoom`
- `matchMode`
- `matchPhase`
- `matchRound`
- `matchAlive`
- `matchRoster`
- `phaseTimeline`
- `phaseSteps`
- `ownerDigestCard`
- `spectatorReadSection`
- `phaseCountdown`
- `spectatorSummary`
- `baselineMetrics`
- `spectatorFeed`
- `spectatorIntermission`
- `gameContentSection`
- `playersView`
- `actionsView`

#### Leaderboard hooks

- `leaderboardWindowControls`
- `leaderboardList`

### Important behavioral constraints

- `browse.html` must continue to work with:
  - no owned agent
  - owned agent connected but idle
  - owned agent live in a room
  - finished room pinned while waiting for next table
- The transcript remains public-only. Do not expose hidden Mafia information before reveal.
- `guide.html` remains install-first.
- Style customization remains "short style phrase", not one-word style.

## Existing tests that Claude should expect to touch if copy changes a lot

- [test/e2e/navigation.spec.js](/Users/bobbybola/Desktop/agent-arena/test/e2e/navigation.spec.js)
- [test/security-connect-session.test.js](/Users/bobbybola/Desktop/agent-arena/test/security-connect-session.test.js)

If Claude changes page copy substantially, update the tests intentionally.

## Recommended execution plan for Claude

### Phase 1 — Visual system + homepage + join page

Ship first:

- stronger visual direction
- typography overhaul
- homepage hierarchy
- join page hierarchy and trust cues
- better onboarding step styling

This should make the top of the funnel feel real immediately.

### Phase 2 — Watch page redesign

Ship second:

- owner spotlight redesign
- better queue / waiting state
- stronger transcript treatment
- clearer live match hierarchy
- stronger emphasis on your agent's latest line and actions

This is the most important phase emotionally.

### Phase 3 — Leaderboard + rules + mobile polish

Ship third:

- leaderboard styling
- rules page polish
- mobile tightening across all pages
- motion/accessibility polish

## Definition of done

The FE redesign is successful when all of these are true:

- A first-time visitor can understand the install-first flow immediately.
- The join page clearly reads as Step 1 then Step 2.
- The watch page instantly answers:
  - Which agent is mine?
  - Is it queued or live?
  - What room is it in?
  - What did it just say?
  - What phase/result is happening?
- Your agent's public lines feel visually central.
- No main page suggests that browsing random public live rooms is the core action.
- The site feels intentional and memorable rather than generic "AI dashboard".
- Mobile still works cleanly.

## Final brief in one paragraph

Do not redesign Claw of Deceit as a public spectator directory. Redesign it as a focused, install-first, owner-watch product where the payoff is seeing your own OpenClaw agent bluff, accuse, vote, survive, and lose in public. The functionality is already there. The next job is to make that experience legible, dramatic, and worth watching.
