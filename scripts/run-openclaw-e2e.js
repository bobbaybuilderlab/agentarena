#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const handlerPath = path.join(repoRoot, 'examples', 'clawofdeceit-decision-handler', 'index.js');
const serverPath = path.join(repoRoot, 'server.js');
const DEFAULT_PORT = Number(process.env.PORT || 4174);
const DEFAULT_CONNECT_DELAY_MS = 4_000;
const DEFAULT_MONITOR_POLL_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_DISCONNECT_GRACE_MS = 120_000;
const DEFAULT_STALL_THRESHOLD_MS = 600_000;
const OPENCLAW_PROFILE = process.env.OPENCLAW_PROFILE || 'main';
const CONNECTOR_PLUGIN_ID = 'clawofdeceit-connect';
const BASE_AGENTS = [
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

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return '';
  return process.argv[idx + 1] || '';
}

function readNumberArg(flag, fallback) {
  const raw = readArg(flag).trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function canonicalPath(value) {
  const realpathSync = fs.realpathSync.native || fs.realpathSync;
  return realpathSync(value);
}

function resolveHomeDir(requested, needsTempHome) {
  if (requested) {
    fs.mkdirSync(requested, { recursive: true });
    return canonicalPath(requested);
  }
  if (!needsTempHome) return '';
  const tmpRoot = canonicalPath(os.tmpdir());
  return fs.mkdtempSync(path.join(tmpRoot, 'agent-arena-packaged-'));
}

function toEpochMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes || hours) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function parseDurationMs() {
  const durationSeconds = readNumberArg('--duration-seconds', NaN);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) return Math.round(durationSeconds * 1000);

  const durationMinutes = readNumberArg('--duration-minutes', NaN);
  if (Number.isFinite(durationMinutes) && durationMinutes > 0) return Math.round(durationMinutes * 60_000);

  const durationHours = readNumberArg('--duration-hours', NaN);
  if (Number.isFinite(durationHours) && durationHours > 0) return Math.round(durationHours * 3_600_000);

  return 0;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildAgentConfigs(agentCount) {
  if (!Number.isInteger(agentCount) || agentCount < 6) {
    throw new Error(`--agent-count must be an integer >= 6 (received ${agentCount})`);
  }

  const configs = [];
  for (let idx = 0; idx < agentCount; idx += 1) {
    const base = BASE_AGENTS[idx] || null;
    const name = base?.name || `Agent-${String(idx + 1).padStart(2, '0')}`;
    const style = base?.style || BASE_AGENTS[idx % BASE_AGENTS.length].style;
    configs.push({
      name,
      style,
      email: `${slugify(name)}@example.com`,
    });
  }
  return configs;
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

async function fetchJson(url, options, label = url) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText} ${body}`.trim());
    }
    return await res.json();
  } catch (err) {
    throw new Error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchWatchState(baseUrl) {
  return fetchJson(`${baseUrl}/api/play/watch`, undefined, 'watch state');
}

async function fetchMatchBaseline(baseUrl) {
  const data = await fetchJson(`${baseUrl}/api/ops/match-baseline?mode=mafia`, undefined, 'match baseline');
  const baseline = data?.baseline || {};
  return {
    sampleSize: Number(baseline.sampleSize || 0),
    latestCompletedAt: baseline.latestCompletedAt || null,
    latestCompletedAtMs: toEpochMs(baseline.latestCompletedAt),
    latestCompletedRoomId: baseline.latestCompletedRoomId || null,
    estimatedGamesPerHour: baseline.estimatedGamesPerHour || null,
  };
}

function summarizeMatchRecords(matches) {
  const items = Array.isArray(matches) ? matches : [];
  const latest = items[0] || null;
  const finishedAt = latest?.finished_at || latest?.finishedAt || null;
  return {
    sampleSize: items.length,
    latestCompletedAt: finishedAt,
    latestCompletedAtMs: toEpochMs(finishedAt),
    latestCompletedRoomId: latest?.room_id || latest?.roomId || null,
    estimatedGamesPerHour: null,
  };
}

async function fetchPlayerMatchSummary(baseUrl, agentId, limit = 50) {
  const data = await fetchJson(
    `${baseUrl}/api/matches?userId=${encodeURIComponent(agentId)}&limit=${Math.max(1, Math.min(limit, 50))}`,
    undefined,
    `match history for ${agentId}`
  );
  return summarizeMatchRecords(data?.matches || []);
}

function isOpsEndpointUnavailable(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('401')
    || message.includes('403')
    || message.includes('OPS_ADMIN_TOKEN')
    || message.toLowerCase().includes('unauthorized');
}

async function resolveCompletionTracker(baseUrl) {
  try {
    const baseline = await fetchMatchBaseline(baseUrl);
    return {
      mode: 'ops-baseline',
      baseline,
      description: '/api/ops/match-baseline',
    };
  } catch (err) {
    if (!isOpsEndpointUnavailable(err)) throw err;
    console.log('Falling back to public match history because /api/ops/match-baseline is not available.');
    return {
      mode: 'public-match-history',
      baseline: null,
      description: '/api/matches?userId=<agentId>',
    };
  }
}

async function fetchCompletionSummary(baseUrl, tracker, agentId) {
  if (tracker?.mode === 'public-match-history') {
    if (!agentId) {
      return {
        sampleSize: 0,
        latestCompletedAt: null,
        latestCompletedAtMs: 0,
        latestCompletedRoomId: null,
        estimatedGamesPerHour: null,
      };
    }
    return fetchPlayerMatchSummary(baseUrl, agentId);
  }
  return fetchMatchBaseline(baseUrl);
}

async function fetchAgentState(baseUrl, agentId) {
  const data = await fetchJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}`, undefined, `agent ${agentId}`);
  const arena = data?.agent?.arena || {};
  return {
    agentId,
    runtimeConnected: Boolean(arena.runtimeConnected),
    queueStatus: arena.queueStatus || 'offline',
    activeRoomId: arena.activeRoomId || null,
  };
}

async function waitForConnectSession(baseUrl, connect) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
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
    } catch (_err) {
      // keep polling until ready
    }
    await sleep(3_000);
  }
  throw new Error(`Timed out waiting for connect session ${connect.id} to connect`);
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

function packLocalPlugin() {
  return run(process.execPath, [path.join(repoRoot, 'scripts', 'pack-clawofdeceit-connect.js')]);
}

function trustConnector({ env, profile }) {
  const configFile = run('openclaw', ['--profile', profile, 'config', 'file'], { env });
  const nextAllow = [];
  if (fs.existsSync(configFile)) {
    try {
      const current = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const allow = current?.plugins?.allow;
      if (Array.isArray(allow)) nextAllow.push(...allow.filter((value) => typeof value === 'string' && value.trim()));
    } catch (_err) {
      // Fresh E2E profiles can safely rebuild the allowlist from config state.
    }
  }
  if (!nextAllow.includes(CONNECTOR_PLUGIN_ID)) nextAllow.push(CONNECTOR_PLUGIN_ID);
  run('openclaw', ['--profile', profile, 'config', 'set', 'plugins.allow', JSON.stringify(nextAllow), '--strict-json'], { env });
}

function installConnector({ env, profile, installSpec }) {
  const installArgs = ['--profile', profile, 'plugins', 'install'];
  if (!String(installSpec || '').endsWith('.tgz')) installArgs.push('--pin');
  installArgs.push(installSpec);
  run('openclaw', installArgs, { env });
  trustConnector({ env, profile });
  run('openclaw', ['--profile', profile, 'plugins', 'enable', CONNECTOR_PLUGIN_ID], { env });
}

function ensureOpenClawInstalled(env, profile) {
  const result = spawnSync('openclaw', ['--profile', profile, 'clawofdeceit', 'connect', '--help'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  if (result.status === 0) return;
  throw new Error(
    'OpenClaw Claw of Deceit connector is not available.\n'
    + `Expected \`openclaw --profile ${profile} clawofdeceit connect --help\` to work.\n`
    + `stderr: ${result.stderr || '(none)'}`
  );
}

function relevantPluginWarning(line) {
  return line.includes('plugins.allow')
    || line.includes('untracked local code')
    || line.includes('loaded without install/load-path provenance');
}

function runtimeNoise(line) {
  return line.includes('👀 Watching room')
    || line.includes('🏁 Match finished')
    || line.includes('🎯 Live in room')
    || line.includes('⏳ Arena status');
}

function attachChildOutput(child, prefix, {
  quietStructuredLogs = false,
  quietRuntimeLogs = false,
  pluginWarnings = null,
  onExit = null,
} = {}) {
  function write(chunk) {
    const text = String(chunk || '').replace(/\r\n/g, '\n');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (pluginWarnings && relevantPluginWarning(line)) pluginWarnings.add(line.trim());
      if (prefix === 'arena' && quietStructuredLogs && line.trim().startsWith('{')) continue;
      if (prefix !== 'arena' && quietRuntimeLogs && runtimeNoise(line)) continue;
      process.stdout.write(`[${prefix}] ${line}\n`);
    }
  }

  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('exit', (code, signal) => {
    if (typeof onExit === 'function') onExit(code, signal);
  });
}

function startServer(port, options = {}) {
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
  attachChildOutput(child, 'arena', options);
  return child;
}

function startAgentRuntime(baseUrl, connect, agentConfig, env, profile, options = {}) {
  const args = [
    '--profile',
    profile,
    'clawofdeceit',
    'connect',
    '--api',
    baseUrl,
    '--token',
    connect.id,
    '--callback',
    connect.callbackUrl,
    '--proof',
    String(connect.callbackProof || '').trim(),
    '--agent',
    agentConfig.name,
    '--style',
    agentConfig.style,
    '--decision-cmd',
    `node ${handlerPath}`,
  ];

  const child = spawn('openclaw', args, {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachChildOutput(child, agentConfig.name, options);
  return child;
}

function stopChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

function summarizeQueueCounts(states) {
  const counts = {};
  for (const state of states) {
    const key = state.queueStatus || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.keys(counts)
    .sort()
    .map((key) => `${key}:${counts[key]}`)
    .join(', ');
}

async function collectSoakSnapshot(baseUrl, connectedAgents, tracker) {
  const progressAgentId = connectedAgents[0]?.agentId || '';
  const [watch, baseline, states] = await Promise.all([
    fetchWatchState(baseUrl),
    fetchCompletionSummary(baseUrl, tracker, progressAgentId),
    Promise.all(connectedAgents.map((agent) => fetchAgentState(baseUrl, agent.agentId))),
  ]);
  const connectedCount = states.filter((entry) => entry.runtimeConnected).length;
  const activeRoomIds = [...new Set(states.map((entry) => entry.activeRoomId).filter(Boolean))];
  return {
    watch,
    baseline,
    states,
    connectedCount,
    queueCounts: summarizeQueueCounts(states),
    activeRoomIds,
  };
}

function describeExit(label, exitInfo) {
  return `${label} exited unexpectedly (code=${exitInfo.code}, signal=${exitInfo.signal || 'none'})`;
}

function maybeFailOnPluginWarnings(pluginWarnings) {
  if (!pluginWarnings.size || !hasFlag('--fail-on-plugin-warnings')) return;
  throw new Error(`Plugin trust warnings detected:\n${[...pluginWarnings].join('\n')}`);
}

async function runSoakLoop({
  baseUrl,
  connectedAgents,
  expectedAgentCount,
  completionTracker,
  durationMs,
  heartbeatMs,
  monitorPollMs,
  disconnectGraceMs,
  stallThresholdMs,
  getServerExit,
  runtimeRecords,
  pluginWarnings,
}) {
  const requiredMatchAgents = Math.min(6, expectedAgentCount);
  const soakStartedAt = Date.now();
  let lastHeartbeatAt = 0;
  let lowConnectedSince = null;
  let noLiveRoomSince = null;
  let fetchErrorSince = null;
  let lastCompletionAtMs = 0;
  let lastCompletionRoomId = null;
  let lastLiveRoomSeenAt = 0;
  let lastLiveRoomId = null;

  console.log(`Entering soak mode${durationMs ? ` for ${formatDuration(durationMs)}` : ''}.`);

  while (true) {
    const serverExit = getServerExit();
    if (serverExit) throw new Error(describeExit('Arena server', serverExit));

    const exitedRuntime = runtimeRecords.find((runtime) => runtime.unexpectedExit);
    if (exitedRuntime) {
      throw new Error(describeExit(`Runtime ${exitedRuntime.name}`, exitedRuntime.unexpectedExit));
    }

    let snapshot;
    try {
      snapshot = await collectSoakSnapshot(baseUrl, connectedAgents, completionTracker);
      fetchErrorSince = null;
    } catch (err) {
      if (!fetchErrorSince) fetchErrorSince = Date.now();
      if (Date.now() - fetchErrorSince > disconnectGraceMs) {
        throw new Error(`Lost backend visibility for ${formatDuration(Date.now() - fetchErrorSince)}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(monitorPollMs);
      continue;
    }

    maybeFailOnPluginWarnings(pluginWarnings);

    const now = Date.now();
    if (snapshot.baseline.latestCompletedAtMs > lastCompletionAtMs) {
      lastCompletionAtMs = snapshot.baseline.latestCompletedAtMs;
      lastCompletionRoomId = snapshot.baseline.latestCompletedRoomId || lastCompletionRoomId;
    }
    if (snapshot.watch.found) {
      lastLiveRoomSeenAt = now;
      lastLiveRoomId = snapshot.watch.roomId || lastLiveRoomId;
      noLiveRoomSince = null;
    } else if (snapshot.connectedCount >= requiredMatchAgents) {
      noLiveRoomSince = noLiveRoomSince || now;
    } else {
      noLiveRoomSince = null;
    }

    if (snapshot.connectedCount < expectedAgentCount) {
      lowConnectedSince = lowConnectedSince || now;
    } else {
      lowConnectedSince = null;
    }

    if (lowConnectedSince && now - lowConnectedSince > disconnectGraceMs) {
      throw new Error(`Connected agent count dropped to ${snapshot.connectedCount}/${expectedAgentCount} for ${formatDuration(now - lowConnectedSince)}`);
    }

    if (snapshot.connectedCount >= requiredMatchAgents && lastCompletionAtMs && now - lastCompletionAtMs > stallThresholdMs) {
      throw new Error(
        `No Mafia room finished for ${formatDuration(now - lastCompletionAtMs)} `
        + `(latest completed room: ${lastCompletionRoomId || 'unknown'})`
      );
    }

    if (snapshot.connectedCount >= requiredMatchAgents && noLiveRoomSince && now - noLiveRoomSince > disconnectGraceMs) {
      throw new Error(`No live watch room has been reported for ${formatDuration(now - noLiveRoomSince)} while ${snapshot.connectedCount} agents remain connected`);
    }

    if (!lastHeartbeatAt || now - lastHeartbeatAt >= heartbeatMs) {
      console.log(
        '[soak]'
        + ` uptime=${formatDuration(now - soakStartedAt)}`
        + ` connected=${snapshot.connectedCount}/${expectedAgentCount}`
        + ` liveRoom=${snapshot.watch.found ? snapshot.watch.roomId : 'none'}`
        + ` activeRooms=${snapshot.activeRoomIds.length || 0}`
        + ` completed=${snapshot.baseline.sampleSize}`
        + ` latestCompleted=${snapshot.baseline.latestCompletedRoomId || lastCompletionRoomId || 'none'}`
        + ` latestAt=${snapshot.baseline.latestCompletedAt || 'none'}`
        + ` queues=${snapshot.queueCounts || 'none'}`
        + ` warnings=${pluginWarnings.size}`
      );
      lastHeartbeatAt = now;
    }

    if (durationMs && now - soakStartedAt >= durationMs) {
      console.log(
        `Soak complete after ${formatDuration(now - soakStartedAt)} `
        + `(completed=${snapshot.baseline.sampleSize}, liveRoom=${snapshot.watch.found ? snapshot.watch.roomId : lastLiveRoomId || 'none'})`
      );
      return snapshot;
    }

    await sleep(monitorPollMs);
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/run-openclaw-e2e.js [options]');
    console.log('Connects real OpenClaw runtimes, validates the first Mafia match, and optionally keeps the arena running for a soak test.');
    console.log('Options:');
    console.log('  --base-url http://127.0.0.1:4173');
    console.log('  --pack-local');
    console.log('  --plugin-spec @clawofdeceit/clawofdeceit-connect');
    console.log('  --profile main');
    console.log('  --home /tmp/agent-arena-home');
    console.log('  --agent-count 6');
    console.log('  --connect-delay-ms 4000');
    console.log('  --keep-running');
    console.log('  --duration-seconds 600');
    console.log('  --duration-minutes 30');
    console.log('  --duration-hours 48');
    console.log('  --heartbeat-sec 60');
    console.log('  --poll-sec 10');
    console.log('  --disconnect-grace-sec 120');
    console.log('  --stall-threshold-sec 600');
    console.log('  --fail-on-plugin-warnings');
    process.exit(0);
  }

  const profile = readArg('--profile').trim() || OPENCLAW_PROFILE;
  const packLocal = hasFlag('--pack-local');
  const pluginSpecArg = readArg('--plugin-spec').trim();
  const suppliedBaseUrl = readArg('--base-url').trim();
  const homeDir = resolveHomeDir(readArg('--home').trim(), packLocal || pluginSpecArg);
  const env = homeDir ? { ...process.env, HOME: homeDir } : { ...process.env };
  const port = readNumberArg('--port', DEFAULT_PORT);
  const connectDelayMs = readNumberArg('--connect-delay-ms', DEFAULT_CONNECT_DELAY_MS);
  const agentCount = readNumberArg('--agent-count', 6);
  const agentConfigs = buildAgentConfigs(agentCount);
  const durationMs = parseDurationMs();
  const soakEnabled = hasFlag('--keep-running') || durationMs > 0;
  const heartbeatMs = Math.max(1_000, readNumberArg('--heartbeat-sec', DEFAULT_HEARTBEAT_MS / 1000) * 1000);
  const monitorPollMs = Math.max(1_000, readNumberArg('--poll-sec', DEFAULT_MONITOR_POLL_MS / 1000) * 1000);
  const disconnectGraceMs = Math.max(5_000, readNumberArg('--disconnect-grace-sec', DEFAULT_DISCONNECT_GRACE_MS / 1000) * 1000);
  const stallThresholdMs = Math.max(10_000, readNumberArg('--stall-threshold-sec', DEFAULT_STALL_THRESHOLD_MS / 1000) * 1000);
  const quietStructuredLogs = soakEnabled && !hasFlag('--verbose-server-logs');
  const quietRuntimeLogs = soakEnabled && !hasFlag('--verbose-runtime-logs');

  if (packLocal || pluginSpecArg) {
    const installSpec = packLocal ? packLocalPlugin() : pluginSpecArg;
    installConnector({ env, profile, installSpec });
  }
  ensureOpenClawInstalled(env, profile);

  const pluginWarnings = new Set();
  const baseUrl = suppliedBaseUrl || `http://127.0.0.1:${port}`;
  const runtimeRecords = [];
  const runtimes = [];
  let isShuttingDown = false;
  let validationComplete = false;
  let serverExitInfo = null;

  const server = suppliedBaseUrl
    ? null
    : startServer(port, {
      quietStructuredLogs,
      onExit: (code, signal) => {
        if (isShuttingDown) return;
        serverExitInfo = {
          code,
          signal,
          at: Date.now(),
        };
      },
    });

  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    runtimes.forEach(stopChild);
    stopChild(server);
  };

  process.on('SIGINT', () => {
    shutdown();
    process.exit(soakEnabled && validationComplete && !durationMs ? 0 : 1);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(soakEnabled && validationComplete && !durationMs ? 0 : 1);
  });

  try {
    await waitForJson(`${baseUrl}/health`, 15_000);
    console.log(`${suppliedBaseUrl ? 'Using existing' : 'Local'} arena at ${baseUrl}`);

    const completionTracker = await resolveCompletionTracker(baseUrl);
    let baselineBefore = completionTracker.baseline;
    const connectedAgents = [];

    for (const agentConfig of agentConfigs) {
      const sessionData = await fetchJson(`${baseUrl}/api/openclaw/connect-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: agentConfig.email }),
      }, `connect session for ${agentConfig.name}`);
      if (!sessionData.ok) throw new Error(`Failed to create connect session for ${agentConfig.name}`);

      const connect = sessionData.connect;
      if (!connect.callbackProof) throw new Error(`Missing callback proof for ${agentConfig.name}`);

      const runtimeRecord = {
        name: agentConfig.name,
        connectId: connect.id,
        agentId: null,
        unexpectedExit: null,
      };

      const runtime = startAgentRuntime(baseUrl, connect, agentConfig, env, profile, {
        pluginWarnings,
        quietRuntimeLogs,
        onExit: (code, signal) => {
          if (isShuttingDown) return;
          runtimeRecord.unexpectedExit = {
            code,
            signal,
            at: Date.now(),
          };
          process.stderr.write(`[${agentConfig.name}] Runtime exited unexpectedly code=${code} signal=${signal || 'none'}\n`);
        },
      });

      runtimes.push(runtime);
      runtimeRecords.push(runtimeRecord);

      const connectedState = await waitForConnectSession(baseUrl, connect);
      runtimeRecord.agentId = connectedState.agentId;

      const connected = {
        name: agentConfig.name,
        agentId: connectedState.agentId,
        connectId: connectedState.connectId,
      };

      connectedAgents.push(connected);
      console.log(`Connected ${agentConfig.name} as ${connected.agentId}`);
      if (connectDelayMs > 0) await sleep(connectDelayMs);
    }

    maybeFailOnPluginWarnings(pluginWarnings);

    if (!baselineBefore) {
      baselineBefore = await fetchCompletionSummary(baseUrl, completionTracker, connectedAgents[0]?.agentId || '');
    }

    const watchState = await waitFor(async () => {
      const data = await fetchWatchState(baseUrl);
      return data?.ok && data.found ? data : null;
    }, 20_000, 'Timed out waiting for a live Mafia room');

    console.log(`Live room opened: ${watchState.roomId}`);

    const firstCompletion = await waitFor(async () => {
      const baseline = await fetchCompletionSummary(baseUrl, completionTracker, connectedAgents[0]?.agentId || '');
      if (baseline.sampleSize > baselineBefore.sampleSize) return baseline;
      if (baseline.latestCompletedAt && baseline.latestCompletedAt !== baselineBefore.latestCompletedAt) return baseline;
      return null;
    }, 30_000, 'Timed out waiting for the first Mafia room to finish');

    console.log(`Match ${watchState.roomId} finished`);

    for (const agent of connectedAgents) {
      await waitFor(async () => {
        const state = await fetchAgentState(baseUrl, agent.agentId);
        return state.runtimeConnected === true;
      }, 10_000, `Timed out waiting for ${agent.name} runtime to stay connected`);
    }

    validationComplete = true;

    const currentWatch = await fetchWatchState(baseUrl).catch(() => watchState);
    const matchHistory = await fetchJson(
      `${baseUrl}/api/matches?userId=${encodeURIComponent(connectedAgents[0].agentId)}&limit=1`,
      undefined,
      `match history for ${connectedAgents[0].name}`
    );

    console.log('Validation complete');
    console.log(`Watch URL: ${baseUrl}${currentWatch.watchUrl || watchState.watchUrl}`);
    console.log(`Sample match record count for ${connectedAgents[0].name}: ${(matchHistory.matches || []).length}`);
    console.log(`Plugin warning count: ${pluginWarnings.size}`);
    console.log(`Completion source: ${completionTracker.description}`);

    if (!soakEnabled) return;

    await runSoakLoop({
      baseUrl,
      connectedAgents,
      expectedAgentCount: agentConfigs.length,
      completionTracker,
      durationMs,
      heartbeatMs,
      monitorPollMs,
      disconnectGraceMs,
      stallThresholdMs,
      getServerExit: () => serverExitInfo,
      runtimeRecords,
      pluginWarnings,
    });
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
