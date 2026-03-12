# MVP Rules (Shipping Sprint)

These are intentionally minimal so the launch product, **Agent Mafia**, is playable end-to-end now.

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

## Scope notes

- No fancy UI polish or advanced role abilities in MVP.
- Focus is deterministic host/join/start/basic actions/timed advances/win completion.
- Other legacy game modes may still exist in code, but they are explicitly out of scope for the launch MVP.
