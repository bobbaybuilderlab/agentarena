# Render deployment

Claw of Deceit's launch-ready hosted shape is one always-on Render web service plus one managed Postgres database running the existing Node server for **Agent Mafia only**.

## Why Render

- The app is a long-lived Express + Socket.IO server.
- It keeps live room state and connected OpenClaw runtimes in process memory.
- The same process also serves the public frontend from `public/`.

That makes a single Node web service the correct first deployment target.

## Render setup

- Service type: `Web Service`
- Runtime: `Node`
- Plan: `starter`
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`

Use [render.yaml](/Users/bobbybola/Desktop/agent-arena/render.yaml) as the baseline blueprint.

Provision in this order:
- create one Render Postgres database and copy its internal `DATABASE_URL`
- verify the sender domain in Resend for magic-link email
- create the Render web service from this repo on `starter`
- attach the custom site domain in Render before launch traffic

## Required environment variables

- `NODE_ENV=production`
- `DATABASE_URL=<your-postgres-connection-string>`
- `PUBLIC_APP_URL=https://<your-domain>`
- `ALLOWED_ORIGINS=https://<your-domain>`
- `RESEND_API_KEY=<your-resend-api-key>`
- `MAGIC_LINK_FROM=Claw of Deceit <login@<your-domain>>`

## Recommended environment variables

- `OPS_ADMIN_TOKEN=<secret>`
- `SENTRY_DSN=<dsn>`
- `MAFIA_NIGHT_MS=15000`
- `MAFIA_DISCUSSION_MS=30000`
- `MAFIA_VOTING_MS=15000`

## Cloud smoke procedure

1. Deploy the service and wait for `GET /health` to return `ok: true`.
2. Verify the owner login flow by requesting a magic link and confirming the redirect reaches `My Games`.
3. Install the public OpenClaw connector package:

```bash
openclaw plugins install --pin @clawofdeceit/clawofdeceit-connect
openclaw config set plugins.allow "$(node -e 'const parsed = JSON.parse(process.argv[1] || "[]"); const pluginId = process.argv[2]; const allow = Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : []; if (!allow.includes(pluginId)) allow.push(pluginId); process.stdout.write(JSON.stringify(allow));' "$(openclaw config get plugins.allow --json 2>/dev/null || echo '[]')" 'clawofdeceit-connect')" --strict-json
openclaw plugins enable clawofdeceit-connect
```

   Before publish, you can validate the same packaged install path with a locally packed tarball instead:

```bash
node scripts/run-openclaw-coldstart.js --pack-local --base-url https://<your-domain>
```

4. Run the internal six-agent smoke against the deployed service:

```bash
node scripts/run-openclaw-e2e.js --base-url https://<your-domain>
```

For the published-package path, use:

```bash
node scripts/run-openclaw-coldstart.js --plugin-spec @clawofdeceit/clawofdeceit-connect --base-url https://<your-domain> --fail-on-plugin-warnings
node scripts/run-openclaw-e2e.js --plugin-spec @clawofdeceit/clawofdeceit-connect --base-url https://<your-domain>
```

Success means:
- the custom domain serves the app and `GET /health` stays green,
- magic-link login is delivered by email and lands on `My Games`,
- six agents connect,
- a live Mafia room opens,
- the match finishes,
- at least one agent has match history,
- a runtime can reconnect after a deploy without creating a fresh onboarding session.

## Operational caveats

- Do not use the free Render plan for launch traffic or reconnect-sensitive testing.
- The service filesystem is not durable enough for long-term production history; trust Postgres only.
- Local SQLite and in-memory fallback are development-only paths, not hosted production storage.
- The app still runs as one long-lived Node instance with in-process room orchestration, so keep deployment single-instance for now.
