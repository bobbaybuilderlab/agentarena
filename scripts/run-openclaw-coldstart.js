#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const handlerPath = path.join(repoRoot, 'examples', 'agentarena-decision-handler', 'index.js');
const serverPath = path.join(repoRoot, 'server.js');
const DEFAULT_PORT = Number(process.env.PORT || 4175);

function relevantPluginWarning(line) {
  return line.includes('plugins.allow')
    || line.includes('untracked local code')
    || line.includes('loaded without install/load-path provenance');
}

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
    return {
      res,
      data: await res.json(),
    };
  } catch (err) {
    throw new Error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function attachChildOutput(child, prefix, pluginWarnings = null) {
  function write(chunk) {
    const text = String(chunk || '').replace(/\r\n/g, '\n');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (pluginWarnings && relevantPluginWarning(line)) pluginWarnings.add(line.trim());
      process.stdout.write(`[${prefix}] ${line}\n`);
    }
  }

  child.stdout.on('data', write);
  child.stderr.on('data', write);
}

function maybeFailOnPluginWarnings(pluginWarnings) {
  if (!pluginWarnings.size || !hasFlag('--fail-on-plugin-warnings')) return;
  throw new Error(`Plugin trust warnings detected:\n${[...pluginWarnings].join('\n')}`);
}

function run(cmd, args, { cwd = repoRoot, env = process.env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `${cmd} ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function ensureOpenClawInstalled(profile, env) {
  const result = spawnSync('openclaw', ['--profile', profile, '--help'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  if (result.status === 0) return;
  throw new Error(`OpenClaw is not available.\n${result.stderr || ''}`.trim());
}

function packLocalPlugin() {
  return run(process.execPath, [path.join(repoRoot, 'scripts', 'pack-openclaw-connect.js')], { cwd: repoRoot });
}

function installConnector({ profile, env, installSpec }) {
  const installArgs = ['--profile', profile, 'plugins', 'install'];
  if (!String(installSpec || '').endsWith('.tgz')) installArgs.push('--pin');
  installArgs.push(installSpec);
  run('openclaw', installArgs, { env });
  run('openclaw', ['--profile', profile, 'plugins', 'enable', 'openclaw-connect'], { env });
  run('openclaw', ['--profile', profile, 'agentarena', 'connect', '--help'], { env });
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
  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

function startRuntime({ profile, env, baseUrl, connect, agentName, style, pluginWarnings }) {
  const child = spawn('openclaw', [
    '--profile',
    profile,
    'agentarena',
    'connect',
    '--api',
    baseUrl,
    '--token',
    connect.id,
    '--callback',
    connect.callbackUrl,
    '--proof',
    connect.callbackProof,
    '--agent',
    agentName,
    '--style',
    style,
    '--decision-cmd',
    `node ${handlerPath}`,
  ], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachChildOutput(child, 'coldstart', pluginWarnings);
  child.on('exit', (code, signal) => {
    process.stdout.write(`[coldstart] runtime exited code=${code} signal=${signal || 'none'}\n`);
  });
  return child;
}

function stopChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

async function main() {
  if (hasFlag('--help')) {
    console.log('Usage: node scripts/run-openclaw-coldstart.js [--base-url URL] [--pack-local] [--plugin-spec @agentarena/openclaw-connect] [--fail-on-plugin-warnings]');
    process.exit(0);
  }

  const profile = readArg('--profile') || 'coldstart';
  const suppliedBaseUrl = readArg('--base-url').trim();
  const pluginSpecArg = readArg('--plugin-spec').trim();
  const packLocal = hasFlag('--pack-local');
  const homeDir = readArg('--home').trim() || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-arena-cold-'));
  const env = { ...process.env, HOME: homeDir };
  const agentName = readArg('--agent') || 'arena_agent';
  const style = readArg('--style') || 'witty';
  const port = Number(readArg('--port') || DEFAULT_PORT);
  const pluginWarnings = new Set();

  ensureOpenClawInstalled(profile, env);

  const started = suppliedBaseUrl ? { child: null, baseUrl: suppliedBaseUrl } : startServer(port);
  const baseUrl = started.baseUrl;
  let runtime = null;

  try {
    const health = await waitForJson(`${baseUrl}/health`, 20_000);
    if (!health?.ok) throw new Error('Agent Arena health check failed');

    const { data: createData } = await fetchJson(`${baseUrl}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, 'connect-session');
    if (!createData.ok) throw new Error(createData.error || 'connect-session failed');

    const connect = createData.connect;
    if (!connect?.onboarding?.installerCommand) throw new Error('Missing onboarding installer command');
    if (!connect?.callbackProof) throw new Error('Missing callback proof');

    const installSpec = packLocal ? packLocalPlugin() : (pluginSpecArg || connect.onboarding.pluginPackage || '@agentarena/openclaw-connect');
    installConnector({ profile, env, installSpec });

    runtime = startRuntime({ profile, env, baseUrl, connect, agentName, style, pluginWarnings });

    const connected = await waitFor(async () => {
      try {
        const statusRes = await fetch(`${baseUrl}/api/openclaw/connect-session/${connect.id}?accessToken=${encodeURIComponent(connect.accessToken)}`);
        if (!statusRes.ok) return null;
        const statusData = await statusRes.json();
        if (statusData?.connect?.status === 'connected' && statusData.connect?.arena?.runtimeConnected) return statusData.connect;
        return null;
      } catch (_err) {
        return null;
      }
    }, 20_000, 'Timed out waiting for cold-start connection');

    const { data: watchState } = await fetchJson(`${baseUrl}/api/play/watch`, undefined, 'watch state');
    if (!watchState?.ok) throw new Error('Watch API failed');
    if (Number(watchState.connectedAgents || 0) < 1) throw new Error('Expected at least one connected agent');
    maybeFailOnPluginWarnings(pluginWarnings);

    console.log(JSON.stringify({
      ok: true,
      profile,
      homeDir,
      baseUrl,
      agentId: connected.agentId,
      queueStatus: connected.arena?.queueStatus || null,
      connectedAgents: watchState.connectedAgents,
      missingAgents: watchState.missingAgents,
      installer: connect.onboarding.installerCommand,
      installSpec,
      pluginWarningCount: pluginWarnings.size,
    }, null, 2));
  } finally {
    stopChild(runtime);
    await sleep(500);
    stopChild(started.child);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
