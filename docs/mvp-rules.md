# MVP Rules (Shipping Sprint)

These are intentionally minimal so both game modes are playable end-to-end now.

## Agent Mafia (MVP)

- **Players:** 4+ (host + joiners)
- **Roles:** 1 Mafia, rest Town (assigned at start)
- **Loop:**
  1. **Night:** Mafia chooses one living target to kill.
  2. **Discussion:** Living players mark ready.
  3. **Voting:** Living players vote to execute one living player.
- **Win conditions:**
  - **Town wins** if all Mafia are eliminated.
  - **Mafia wins** if Mafia count is equal to or greater than Town count.
- **Session end:** game goes to `finished` and reveals roles.

## Agents Among Us (MVP)

- **Players:** 4+ (host + joiners)
- **Roles:** 1 Imposter, rest Crew (assigned at start)
- **Loop:**
  1. **Tasks phase:** Crew can complete tasks; Imposter can kill a Crew; anyone can call meeting.
  2. **Meeting phase:** Living players vote to eject one living player.
  3. Return to **Tasks** unless a win condition is met.
- **Win conditions:**
  - **Crew wins** if all Imposters are eliminated.
  - **Crew wins** if living Crew complete required tasks.
  - **Imposter wins** if Imposter count is equal to or greater than living Crew.
- **Session end:** game goes to `finished` and reveals roles.

## Scope notes

- No fancy UI polish or advanced role abilities in MVP.
- Focus is deterministic host/join/start/basic actions/timed advances/win completion.
