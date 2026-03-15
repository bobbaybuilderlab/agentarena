#!/usr/bin/env node

const { spawn } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const serverPath = path.join(repoRoot, 'server.js');
const DEFAULT_PORT = Number(process.env.PORT || 4174);
const DEFAULT_CONNECT_DELAY_MS = 4_000;
const DEFAULT_MONITOR_POLL_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_DISCONNECT_GRACE_MS = 120_000;
const DEFAULT_STALL_THRESHOLD_MS = 600_000;
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
      email: `${slugify(name)}@e2e.test`,
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

// --- Decision logic (inline, mirrors examples/clawofdeceit-decision-handler) ---

function chooseTarget(players, playerId) {
  const candidates = (players || []).filter((p) => p && p.id && p.id !== playerId);
  return candidates[0] || null;
}

function handleGameEvent(eventName, payload) {
  const target = chooseTarget(payload.players || [], String(payload.playerId || ''));

  if (eventName === 'mafia:agent:discussion_request') {
    const name = target?.name || 'the quiet seat';
    return { type: 'ready', message: `I'm circling ${name}. Their timing is just a little too clean.` };
  }
  if (!target) throw new Error('No valid target available');
  if (eventName === 'mafia:agent:night_request') {
    return { type: 'nightKill', targetId: target.id };
  }
  if (eventName === 'mafia:agent:vote_request') {
    return { type: 'vote', targetId: target.id };
  }
  throw new Error(`Unsupported event: ${eventName}`);
}

// --- Agent connection via Socket.IO ---

async function connectAgent(baseUrl, agentConfig) {
  const { io: ioc } = require('socket.io-client');

  // Register account
  const regData = await fetchJson(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: agentConfig.email, displayName: agentConfig.name }),
  }, `register ${agentConfig.name}`);
  if (!regData.ok) throw new Error(`Registration failed for ${agentConfig.name}: ${regData.error || 'unknown'}`);
  const token = regData.session.token;
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // Create pending agent
  const createData = await fetchJson(`${baseUrl}/api/openclaw/create-agent`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  }, `create-agent ${agentConfig.name}`);
  if (!createData.ok) throw new Error(`create-agent failed for ${agentConfig.name}: ${createData.error || 'unknown'}`);
  const agentId = createData.agentId;

  // Activate via callback
  const callbackData = await fetchJson(`${baseUrl}/api/openclaw/callback`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ agentId, agentName: agentConfig.name, style: agentConfig.style }),
  }, `callback ${agentConfig.name}`);
  if (!callbackData.ok) throw new Error(`callback failed for ${agentConfig.name}: ${callbackData.error || 'unknown'}`);

  // Connect via Socket.IO
  const socket = ioc(baseUrl, { reconnection: true, autoUnref: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`socket connect timeout for ${agentConfig.name}`)), 10_000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
  });

  // Register runtime
  const registerResult = await new Promise((resolve) => {
    socket.emit('agent:runtime:register', { token, agentId }, resolve);
  });
  if (!registerResult.ok) {
    socket.disconnect();
    throw new Error(`runtime register failed for ${agentConfig.name}: ${registerResult.error?.message || 'unknown'}`);
  }

  // Listen for game events
  for (const eventName of ['mafia:agent:night_request', 'mafia:agent:discussion_request', 'mafia:agent:vote_request']) {
    socket.on(eventName, (payload, cb) => {
      try {
        const decision = handleGameEvent(eventName, payload);
        socket.emit('mafia:agent:decision', { ...decision, roomId: payload.roomId }, (ack) => {
          if (ack && !ack.ok) {
            process.stderr.write(`[${agentConfig.name}] decision rejected: ${ack.error || 'unknown'}\n`);
          }
        });
      } catch (err) {
        process.stderr.write(`[${agentConfig.name}] decision error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      if (typeof cb === 'function') cb({ ok: true });
    });
  }

  return { agentId, token, socket };
}

// --- Server management ---

function attachChildOutput(child, prefix, {
  quietStructuredLogs = false,
  onExit = null,
} = {}) {
  function write(chunk) {
    const text = String(chunk || '').replace(/\r\n/g, '\n');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (prefix === 'arena' && quietStructuredLogs && line.trim().startsWith('{')) continue;
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

function stopChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

// --- Soak monitoring ---

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

    // Check socket disconnections
    const disconnected = connectedAgents.find((a) => a.socket && !a.socket.connected);
    if (disconnected) {
      process.stderr.write(`[soak] ${disconnected.name} socket disconnected\n`);
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

// --- Main ---

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/run-openclaw-e2e.js [options]');
    console.log('Connects agents via account-based auth, validates the first Mafia match, and optionally soak-tests.');
    console.log('Options:');
    console.log('  --base-url http://127.0.0.1:4174');
    console.log('  --port 4174');
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
    process.exit(0);
  }

  const suppliedBaseUrl = readArg('--base-url').trim();
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

  const baseUrl = suppliedBaseUrl || `http://127.0.0.1:${port}`;
  const connectedAgents = [];
  let isShuttingDown = false;
  let validationComplete = false;
  let serverExitInfo = null;

  const server = suppliedBaseUrl
    ? null
    : startServer(port, {
      quietStructuredLogs,
      onExit: (code, signal) => {
        if (isShuttingDown) return;
        serverExitInfo = { code, signal, at: Date.now() };
      },
    });

  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    for (const agent of connectedAgents) {
      if (agent.socket) agent.socket.disconnect();
    }
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

    for (const agentConfig of agentConfigs) {
      const result = await connectAgent(baseUrl, agentConfig);
      connectedAgents.push({
        name: agentConfig.name,
        agentId: result.agentId,
        token: result.token,
        socket: result.socket,
      });
      console.log(`Connected ${agentConfig.name} as ${result.agentId}`);
      if (connectDelayMs > 0) await sleep(connectDelayMs);
    }

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
    });
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
