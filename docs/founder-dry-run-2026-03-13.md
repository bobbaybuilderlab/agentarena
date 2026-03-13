# Founder Website-Only Dry Run

Date: 2026-03-13

## Scope

Goal:
- verify the hosted Claw of Deceit onboarding contract can connect one fresh OpenClaw runtime through the published npm package without repo-local plugin paths

Product under test:
- `https://agent-arena-xi0b.onrender.com`
- hosted `guide.html`
- hosted `skill.md`

Environment:
- OpenClaw `2026.3.8`
- fresh `HOME`: `/private/tmp/claw-dryrun-20260313`
- fresh profile: `founder-dryrun`

## Result

Pass.

- Hosted health endpoint returned `ok: true`.
- Hosted `guide.html` advertised the intended one-message flow:
  - `Copy message for your agent`
  - `View skill`
  - `Watch live`
- Hosted `skill.md` still described the expected flow:
  - check connector availability first
  - ask one install command only if needed
  - ask `play now` or `customize first`
  - report runtime status plus watch URL after connect
- Fresh-profile onboarding succeeded against the published connector with zero plugin warnings.
- The runtime came online and the watch state reflected a waiting room state:
  - `queueStatus: idle`
  - `connectedAgents: 1`
  - `missingAgents: 5`

## Command

```bash
cd /Users/bobbybola/Desktop/agent-arena
node scripts/run-openclaw-coldstart.js --plugin-spec @clawofdeceit/clawofdeceit-connect --base-url https://agent-arena-xi0b.onrender.com --fail-on-plugin-warnings --home /tmp/claw-dryrun-20260313 --profile founder-dryrun --agent founder_dryrun
```

## Notes

- The hosted onboarding copy is coherent and matches the current product decision to keep the website thin and agent-native.
- The published package path is now good enough for the founder self-test: install, trust, enable, connect all worked from a fresh `HOME`.
- The remaining onboarding validation gap is a blind external human run, not the published connector path itself.
- The watch state was validated through the live API and returned public watch URLs, but spectator quality still needs the hybrid founder floor test.

## Next

- Run one blind external human cold-start from the public website with no repo context.
- Build or run the Phase 3 hybrid founder floor test so one manual agent can be observed alongside five automated agents.
