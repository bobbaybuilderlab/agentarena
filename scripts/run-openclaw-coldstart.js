#!/usr/bin/env node

const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const serverPath = path.join(repoRoot, 'server.js');
const DEFAULT_PORT = Number(process.env.PORT || 4175);

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return '';
  return process.argv[idx + 1] || '';
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(500);
  }
  throw new Error(message);
}

async function waitForJson(url, timeoutMs = 15_000) {
  return waitFor(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await res.json();
    } catch (_err) {
      return null;
    }
  }, timeoutMs, `Timed out waiting for ${url}`);
}

async function fetchJson(url, options, label = url) {
  try {
    const res = await fetch(url, options);
    return { res, data: await res.json() };
  } catch (err) {
    throw new Error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function attachChildOutput(child, prefix) {
  function write(chunk) {
    const text = String(chunk || '').replace(/\r\n/g, '\n');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      process.stdout.write(`[${prefix}] ${line}\n`);
    }
  }
  child.stdout.on('data', write);
  child.stderr.on('data', write);
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
  attachChildOutput(child, 'arena');
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

function stopChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

async function main() {
  if (hasFlag('--help')) {
    console.log('Usage: node scripts/run-openclaw-coldstart.js [--base-url URL] [--port PORT] [--agent NAME] [--style STYLE]');
    process.exit(0);
  }

  const suppliedBaseUrl = readArg('--base-url').trim();
  const agentName = readArg('--agent') || 'arena_agent';
  const style = readArg('--style') || 'witty';
  const port = Number(readArg('--port') || DEFAULT_PORT);

  const started = suppliedBaseUrl ? { child: null, baseUrl: suppliedBaseUrl } : startServer(port);
  const baseUrl = started.baseUrl;

  try {
    const health = await waitForJson(`${baseUrl}/health`, 20_000);
    if (!health?.ok) throw new Error('Claw of Deceit health check failed');

    // Register an account
    const { data: regData } = await fetchJson(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${agentName}@coldstart.test`, displayName: agentName }),
    }, 'register');
    if (!regData.ok) throw new Error(regData.error || 'registration failed');
    const token = regData.session.token;

    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    // Create a pending agent
    const { data: createData } = await fetchJson(`${baseUrl}/api/openclaw/create-agent`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    }, 'create-agent');
    if (!createData.ok) throw new Error(createData.error || 'create-agent failed');
    const agentId = createData.agentId;

    // Activate via callback
    const { data: callbackData } = await fetchJson(`${baseUrl}/api/openclaw/callback`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ agentId, agentName, style }),
    }, 'callback');
    if (!callbackData.ok) throw new Error(callbackData.error || 'callback failed');

    // Connect via Socket.IO
    const { io: ioc } = require('socket.io-client');
    const socket = ioc(baseUrl, { reconnection: false, autoUnref: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 10_000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
    });

    const registerResult = await new Promise((resolve) => {
      socket.emit('agent:runtime:register', { token, agentId }, resolve);
    });
    if (!registerResult.ok) throw new Error(`runtime register failed: ${registerResult.error?.message || 'unknown'}`);

    // Verify agent is online
    const { data: watchState } = await fetchJson(`${baseUrl}/api/play/watch`, undefined, 'watch state');
    if (!watchState?.ok) throw new Error('Watch API failed');
    if (Number(watchState.connectedAgents || 0) < 1) throw new Error('Expected at least one connected agent');

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      agentId,
      agentName: callbackData.agent.name,
      queueStatus: registerResult.arena?.queueStatus || null,
      connectedAgents: watchState.connectedAgents,
      missingAgents: watchState.missingAgents,
    }, null, 2));

    socket.disconnect();
  } finally {
    await sleep(500);
    stopChild(started.child);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
