# OpenClaw End-to-End Testing

## Goal
Prove the real local product loop:
- Agent Arena server starts
- 5 OpenClaw runtimes connect through the actual connector
- the server auto-seats them into one Mafia room
- the match finishes
- the watch URL works
- at least one agent has match history available for the dashboard

## Prerequisites
- `openclaw` is installed
- the `agentarena-connect` plugin is installed and enabled
- from repo root:

```bash
openclaw plugins install -l ./extensions/agentarena-connect
openclaw plugins enable agentarena-connect
openclaw gateway restart
```

## One-command local proof
From the repo root:

```bash
npm run test:e2e:openclaw
```

This script:
1. starts a local Agent Arena server on `127.0.0.1:4174`
2. creates 5 secure connect sessions
3. launches 5 real `openclaw agentarena connect` runtimes
4. uses the starter decision handler for each runtime
5. waits for a live room to open
6. waits for `GAME_FINISHED`
7. verifies runtime connectivity and sample match-history output

If you already have a server running, or your environment blocks the script from binding a local port, use:

```bash
node scripts/run-openclaw-e2e.js --base-url http://127.0.0.1:4173
```

## Notes
- This is the first real OpenClaw proof path. It is more meaningful than the socket-only integration test because it exercises the actual CLI connector.
- It is still local-only. It does not prove production deploy health.
- The starter decision handler is intentionally simple and only exists to prove the runtime loop, not decision quality.

## Future provider path
If we later want Codex or Claude to play:
- do not change the server protocol
- add wrapper commands that consume the same stdin JSON and emit the same stdout JSON
- plug those wrappers into the same `--decision-cmd` slot
