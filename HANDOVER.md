# Agent Arena Handover

Last updated: 2026-03-10

## Current Product State
- Public launch scope is one game only: `Agent Mafia`.
- Public gameplay is `agent-only`.
- Humans are spectators and owners, not guest players.
- The website is now positioned around:
  - connect your agent
  - watch live
  - review objective results in a dashboard
- The public docs page is now a short setup flow only, not a full technical manual.

## What Is Implemented
### Public product surface
- Homepage, play page, browse/watch page, rules page, and docs are Mafia-first.
- Non-Mafia public game modes are removed from the frontend launch surface.
- Dashboard exists as a separate owner-facing page for factual match review.
- Public information architecture is now:
  - `Home` for the product story
  - `Watch` for spectators
  - `Arena` for live owner status
  - `Dashboard` for post-match review

### Agent runtime loop
- OpenClaw agents can connect via the secure connect-session + callback flow.
- Runtime-connected agents register over Socket.IO and enter the live arena queue.
- The server auto-seats 5 idle agents into a Mafia room and starts the match automatically.
- Agents rotate back into the queue after each match while still connected.
- Spectators can watch live matches and owners can inspect status/history.

### Product boundary
- Agent Arena owns:
  - matchmaking
  - room lifecycle
  - timing
  - action validation
  - spectating
  - objective dashboard/history
- Agent owners own:
  - strategy
  - persona
  - prompts
  - who to accuse, trust, kill, or vote for

## Important Recent Change
The bundled OpenClaw connector was changed from a strategy-bearing runtime into a thin adapter.

### New connector contract
- `openclaw agentarena connect` now supports `--decision-cmd`.
- The connector stays responsible for:
  - connect flow
  - runtime registration
  - reconnects
  - status polling
  - forwarding requests/responses
- The connector no longer contains built-in Mafia target-selection logic.

### Decision hook behavior
- For each live Mafia request, the connector sends one JSON payload to the configured local command on stdin.
- The command must print one JSON action on stdout.
- Supported request kinds:
  - `night_request`
  - `discussion_request`
  - `vote_request`
- Supported responses:
  - `{ "type": "nightKill", "targetId": "..." }`
  - `{ "type": "ready" }`
  - `{ "type": "vote", "targetId": "..." }`

### Starter example
- A copyable starter handler exists at `examples/agentarena-decision-handler/index.js`.
- It is intentionally simple and is not used implicitly.
- If `--decision-cmd` is omitted, the runtime still connects but remains passive.

## Key Files
- Runtime connector: `extensions/agentarena-connect/index.ts`
- Starter handler: `examples/agentarena-decision-handler/index.js`
- Owner dashboard: `public/dashboard.html`
- Dashboard/play status logic: `public/app.js`
- Public docs: `public/guide.html`
- Connector reference: `docs/openclaw-connect-plugin.md`
- Core server/runtime flow: `server.js`
- Mafia engine: `games/agent-mafia/index.js`

## Most Important Validation So Far
### What worked
- The local OpenClaw end-to-end proof worked with 5 parallel runtimes.
- Real OpenClaw agents connected, registered runtime sessions, auto-seated into Mafia rooms, and completed repeated matches.
- Agents rotated back into the queue and kept playing without reconnecting.
- The thin `--decision-cmd` product boundary worked in practice.
- The website now matches the actual product much better than the earlier guest/bot-heavy version.

### What did not work cleanly
- The first local batch test hit auth rate limits until the server was started with a higher local `AUTH_RATE_LIMIT_MAX`.
- The local harness kept following later rooms and timed out even though matches were visibly finishing; the loop works, but the harness success condition is still brittle.
- The current starter handler is too simplistic, which made matches repetitive and likely contributed to Town winning almost every observed game.
- The docs were initially trying to do onboarding, protocol reference, and tuning all at once; that proved too dense and has now been simplified.

## Validation Status
Passing at handoff:
- `node --test test/agent-mafia.test.js test/agent-arena-runtime.test.js test/agentarena-decision-handler.test.js`
- `npm run test:release`

Latest known results:
- Node tests: `9 pass, 0 fail`
- Release smoke: `21 passed`

What those checks cover:
- 5 runtime-connected agents auto-seat and finish a Mafia match
- starter decision handler returns valid action payloads
- public navigation and docs surface are Mafia-first
- dashboard page is present
- launch API behavior is correct for Mafia-only public entry

Additional manual validation already performed:
- A real local OpenClaw run on the user's machine completed repeated live Mafia matches.
- The arena kept auto-queueing agents after finished games.
- The current issue is not “can it run?” anymore; it is quality, readability, and production hardening.

## Known Boundaries / Non-Issues
- Agent Arena no longer tries to be the strategist in the default connector. That is intentional.
- The bundled starter handler is only a demo. Real agent quality depends on the owner's OpenClaw setup.
- Backend code for future modes still exists, but the frontend/public launch surface is Mafia-only.
- Dashboard is factual on purpose. It does not give subjective “AI coaching”.
- The public docs page is intentionally minimal now. Deep protocol details should not come back into the main website flow unless the product direction changes.

## What Is Good Right Now
- The core product loop is real: connect, queue, play, watch, review.
- The product boundary is clean: Agent Arena is the referee; OpenClaw is the player.
- The public site is much simpler and closer to the intended launch story.
- Dashboard/history being factual is the right call for agent owners iterating on behavior.

## Biggest Gaps Before Production
- Spectator readability is still limited because discussion and voting are not yet richly visible on the watch surface.
- Match quality is too dependent on the simplistic starter decision handler.
- The local E2E harness should stop cleanly after one validated finished match.
- Production polish still needs a proper website smoke pass on the deployed URL after each major copy/IA change.
- Docs are now appropriately short, but technical reference still needs a non-public or repo-only home for advanced users.

## Suggested Next Steps
1. Improve spectator value: visible discussion, visible votes, short intermission between matches.
2. Harden the local harness so one successful finished match is treated as a clean pass.
3. Improve the starter decision-hook examples without moving strategy back into Agent Arena.
4. Run a production-style website smoke pass across Home, Watch, Arena, Docs, and Dashboard.
5. Decide where repo-only technical reference should live so onboarding stays simple.
