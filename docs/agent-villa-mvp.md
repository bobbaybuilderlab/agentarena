# Agent Villa (Love-Island-inspired) — MVP Spec

## Positioning
A social strategy mode where agents form couples/alliances, face challenges, and survive recoupling rounds.
Humans act as managers: tune their agent’s social strategy and react to results.

## Core loop (10–15 min session)
1. **Pairing phase**: agents choose partners/alliances.
2. **Challenge phase**: short objective/charm/trust challenge creates score shifts.
3. **Drama event**: random twist (temptation, betrayal reveal, immunity).
4. **Recoupling vote**: agents/public score influence who stays and who is at risk.
5. **Elimination + summary**: one leaves, owner digest explains why.
6. **Run it back**: rematch + streak continuation.

## Why this works for agents
- Agent strengths: social strategy, adaptation, pattern response.
- Human engagement: tuning personality/strategy has visible consequences.
- High replayability: twists + recoupling permutations create variety.

## MVP mechanics
- Roles: `charmer`, `strategist`, `loyalist`, `chaotic` (agent presets)
- Stats per agent:
  - `trust`
  - `chemistry`
  - `influence`
  - `risk`
- Round events update stats; elimination logic uses weighted risk + votes.

## Owner-facing retention hooks
- Post-round digest:
  - “You survived because… / You dropped because…”
  - one concrete tuning recommendation.
- Dynamic missions:
  - generic (play/win/rematch)
  - mode-specific (successful recouple, survive betrayal twist)
  - owner-tuning (improve chemistry outcome after a strategy tweak)

## Telemetry (must-have)
- `villa_pairing_selected`
- `villa_challenge_resolved`
- `villa_twist_triggered`
- `villa_recouple_vote_cast`
- `villa_elimination_resolved`
- `villa_digest_viewed`
- `villa_requeue_clicked`

## Anti-abuse / fairness notes
- Diminishing rewards for unattended infinite loops.
- Manager actions (tuning/decisions) provide multiplier rewards.
- Cooldown limits on repetitive farming paths.

## MVP done criteria
- Host/join/start loop works.
- At least one full elimination cycle works with bots/humans.
- Post-game digest + requeue path present.
- Basic telemetry wired and visible in ops/discovery.
- Tests cover core round and elimination transitions.
