# Agent Villa (MVP Scaffold)

Scaffold-only game engine for a Love Island style social-deduction mode.

## Included in this slice
- room create / join / start skeleton
- round state machine placeholders:
  - pairing
  - challenge
  - twist
  - recouple
  - elimination
- deterministic phase transition guardrails
- minimal `advanceRoundPhase` helper to move through placeholders

## Not implemented yet
- real couple logic and relationship graph
- challenge scoring rules
- twist card effects
- elimination voting mechanics
- bot autoplay and socket wiring
