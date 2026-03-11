#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const handlerPath = path.join(repoRoot, 'examples', 'agentarena-decision-handler', 'index.js');
const serverPath = path.join(repoRoot, 'server.js');
const DEFAULT_PORT = Number(process.env.PORT || 4174);
const OPENCLAW_PROFILE = process.env.OPENCLAW_PROFILE || 'main';
const AGENTS = [
  { name: 'Alpha', style: 'cautious' },
  { name: 'Bravo', style: 'chaotic' },
  { name: 'Charlie', style: 'witty' },
  { name: 'Delta', style: 'cold' },
  { name: 'Echo', style: 'paranoid' },
  { name: 'Foxtrot', style: 'aggressive' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (_err) {
      // keep polling until ready
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(500);
  }
  throw new Error(message);
}

async function waitForConnectSession(baseUrl, connect) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/openclaw/connect-session/${connect.id}?accessToken=${encodeURIComponent(connect.accessToken)}`);
    if (res.ok) {
      const data = await res.json();
      if (data?.ok && data.connect?.status === 'connected' && data.connect?.agentId) {
        return {
          agentId: data.connect.agentId,
          connectId: connect.id,
        };
      }
    }
    await sleep(3_000);
  }
  throw new Error(`Timed out waiting for connect session ${connect.id} to connect`);
}

function parseProof(command) {
  const match = String(command || '').match(/--proof\s+([^\s']+)/);
  if (!match) throw new Error(`Could not parse proof from command: ${command}`);
  return match[1];
}

function ensureOpenClawInstalled() {
  const result = spawnSync('openclaw', ['--profile', OPENCLAW_PROFILE, 'agentarena', 'connect', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) return;
  throw new Error(
      `OpenClaw AgentArena connector is not available.\n` +
    `Expected \`openclaw --profile ${OPENCLAW_PROFILE} agentarena connect --help\` to work.\n` +
    `stderr: ${result.stderr || '(none)'}`
  );
}

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return '';
  return process.argv[idx + 1] || '';
}

function startServer(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DISABLE_AUTOBATTLE: '1',
      NODE_ENV: process.env.NODE_ENV || 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[arena] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[arena] ${chunk}`));
  return child;
}

function startAgentRuntime(baseUrl, connect, agentConfig) {
  const args = [
    '--profile',
    OPENCLAW_PROFILE,
    'agentarena',
    'connect',
    '--api',
    baseUrl,
    '--token',
    connect.id,
    '--callback',
    connect.callbackUrl,
    '--proof',
    parseProof(connect.command),
    '--agent',
    agentConfig.name,
    '--style',
    agentConfig.style,
    '--decision-cmd',
    `node ${handlerPath}`,
  ];

  const child = spawn('openclaw', args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${agentConfig.name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${agentConfig.name}] ${chunk}`));
  return child;
}

function stopChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/run-openclaw-e2e.js');
    console.log('Starts a local Agent Arena server, or uses --base-url, connects 6 OpenClaw runtimes, and validates one full Mafia match.');
    console.log('Optional: --base-url http://127.0.0.1:4173');
    process.exit(0);
  }

  ensureOpenClawInstalled();

  const suppliedBaseUrl = readArg('--base-url').trim();
  const port = DEFAULT_PORT;
  const baseUrl = suppliedBaseUrl || `http://127.0.0.1:${port}`;
  const server = suppliedBaseUrl ? null : startServer(port);
  const runtimes = [];

  const shutdown = () => {
    runtimes.forEach(stopChild);
    stopChild(server);
  };

  process.on('SIGINT', () => {
    shutdown();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(1);
  });

  try {
    await waitForJson(`${baseUrl}/health`, 15_000);
    console.log(`${suppliedBaseUrl ? 'Using existing' : 'Local'} arena at ${baseUrl}`);

    const connectedAgents = [];
    for (const agentConfig of AGENTS) {
      const sessionRes = await fetch(`${baseUrl}/api/openclaw/connect-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${agentConfig.name.toLowerCase()}@example.com` }),
      });
      const sessionData = await sessionRes.json();
      if (!sessionData.ok) throw new Error(`Failed to create connect session for ${agentConfig.name}`);

      const connect = sessionData.connect;
      runtimes.push(startAgentRuntime(baseUrl, connect, agentConfig));

      const connectedState = await waitForConnectSession(baseUrl, connect);
      const connected = {
        name: agentConfig.name,
        agentId: connectedState.agentId,
        connectId: connectedState.connectId,
      };

      connectedAgents.push(connected);
      console.log(`Connected ${agentConfig.name} as ${connected.agentId}`);
      await sleep(4_000);
    }

    const watchState = await waitFor(async () => {
      const res = await fetch(`${baseUrl}/api/play/watch`);
      const data = await res.json();
      return data?.ok && data.found ? data : null;
    }, 20_000, 'Timed out waiting for a live Mafia room');

    console.log(`Live room opened: ${watchState.roomId}`);

    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(watchState.roomId)}/events?mode=mafia&limit=200`);
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean((data.events || []).find((entry) => entry.type === 'GAME_FINISHED'));
    }, 30_000, 'Timed out waiting for GAME_FINISHED event');

    console.log(`Match ${watchState.roomId} finished`);

    for (const agent of connectedAgents) {
      await waitFor(async () => {
        const res = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agent.agentId)}`);
        if (!res.ok) return false;
        const data = await res.json();
        return data?.ok && data.agent?.arena?.runtimeConnected === true;
      }, 10_000, `Timed out waiting for ${agent.name} runtime to stay connected`);
    }

    const matchHistory = await fetch(`${baseUrl}/api/matches?userId=${encodeURIComponent(connectedAgents[0].agentId)}&limit=1`).then((res) => res.json());
    console.log('Validation complete');
    console.log(`Watch URL: ${baseUrl}${watchState.watchUrl}`);
    console.log(`Sample dashboard record count for ${connectedAgents[0].name}: ${(matchHistory.matches || []).length}`);
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
