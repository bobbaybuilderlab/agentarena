#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const {
  server,
  agentProfiles,
  liveAgentRuntimes,
  connectSessions,
  buildMatchBaseline,
} = require('../server');

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MANUAL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CONNECT_DELAY_MS = 3_000;
const DEFAULT_MANUAL_GATEWAY_PORT = 19031;
const DEFAULT_PREFLIGHT_GATEWAY_PORT_OFFSET = 100;
const DEFAULT_PREFLIGHT_TIMEOUT_SEC = 90;
const CONNECTOR_PLUGIN_ID = 'clawofdeceit-connect';
const CONNECTOR_PLUGIN_SPEC = '@clawofdeceit/clawofdeceit-connect';
const MANUAL_PROFILE = 'founder-floor-manual';
const AUTO_PROFILE = 'founder-floor-auto';
const DEFAULT_MANUAL_BOOTSTRAP_PROFILES = ['founder-quick', 'main'];
const PREFLIGHT_AGENT_ID = 'main';
const PREFLIGHT_SESSION_ID = 'founder-floor-preflight';
const PREFLIGHT_MESSAGE = 'Reply with READY only.';
const DEFAULT_OPENCLAW_COMMANDS = {
  native: 'auto',
  nativeSkills: 'auto',
  restart: true,
  ownerDisplay: 'raw',
};
const AUTO_AGENTS = [
  { name: 'Bravo', preset: 'chaotic', style: 'chaotic preacher', email: 'bravo@example.com' },
  { name: 'Charlie', preset: 'analytical', style: 'analytical tactician', email: 'charlie@example.com' },
  { name: 'Delta', preset: 'serious', style: 'serious prosecutor', email: 'delta@example.com' },
  { name: 'Echo', preset: 'paranoid', style: 'paranoid detective', email: 'echo@example.com' },
  { name: 'Foxtrot', preset: 'arrogant', style: 'arrogant shot-caller', email: 'foxtrot@example.com' },
];

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function summarizeText(value, maxLength = 240) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function canonicalPath(value) {
  const realpathSync = fs.realpathSync.native || fs.realpathSync;
  return realpathSync(value);
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function expandHomePath(value, homeDir = os.homedir()) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/')) return path.join(homeDir, raw.slice(2));
  return raw;
}

function resolveConfigFilePath(rawPath, homeDir) {
  const expanded = expandHomePath(rawPath, homeDir);
  if (!expanded) return expanded;
  return path.isAbsolute(expanded) ? expanded : path.resolve(homeDir, expanded);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function resolveBaseUrl(port, host) {
  return `http://${host}:${port}`;
}

function resolveRootDir(customRoot) {
  if (customRoot) {
    fs.mkdirSync(customRoot, { recursive: true });
    return canonicalPath(customRoot);
  }
  const root = fs.mkdtempSync(path.join(canonicalPath('/tmp'), 'claw-hybrid-'));
  return canonicalPath(root);
}

function resolveHomeDir(target, fallback) {
  const chosen = target || fallback;
  fs.mkdirSync(chosen, { recursive: true });
  return canonicalPath(chosen);
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildProfileEnv(homeDir, gatewayToken = '') {
  const env = {
    ...process.env,
    HOME: homeDir,
  };
  if (gatewayToken) env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
  return env;
}

function waitFor(condition, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    async function poll() {
      try {
        const result = await condition();
        if (result) return resolve(result);
        if (Date.now() >= deadline) return reject(new Error(message));
        setTimeout(poll, 750);
      } catch (err) {
        reject(err);
      }
    }

    void poll();
  });
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

function ensureOpenClawInstalled() {
  const result = spawnSync('openclaw', ['--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) return;
  throw new Error(`OpenClaw is not available.\n${result.stderr || ''}`.trim());
}

function resolveOpenClawBinary() {
  const result = spawnSync('which', ['openclaw'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Could not resolve the OpenClaw binary path.\n${result.stderr || ''}`.trim());
  }
  return canonicalPath(result.stdout.trim());
}

function trustConnector({ env, profile }) {
  const configFile = resolveConfigFilePath(
    run('openclaw', ['--profile', profile, 'config', 'file'], { env }),
    env.HOME || os.homedir(),
  );
  const nextAllow = [];
  if (fs.existsSync(configFile)) {
    try {
      const current = readJsonFile(configFile);
      const allow = current?.plugins?.allow;
      if (Array.isArray(allow)) nextAllow.push(...allow.filter((value) => typeof value === 'string' && value.trim()));
    } catch (_err) {
      // Fresh profiles can rebuild the allowlist.
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

function attachChildOutput(child, prefix, { onExit } = {}) {
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
  child.on('exit', (code, signal) => {
    if (typeof onExit === 'function') onExit(code, signal);
  });
}

function stopChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

function listBootstrapCandidates(requestedProfile) {
  return uniqueNonEmpty(requestedProfile ? [requestedProfile] : DEFAULT_MANUAL_BOOTSTRAP_PROFILES);
}

function resolveBootstrapProfileConfig(profile) {
  const normalizedProfile = String(profile || '').trim();
  if (!normalizedProfile) {
    throw new Error('Missing bootstrap OpenClaw profile name.');
  }

  const bootstrapHome = os.homedir();
  const rawPath = run('openclaw', ['--profile', normalizedProfile, 'config', 'file'], {
    env: { ...process.env, HOME: bootstrapHome },
  });
  const configPath = resolveConfigFilePath(rawPath, bootstrapHome);
  if (!configPath || !fs.existsSync(configPath)) {
    throw new Error(`Bootstrap profile "${normalizedProfile}" is missing a config file.`);
  }
  const config = readJsonFile(configPath);
  if (!config?.agents?.defaults?.model?.primary) {
    throw new Error(`Bootstrap profile "${normalizedProfile}" does not define a primary model.`);
  }
  const authProfilesPath = path.join(path.dirname(configPath), 'agents', 'main', 'agent', 'auth-profiles.json');
  return { profile: normalizedProfile, configPath, config, authProfilesPath };
}

function seedManualProfile({
  manualHome,
  manualProfile,
  manualGatewayPort,
  manualGatewayToken,
  bootstrapProfileName,
}) {
  const env = buildProfileEnv(manualHome);
  const bootstrap = resolveBootstrapProfileConfig(bootstrapProfileName);
  const rawConfigPath = run('openclaw', ['--profile', manualProfile, 'config', 'file'], { env });
  const configPath = resolveConfigFilePath(rawConfigPath, manualHome);
  const manualWorkspace = path.join(manualHome, 'workspace');
  const manualAgentDir = path.join(path.dirname(configPath), 'agents', 'main', 'agent');
  const existingConfig = configPath && fs.existsSync(configPath) ? readJsonFile(configPath) : {};
  const bootstrapDefaults = bootstrap.config?.agents?.defaults || {};
  const existingDefaults = existingConfig?.agents?.defaults || {};
  const nextConfig = {
    ...existingConfig,
    agents: {
      ...(existingConfig.agents || {}),
      defaults: {
        ...existingDefaults,
        ...(existingDefaults.model ? {} : bootstrapDefaults.model ? { model: bootstrapDefaults.model } : {}),
        ...(existingDefaults.compaction ? {} : bootstrapDefaults.compaction ? { compaction: bootstrapDefaults.compaction } : {}),
        workspace: manualWorkspace,
      },
    },
    commands: Object.keys(existingConfig.commands || {}).length > 0
      ? existingConfig.commands
      : (bootstrap.config?.commands || DEFAULT_OPENCLAW_COMMANDS),
    gateway: {
      ...(existingConfig.gateway || {}),
      port: manualGatewayPort,
      mode: 'local',
      bind: 'loopback',
      auth: {
        mode: 'token',
        token: manualGatewayToken,
      },
    },
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(manualWorkspace, { recursive: true });
  fs.mkdirSync(manualAgentDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  if (bootstrap.authProfilesPath && fs.existsSync(bootstrap.authProfilesPath)) {
    fs.copyFileSync(bootstrap.authProfilesPath, path.join(manualAgentDir, 'auth-profiles.json'));
  }

  return {
    bootstrapProfile: bootstrap.profile,
    bootstrapConfigPath: bootstrap.configPath,
    bootstrapAuthProfilesPath: bootstrap.authProfilesPath,
    configPath,
    workspace: manualWorkspace,
    agentDir: manualAgentDir,
  };
}

function buildOpenClawCommand(manualHome, manualProfile, manualGatewayToken, args = []) {
  const parts = [
    `HOME=${shellQuote(manualHome)}`,
    `OPENCLAW_GATEWAY_TOKEN=${shellQuote(manualGatewayToken)}`,
    'openclaw',
    '--profile',
    shellQuote(manualProfile),
    ...args.map((arg) => shellQuote(arg)),
  ];
  return parts.join(' ');
}

function writeManualShellWrapper({ manualHome, manualProfile, manualGatewayPort, manualGatewayToken }) {
  const wrapperDir = path.join(manualHome, 'bin');
  const wrapperPath = path.join(wrapperDir, 'openclaw');
  const realOpenClaw = resolveOpenClawBinary();
  const shellPath = path.join(manualHome, 'use-openclaw-onboarding.sh');

  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(wrapperPath, [
    '#!/bin/sh',
    `export HOME=${shellQuote(manualHome)}`,
    `export OPENCLAW_GATEWAY_TOKEN=${shellQuote(manualGatewayToken)}`,
    `exec ${shellQuote(realOpenClaw)} --profile ${shellQuote(manualProfile)} "$@"`,
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(wrapperPath, 0o755);

  fs.writeFileSync(shellPath, [
    `export PATH=${shellQuote(wrapperDir)}:"$PATH"`,
    `export HOME=${shellQuote(manualHome)}`,
    `export OPENCLAW_GATEWAY_TOKEN=${shellQuote(manualGatewayToken)}`,
    'echo "Fresh OpenClaw onboarding shell ready."',
    `echo "HOME=${manualHome}"`,
    `echo "Profile=${manualProfile}"`,
    `echo "Gateway=ws://127.0.0.1:${manualGatewayPort}"`,
    'echo "In this shell, plain openclaw commands now target the fresh test profile."',
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(shellPath, 0o755);

  return {
    wrapperDir,
    wrapperPath,
    shellPath,
  };
}

function buildManualCommands(manualHome, manualProfile, manualGatewayToken) {
  return {
    tuiCommand: buildOpenClawCommand(manualHome, manualProfile, manualGatewayToken, ['tui']),
    gatewayHealthCommand: buildOpenClawCommand(manualHome, manualProfile, manualGatewayToken, ['gateway', 'health']),
  };
}

function startManualGateway({ manualHome, manualProfile, manualGatewayPort, manualGatewayToken }) {
  const env = buildProfileEnv(manualHome, manualGatewayToken);

  const child = spawn('openclaw', [
    '--profile',
    manualProfile,
    'gateway',
    'run',
    '--port',
    String(manualGatewayPort),
    '--auth',
    'token',
    '--token',
    manualGatewayToken,
  ], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  attachChildOutput(child, 'manual-gateway');
  return child;
}

async function waitForManualGateway({ manualHome, manualProfile, manualGatewayToken, manualGatewayPort }) {
  const env = buildProfileEnv(manualHome, manualGatewayToken);

  return waitFor(async () => {
    const result = spawnSync('openclaw', [
      '--profile',
      manualProfile,
      'gateway',
      'health',
    ], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    if (result.status === 0) return true;
    return null;
  }, 20_000, `Timed out waiting for the manual OpenClaw gateway on port ${manualGatewayPort}`);
}

function runManualPreflight({ manualHome, manualProfile, manualGatewayToken, timeoutSec = DEFAULT_PREFLIGHT_TIMEOUT_SEC }) {
  const env = buildProfileEnv(manualHome, manualGatewayToken);
  const args = [
    '--profile',
    manualProfile,
    'agent',
    '--agent',
    PREFLIGHT_AGENT_ID,
    '--session-id',
    PREFLIGHT_SESSION_ID,
    '--message',
    PREFLIGHT_MESSAGE,
    '--json',
    '--timeout',
    String(timeoutSec),
  ];
  const result = spawnSync('openclaw', args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: (timeoutSec + 10) * 1000,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `Manual preflight failed: openclaw ${args.join(' ')}`);
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (!output) {
    throw new Error('Manual preflight failed: OpenClaw returned no output for the preflight agent turn.');
  }
  return output;
}

async function verifyBootstrapCandidate({
  preflightHome,
  manualProfile,
  bootstrapProfileName,
  manualGatewayPort,
  preflightGatewayPort,
}) {
  const preflightGatewayToken = randomToken();
  const seed = seedManualProfile({
    manualHome: preflightHome,
    manualProfile,
    manualGatewayPort: preflightGatewayPort,
    manualGatewayToken: preflightGatewayToken,
    bootstrapProfileName,
  });
  const gateway = startManualGateway({
    manualHome: preflightHome,
    manualProfile,
    manualGatewayPort: preflightGatewayPort,
    manualGatewayToken: preflightGatewayToken,
  });

  try {
    await waitForManualGateway({
      manualHome: preflightHome,
      manualProfile,
      manualGatewayToken: preflightGatewayToken,
      manualGatewayPort: preflightGatewayPort,
    });
    const output = runManualPreflight({
      manualHome: preflightHome,
      manualProfile,
      manualGatewayToken: preflightGatewayToken,
    });
    return {
      seed,
      gatewayToken: preflightGatewayToken,
      output,
      gatewayPort: preflightGatewayPort,
    };
  } finally {
    stopChild(gateway);
  }
}

async function prepareManualSeat({
  preflightHome,
  manualHome,
  manualProfile,
  manualGatewayPort,
  manualGatewayToken,
  requestedBootstrapProfile,
}) {
  const candidates = listBootstrapCandidates(requestedBootstrapProfile);
  const attempts = [];
  let lastError = null;

  for (const [index, candidate] of candidates.entries()) {
    const candidatePreflightHome = resolveHomeDir('', path.join(preflightHome, `${String(index + 1).padStart(2, '0')}-${slugify(candidate) || 'bootstrap'}`));
    const preflightGatewayPort = manualGatewayPort + DEFAULT_PREFLIGHT_GATEWAY_PORT_OFFSET + index;
    try {
      const preflight = await verifyBootstrapCandidate({
        preflightHome: candidatePreflightHome,
        manualProfile,
        bootstrapProfileName: candidate,
        manualGatewayPort,
        preflightGatewayPort,
      });
      const seed = seedManualProfile({
        manualHome,
        manualProfile,
        manualGatewayPort,
        manualGatewayToken,
        bootstrapProfileName: candidate,
      });
      attempts.push({
        profile: candidate,
        ok: true,
        message: `Preflight passed on ws://127.0.0.1:${preflight.gatewayPort}`,
      });
      return {
        manualSeed: seed,
        preflight,
        attempts,
        bootstrapProfile: candidate,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      attempts.push({
        profile: candidate,
        ok: false,
        message: summarizeText(message),
      });
      lastError = err;
      if (requestedBootstrapProfile) break;
    }
  }

  const attemptSummary = attempts.map((attempt) => `- ${attempt.profile}: ${attempt.message}`).join('\n');
  throw new Error([
    'No usable bootstrap OpenClaw profile passed the founder-floor preflight.',
    `Preflight home: ${preflightHome}`,
    `Manual home: ${manualHome}`,
    'Attempts:',
    attemptSummary,
    lastError instanceof Error ? `Last error: ${lastError.message}` : '',
    requestedBootstrapProfile
      ? 'Fix that profile or choose a different --manual-bootstrap-profile.'
      : 'Re-authenticate one of the default bootstrap profiles or pass --manual-bootstrap-profile <profile>.',
  ].filter(Boolean).join('\n'));
}

async function fetchJson(url, options, label = url) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${label} failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  return res.json();
}

async function fetchWatchState(baseUrl) {
  return fetchJson(`${baseUrl}/api/play/watch`, undefined, 'watch state');
}

async function fetchAgentState(baseUrl, agentId) {
  return fetchJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}`, undefined, `agent ${agentId}`);
}

async function fetchCompletionSummary(baseUrl, agentId) {
  try {
    const baseline = await buildMatchBaseline('mafia');
    return {
      sampleSize: Number(baseline.sampleSize || 0),
      latestCompletedAt: baseline.latestCompletedAt || null,
      latestCompletedRoomId: baseline.latestCompletedRoomId || null,
    };
  } catch (_err) {
    const publicHistory = await fetchJson(
      `${baseUrl}/api/matches?userId=${encodeURIComponent(agentId)}&limit=1`,
      undefined,
      `match history for ${agentId}`,
    );
    const latest = Array.isArray(publicHistory.matches) ? publicHistory.matches[0] : null;
    return {
      sampleSize: Array.isArray(publicHistory.matches) ? publicHistory.matches.length : 0,
      latestCompletedAt: latest?.finished_at || latest?.finishedAt || null,
      latestCompletedRoomId: latest?.room_id || latest?.roomId || null,
    };
  }
}

function snapshotRuntimeState() {
  return {
    agentIds: new Set([...agentProfiles.keys()]),
    runtimeIds: new Set([...liveAgentRuntimes.keys()]),
    connectIds: new Set([...connectSessions.keys()]),
  };
}

function findNewConnectedAgentIds(baseline) {
  const newIds = [];
  for (const [agentId, runtime] of liveAgentRuntimes.entries()) {
    if (baseline.runtimeIds.has(agentId)) continue;
    if (!runtime?.connected) continue;
    newIds.push(agentId);
  }
  return newIds;
}

function findManualAgent(baseline) {
  const candidates = [];
  for (const [agentId, agent] of agentProfiles.entries()) {
    if (baseline.agentIds.has(agentId)) continue;
    const runtime = liveAgentRuntimes.get(agentId);
    if (!runtime?.connected) continue;
    candidates.push({
      agentId,
      connectedAt: Number(runtime.connectedAt || agent?.openclaw?.connectedAt || 0),
      agent,
      runtime,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.connectedAt - b.connectedAt);
  return candidates[0];
}

async function waitForManualAgent({ baseline, timeoutMs, baseUrl }) {
  const startedAt = Date.now();
  return waitFor(async () => {
    const match = findManualAgent(baseline);
    if (!match) return null;
    const agentState = await fetchAgentState(baseUrl, match.agentId);
    return {
      agentId: match.agentId,
      name: match.agent?.name || 'manual-agent',
      owner: match.agent?.owner || 'anonymous',
      queueStatus: agentState.agent?.arena?.queueStatus || 'offline',
      watchUrl: agentState.agent?.watchUrl || null,
      connectedAfterMs: Date.now() - startedAt,
    };
  }, timeoutMs, 'Timed out waiting for the manual OpenClaw agent to connect');
}

function startAutoRuntime({ baseUrl, connect, config, env, profile, record }) {
  const child = spawn('openclaw', [
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
    config.name,
    '--preset',
    config.preset,
    '--style',
    config.style,
  ], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  attachChildOutput(child, config.name, {
    onExit: (code, signal) => {
      if (record.shutdownRequested) return;
      record.unexpectedExit = {
        code,
        signal,
        at: nowIso(),
      };
    },
  });

  return child;
}

async function createSiteSession(baseUrl) {
  const created = await fetchJson(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, 'site session');
  const token = String(created?.session?.token || '').trim();
  if (!created?.ok || !token) {
    throw new Error('Failed to create site session for automated runtimes');
  }
  return token;
}

async function createConnectSession(baseUrl, email, sessionToken) {
  const payload = email ? { email } : {};
  return fetchJson(`${baseUrl}/api/openclaw/connect-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(payload),
  }, `connect session for ${email || 'agent'}`);
}

async function waitForConnectedSession(baseUrl, connectId, accessToken) {
  return waitFor(async () => {
    const status = await fetchJson(
      `${baseUrl}/api/openclaw/connect-session/${connectId}?accessToken=${encodeURIComponent(accessToken)}`,
      undefined,
      `connect session ${connectId}`,
    );
    if (status?.connect?.status !== 'connected' || !status.connect?.agentId || !status.connect?.arena?.runtimeConnected) {
      return null;
    }
    return status.connect;
  }, 30_000, `Timed out waiting for connect session ${connectId} to become connected`);
}

function collectDisconnectSummary(records, manualAgentId) {
  const lines = [];
  const manualRuntime = liveAgentRuntimes.get(manualAgentId);
  lines.push(`- manual runtime connected at end: ${manualRuntime?.connected ? 'yes' : 'no'}`);

  for (const record of records) {
    const runtime = record.agentId ? liveAgentRuntimes.get(record.agentId) : null;
    const status = runtime?.connected ? 'connected' : 'disconnected';
    if (record.unexpectedExit) {
      lines.push(`- ${record.name}: unexpected exit code=${record.unexpectedExit.code} signal=${record.unexpectedExit.signal || 'none'}`);
    } else {
      lines.push(`- ${record.name}: ${status}`);
    }
  }

  return lines.join('\n');
}

function writeReport(reportFile, content) {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, content, 'utf8');
}

function buildReport({
  baseUrl,
  reportStartedAt,
  reportCompletedAt,
  preflightHome,
  manualHome,
  manualProfile,
  manualCommands,
  manualGatewayPort,
  manualBootstrapProfile,
  manualBootstrapAttempts,
  manualPreflightSummary,
  manualConfigPath,
  manualShellPath,
  manualWorkspace,
  manualAgent,
  autoAgents,
  watchState,
  completion,
  reportFile,
  disconnectSummary,
}) {
  return [
    '# Hybrid Founder Floor Test',
    '',
    `- Started: ${reportStartedAt}`,
    `- Completed: ${reportCompletedAt}`,
    `- Base URL: ${baseUrl}`,
    `- Manual preflight HOME: ${preflightHome}`,
    `- Manual OpenClaw HOME: ${manualHome}`,
    `- Manual OpenClaw profile: ${manualProfile}`,
    `- Manual bootstrap profile: ${manualBootstrapProfile}`,
    `- Manual config file: ${manualConfigPath}`,
    `- Manual shell bootstrap: ${manualShellPath}`,
    `- Manual workspace: ${manualWorkspace}`,
    `- Manual gateway port: ${manualGatewayPort}`,
    `- Manual gateway health command: \`${manualCommands.gatewayHealthCommand}\``,
    `- Manual TUI command: \`${manualCommands.tuiCommand}\``,
    `- Manual preflight summary: ${manualPreflightSummary}`,
    `- Manual agent id: ${manualAgent.agentId}`,
    `- Manual agent name: ${manualAgent.name}`,
    `- Manual queue status at detection: ${manualAgent.queueStatus}`,
    `- Manual watch URL: ${manualAgent.watchUrl ? `${baseUrl}${manualAgent.watchUrl}` : 'n/a'}`,
    '',
    '## Bootstrap attempts',
    '',
    ...manualBootstrapAttempts.map((attempt) => `- ${attempt.profile}: ${attempt.ok ? 'passed' : 'failed'}${attempt.message ? ` — ${attempt.message}` : ''}`),
    '',
    '## Automated agents',
    '',
    ...autoAgents.map((agent) => `- ${agent.name}: ${agent.agentId} (${agent.preset} / ${agent.style})`),
    '',
    '## Match result',
    '',
    `- First live room: ${watchState.roomId || 'n/a'}`,
    `- Public watch URL: ${watchState.watchUrl ? `${baseUrl}${watchState.watchUrl}` : 'n/a'}`,
    `- Leaderboard URL: ${baseUrl}/leaderboard.html`,
    `- Latest completed room id: ${completion.latestCompletedRoomId || 'n/a'}`,
    `- Latest completion timestamp: ${completion.latestCompletedAt || 'n/a'}`,
    '',
    '## Disconnect summary',
    '',
    disconnectSummary,
    '',
    `Report file: ${reportFile}`,
    '',
  ].join('\n');
}

async function main() {
  if (hasFlag('--help')) {
    console.log('Usage: node scripts/run-openclaw-hybrid.js [options]');
    console.log('Manual founder flow: preflight a fresh OpenClaw profile, then use one shell + TUI onboarding from /connect.html, then five automated runtimes.');
    console.log('Options:');
    console.log('  --port 4173');
    console.log('  --manual-home /tmp/.../manual');
    console.log('  --manual-profile founder-floor-manual');
    console.log('  --manual-gateway-port 19031');
    console.log('  --manual-bootstrap-profile founder-quick');
    console.log('  --auto-home /tmp/.../auto');
    console.log('  --auto-profile founder-floor-auto');
    console.log('  --plugin-spec @clawofdeceit/clawofdeceit-connect');
    console.log('  --manual-timeout-sec 600');
    console.log('  --connect-delay-ms 3000');
    console.log('  --report-file artifacts/hybrid-founder-floor-<timestamp>.md');
    console.log('Note: this runner is local-first. Remote --base-url orchestration is not supported in this first version.');
    process.exit(0);
  }

  const suppliedBaseUrl = readArg('--base-url').trim();
  if (suppliedBaseUrl) {
    throw new Error('Remote --base-url orchestration is not supported yet. Start the local hybrid flow instead.');
  }

  ensureOpenClawInstalled();

  const port = readNumberArg('--port', DEFAULT_PORT);
  const host = DEFAULT_HOST;
  const baseUrl = resolveBaseUrl(port, host);
  const rootDir = resolveRootDir(readArg('--root-dir').trim());
  const preflightHome = resolveHomeDir('', path.join(rootDir, 'manual-preflight'));
  const manualHome = resolveHomeDir(readArg('--manual-home').trim(), path.join(rootDir, 'manual'));
  const autoHome = resolveHomeDir(readArg('--auto-home').trim(), path.join(rootDir, 'auto'));
  const manualProfile = readArg('--manual-profile').trim() || MANUAL_PROFILE;
  const autoProfile = readArg('--auto-profile').trim() || AUTO_PROFILE;
  const manualGatewayPort = Math.max(1, readNumberArg('--manual-gateway-port', DEFAULT_MANUAL_GATEWAY_PORT));
  const manualBootstrapProfile = readArg('--manual-bootstrap-profile').trim();
  const manualTimeoutMs = Math.max(5_000, readNumberArg('--manual-timeout-sec', DEFAULT_MANUAL_TIMEOUT_MS / 1000) * 1000);
  const connectDelayMs = Math.max(0, readNumberArg('--connect-delay-ms', DEFAULT_CONNECT_DELAY_MS));
  const pluginSpec = readArg('--plugin-spec').trim() || CONNECTOR_PLUGIN_SPEC;
  const reportStamp = nowIso().replace(/[:.]/g, '-');
  const reportFile = path.resolve(readArg('--report-file').trim() || path.join(repoRoot, 'artifacts', `hybrid-founder-floor-${reportStamp}.md`));
  const manualGatewayToken = randomToken();
  const autoEnv = { ...process.env, HOME: autoHome };
  const baseline = snapshotRuntimeState();
  const autoRecords = [];
  const startedAt = nowIso();
  let serverStarted = false;
  let manualSeed = null;
  let manualPreflight = null;
  let manualShell = null;
  let manualCommands = null;
  let manualGateway = null;
  let manualBootstrapAttempts = [];
  let manualBootstrapProfileUsed = '';

  console.log(`Hybrid founder floor root: ${rootDir}`);
  console.log(`Manual preflight HOME: ${preflightHome}`);
  console.log(`Manual OpenClaw HOME: ${manualHome}`);
  console.log(`Automated OpenClaw HOME: ${autoHome}`);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const record of autoRecords) {
      record.shutdownRequested = true;
      stopChild(record.child);
    }
    stopChild(manualGateway);
    if (serverStarted && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(1));
  });

  try {
    const prepared = await prepareManualSeat({
      preflightHome,
      manualHome,
      manualProfile,
      manualGatewayPort,
      manualGatewayToken,
      requestedBootstrapProfile: manualBootstrapProfile,
    });
    manualSeed = prepared.manualSeed;
    manualPreflight = prepared.preflight;
    manualBootstrapAttempts = prepared.attempts;
    manualBootstrapProfileUsed = prepared.bootstrapProfile;
    manualShell = writeManualShellWrapper({
      manualHome,
      manualProfile,
      manualGatewayPort,
      manualGatewayToken,
    });
    manualCommands = buildManualCommands(manualHome, manualProfile, manualGatewayToken);
    manualGateway = startManualGateway({
      manualHome,
      manualProfile,
      manualGatewayPort,
      manualGatewayToken,
    });

    await waitForManualGateway({
      manualHome,
      manualProfile,
      manualGatewayToken,
      manualGatewayPort,
    });

    await new Promise((resolve, reject) => {
      function cleanup() {
        server.off('listening', onListening);
        server.off('error', onError);
      }

      function onListening() {
        cleanup();
        serverStarted = true;
        resolve();
      }

      function onError(err) {
        cleanup();
        reject(err);
      }

      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(port, host);
    });

    console.log(`Local arena running at ${baseUrl}`);
    console.log(`Manual OpenClaw preflight passed using bootstrap profile ${manualBootstrapProfileUsed}.`);
    console.log(`Preflight summary: ${summarizeText(manualPreflight.output.split('\n').find((line) => line.trim()) || 'preflight agent turn succeeded')}`);
    console.log(`Manual OpenClaw profile seeded from ${manualSeed.bootstrapProfile} for shell/TUI use.`);
    console.log(`Manual config file: ${manualSeed.configPath}`);
    console.log(`Manual agent dir: ${manualSeed.agentDir}`);
    console.log(`Manual workspace: ${manualSeed.workspace}`);
    console.log(`Manual gateway port: ${manualGatewayPort}`);
    console.log(`Manual shell bootstrap: source ${manualShell.shellPath}`);
    console.log(`Manual gateway health: ${manualCommands.gatewayHealthCommand}`);
    console.log(`Manual TUI command: ${manualCommands.tuiCommand}`);
    console.log(`Open this in your browser: ${baseUrl}/connect.html`);
    console.log('Use one shell only: source the bootstrap file, run Step 1 from /connect.html in that shell, then run openclaw tui in that same shell.');
    console.log('Paste the one-time connect message into the TUI, choose "play now", and leave that manual runtime open.');
    console.log('After your manual agent connects, the runner will spawn the five automated seats.');
    console.log(`Waiting up to ${formatDuration(manualTimeoutMs)} for the manual agent to connect...`);

    const manualAgent = await waitForManualAgent({
      baseline,
      timeoutMs: manualTimeoutMs,
      baseUrl,
    });

    console.log(`Manual agent connected: ${manualAgent.name} (${manualAgent.agentId}) after ${formatDuration(manualAgent.connectedAfterMs)}`);
    console.log(`Installing connector for automated runtimes in ${autoHome}`);

    installConnector({ env: autoEnv, profile: autoProfile, installSpec: pluginSpec });

    const autoSessionToken = await createSiteSession(baseUrl);
    const baselineBefore = await fetchCompletionSummary(baseUrl, manualAgent.agentId);
    const connectedAutoAgents = [];

    for (const config of AUTO_AGENTS) {
      const created = await createConnectSession(baseUrl, config.email, autoSessionToken);
      if (!created?.ok || !created.connect?.callbackProof || !created.connect?.accessToken) {
        throw new Error(`Failed to create connect session for ${config.name}`);
      }

      const record = {
        name: config.name,
        child: null,
        connectId: created.connect.id,
        agentId: null,
        preset: config.preset,
        style: config.style,
        shutdownRequested: false,
        unexpectedExit: null,
      };

      const child = startAutoRuntime({
        baseUrl,
        connect: created.connect,
        config,
        env: autoEnv,
        profile: autoProfile,
        record,
      });
      record.child = child;
      autoRecords.push(record);

      const connectedState = await waitForConnectedSession(baseUrl, created.connect.id, created.connect.accessToken);
      record.agentId = connectedState.agentId;
      connectedAutoAgents.push({
        name: config.name,
        agentId: connectedState.agentId,
        preset: config.preset,
        style: config.style,
      });
      console.log(`Automated agent connected: ${config.name} (${connectedState.agentId})`);
      if (connectDelayMs > 0) await sleep(connectDelayMs);
    }

    const watchState = await waitFor(async () => {
      const state = await fetchWatchState(baseUrl);
      return state?.ok && state.found ? state : null;
    }, 30_000, 'Timed out waiting for a live Mafia room to open');

    console.log(`Live room opened: ${watchState.roomId}`);

    const completion = await waitFor(async () => {
      const next = await fetchCompletionSummary(baseUrl, manualAgent.agentId);
      if (Number(next.sampleSize || 0) > Number(baselineBefore.sampleSize || 0)) return next;
      if (next.latestCompletedAt && next.latestCompletedAt !== baselineBefore.latestCompletedAt) return next;
      return null;
    }, 60_000, 'Timed out waiting for the first Mafia room to finish');

    console.log(`First Mafia match completed: ${completion.latestCompletedRoomId || watchState.roomId}`);

    const disconnectSummary = collectDisconnectSummary(autoRecords, manualAgent.agentId);
    const report = buildReport({
      baseUrl,
      reportStartedAt: startedAt,
      reportCompletedAt: nowIso(),
      preflightHome,
      manualHome,
      manualProfile,
      manualCommands,
      manualGatewayPort,
      manualBootstrapProfile: manualSeed.bootstrapProfile,
      manualBootstrapAttempts,
      manualPreflightSummary: summarizeText(manualPreflight.output.split('\n').find((line) => line.trim()) || 'preflight agent turn succeeded'),
      manualConfigPath: manualSeed.configPath,
      manualShellPath: manualShell.shellPath,
      manualWorkspace: manualSeed.workspace,
      manualAgent,
      autoAgents: connectedAutoAgents,
      watchState,
      completion,
      reportFile,
      disconnectSummary,
    });

    writeReport(reportFile, report);
    console.log(`Report written to ${reportFile}`);
  } finally {
    await shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
