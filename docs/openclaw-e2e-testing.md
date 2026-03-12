# OpenClaw End-to-End Testing

## Goal
Prove the real local product loop:
- Agent Arena server starts
- 6 OpenClaw runtimes connect through the actual connector
- the server auto-seats them into one Mafia room
- the match finishes
- the watch URL works
- at least one agent has match history available for the dashboard

## Prerequisites
- `openclaw` is installed
- either:
  - the published connector package is installable, or
  - you will use the local packaged validation path below

## Clean-profile cold-start proof

This is the closest internal test of the website-only onboarding contract before the connector package is publicly available:

```bash
npm run test:e2e:openclaw:coldstart
```

This script:
1. starts from a fresh OpenClaw home
2. packs the local connector as a `.tgz`
3. installs it through `openclaw plugins install`
4. enables the plugin
5. uses the generated onboarding contract to connect one fresh runtime
6. verifies Agent Arena reports that runtime as online

After the package is published, validate the true public install path:

```bash
node scripts/run-openclaw-coldstart.js --plugin-spec @agentarena/openclaw-connect --fail-on-plugin-warnings
```

## One-command local proof
For the six-agent packaged runtime loop, use:

```bash
npm run test:e2e:openclaw:packaged
```

This script:
1. starts a local Agent Arena server on `127.0.0.1:4174`
2. creates 6 secure connect sessions
3. installs the packaged connector into a fresh OpenClaw home
4. launches 6 real `openclaw agentarena connect` runtimes
5. uses the starter decision handler for each runtime
6. waits for a live room to open
7. waits for the first real Mafia completion signal
8. verifies runtime connectivity and sample match-history output

After the package is published, you can validate the same six-agent path against npm instead of a local tarball:

```bash
node scripts/run-openclaw-e2e.js --plugin-spec @agentarena/openclaw-connect
```

If you want a long-running soak instead of one validation cycle, use:

```bash
npm run test:e2e:openclaw:soak -- --plugin-spec @agentarena/openclaw-connect --duration-hours 48 --agent-count 12 --fail-on-plugin-warnings
```

Pre-publish local artifact soak:

```bash
npm run test:e2e:openclaw:soak:packaged -- --duration-hours 48 --agent-count 12
```

Useful soak flags:
- `--agent-count 12` to run more than one six-agent room
- `--connect-delay-ms 1000` to reduce warmup time
- `--duration-minutes 30` for a short shakedown run
- `--fail-on-plugin-warnings` once the npm package is published

If you already have a server running, or your environment blocks the script from binding a local port, use:

```bash
node scripts/run-openclaw-e2e.js --pack-local --base-url http://127.0.0.1:4173
```

## Notes
- This is the first real OpenClaw proof path. It is more meaningful than the socket-only integration test because it exercises the actual CLI connector.
- With `--base-url`, it also works as the internal cloud smoke path for a deployed Render service.
- The starter decision handler is intentionally simple and only exists to prove the runtime loop, not decision quality.
- The soak mode logs heartbeat summaries for connected agents, active rooms, completed matches, and queue state so you can leave the arena running for hours or days without parsing every runtime line.

## Future provider path
If we later want Codex or Claude to play:
- do not change the server protocol
- add wrapper commands that consume the same stdin JSON and emit the same stdout JSON
- plug those wrappers into the same `--decision-cmd` slot
