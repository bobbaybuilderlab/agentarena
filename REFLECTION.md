# Agent Arena Reflection

Last updated: 2026-03-10

## What Worked
- Narrowing the launch to one game only, `Agent Mafia`, was the right call. It made the product understandable.
- Moving to an agent-only public experience was the right call. The earlier guest/bot story was misleading.
- The most important technical win was the runtime bridge: 5 connected OpenClaw agents can now auto-seat into live Mafia matches and keep cycling through the queue.
- Treating Agent Arena as the host/referee and OpenClaw as the player produced the right product boundary.
- The `--decision-cmd` change was especially important. It kept strategy under owner control instead of burying it inside the platform.
- Separating `Watch`, `Arena`, and `Dashboard` into different jobs made the site easier to reason about.

## What Did Not Work
- The first product story drifted into multiple conflicting shapes:
  - multi-game launch
  - guest play
  - bot-filled seats
  - OpenClaw-first onboarding
  Those ideas did not belong together and created confusion in both the product and the website.
- The original docs tried to be setup guide, protocol manual, and tuning guide at the same time. That made them hard to read and visually heavy.
- The local OpenClaw batch proof exposed that the auth rate limit was too low for rapid parallel connect testing.
- The current end-to-end harness proves the loop, but its success condition is still too brittle when matches keep auto-repeating.
- The starter decision handler is enough to prove the plumbing, but not enough to make the game strategically interesting.

## What We Learned
- “Real and simple” beats “broad but half-true.” The moment the website matched the actual runtime loop, decision-making got easier.
- Website clarity matters as much as backend correctness. Several rounds of work were really about undoing product-story mismatch, not fixing code bugs.
- The main product risk is no longer whether agents can technically play. The main risks are:
  - whether spectators can understand and enjoy what they are watching
  - whether agent owners can improve behavior without friction
- The dashboard is useful when it stays factual. It should not become an automated coaching surface.
- The docs should stay short in the public product. Advanced reference belongs elsewhere.

## What Is Good About the Current Game
- The game works end to end locally with real OpenClaw runtimes.
- Auto-queueing and repeated matches create the right arena feeling.
- The owner flow is coherent:
  - connect agent
  - keep runtime online
  - watch matches
  - inspect results
  - iterate outside the platform

## What Is Bad or Weak Right Now
- Spectator fun is still underpowered because the game is not yet exposing enough live social information.
- The current discussion phase is still too thin to make matches readable and entertaining.
- Match quality is repetitive with the starter handler, which makes the observed balance signal untrustworthy.
- Some deployment and browser validation has had to rely on manual checks because headless verification against protected previews is awkward from this environment.

## What Needs to Happen for Production-Level Quality
1. Make the spectator experience readable:
   - visible discussion
   - visible votes
   - short post-match intermission
2. Make the local proof path deterministic:
   - one harness run
   - one completed validated match
   - one clear pass/fail signal
3. Improve owner onboarding without growing the docs:
   - better starter decision-hook examples
   - clean command generation
   - simple review loop
4. Do consistent deployed smoke testing:
   - Home
   - Watch
   - Arena
   - Docs
   - Dashboard
5. Only revisit game balance after visible discussions and better agent strategies exist.

## Current Overall Status
Agent Arena is no longer a concept demo. It is a working local product loop with a clearer public story.

It is not production-ready yet, but the remaining work is now mostly about:
- spectator clarity
- agent quality
- test reliability
- production polish

That is a much better place to be than earlier in the project, when the main uncertainty was whether the core loop could work at all.
