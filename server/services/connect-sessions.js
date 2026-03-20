const { buildOnboardingContract } = require('./onboarding-contract');
const { URLSearchParams } = require('url');
const {
  createConnectSessionRecord,
  countConnectSessionsCreatedByOwnerUserId,
  getConnectSessionRecord,
  updateConnectSessionRecord,
} = require('../db');
const { hashSecret, secretMatches, randomSecret } = require('./secret-tokens');

const CONNECT_SESSION_TTL_MS = 15 * 60_000;
const CONNECT_SESSION_DAILY_LIMIT = Math.max(0, Number(process.env.OPENCLAW_CONNECT_DAILY_LIMIT || 20));

function toMillis(value, fallback = 0) {
  if (!value) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function getConnectArenaState(connect, summarizeAgentArenaState) {
  if (!connect?.agentId || typeof summarizeAgentArenaState !== 'function') return null;
  return summarizeAgentArenaState(connect.agentId);
}

function getConnectArenaUrl(connect) {
  if (!connect?.agentId) return '/connect.html';
  const params = new URLSearchParams({ agentId: connect.agentId });
  return `/connect.html?${params.toString()}`;
}

function hydrateConnectSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: String(row.emailSnapshot || row.email_snapshot || 'anonymous').trim().toLowerCase() || 'anonymous',
    status: String(row.status || 'pending_confirmation').trim() || 'pending_confirmation',
    callbackUrl: row.callbackUrl || row.callback_url || '',
    createdAt: toMillis(row.created_at, Date.now()),
    expiresAt: toMillis(row.expires_at),
    ownerUserId: String(row.ownerUserId || row.owner_user_id || '').trim() || null,
    agentId: String(row.agentId || row.agent_id || '').trim() || null,
    agentName: String(row.agentName || row.agent_name || '').trim() || null,
    connectedAt: toMillis(row.connected_at),
    accessTokenHash: String(row.accessTokenHash || row.access_token_hash || '').trim() || '',
    callbackProofHash: String(row.callbackProofHash || row.callback_proof_hash || '').trim() || '',
  };
}

function startOfUtcDayIso(now = Date.now()) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function nextUtcMidnightMs(now = Date.now()) {
  const date = new Date(now);
  date.setUTCHours(24, 0, 0, 0);
  return date.getTime();
}

function buildConnectSessionLimitError(message, {
  code = 'OPENCLAW_CONNECT_LIMIT_REACHED',
  retryAfterMs = 60_000,
  extra = null,
} = {}) {
  const error = new Error(message);
  error.statusCode = 429;
  error.code = code;
  error.retryAfterMs = Math.max(1_000, Number(retryAfterMs) || 60_000);
  if (extra && typeof extra === 'object') error.extra = extra;
  return error;
}

function listReusablePendingConnectSessions(connectSessions, ownerUserId, {
  now = Date.now(),
} = {}) {
  const cleanOwnerUserId = String(ownerUserId || '').trim();
  if (!cleanOwnerUserId || !(connectSessions instanceof Map)) return [];
  return [...connectSessions.values()]
    .filter((connect) => {
      if (!connect) return false;
      if (String(connect.ownerUserId || '').trim() !== cleanOwnerUserId) return false;
      if (String(connect.status || '').trim() !== 'pending_confirmation') return false;
      if (!connect.accessToken || !connect.callbackProof) return false;
      return toMillis(connect.expiresAt) > now;
    })
    .sort((left, right) => toMillis(right?.createdAt) - toMillis(left?.createdAt));
}

async function createConnectSession({
  connectSessions,
  email,
  ownerUserId,
  publicBaseUrl,
  shortId,
  now = Date.now(),
  dailyCreateLimit = CONNECT_SESSION_DAILY_LIMIT,
}) {
  const reusablePendingSessions = listReusablePendingConnectSessions(connectSessions, ownerUserId, { now });
  if (reusablePendingSessions.length > 0) {
    return {
      connect: reusablePendingSessions[0],
      reusedExisting: true,
      activePendingCount: reusablePendingSessions.length,
    };
  }

  const cleanOwnerUserId = String(ownerUserId || '').trim() || null;
  if (cleanOwnerUserId && dailyCreateLimit > 0) {
    const createdToday = await countConnectSessionsCreatedByOwnerUserId(cleanOwnerUserId, {
      createdAfter: startOfUtcDayIso(now),
    });
    if (createdToday >= dailyCreateLimit) {
      const retryAfterMs = Math.max(1_000, nextUtcMidnightMs(now) - now);
      throw buildConnectSessionLimitError(
        'You have reached today\'s connect-message limit. Try again after midnight UTC.',
        {
          code: 'OPENCLAW_CONNECT_DAILY_LIMIT',
          retryAfterMs,
          extra: {
            dailyLimit: dailyCreateLimit,
            createdToday,
            resetsAt: new Date(now + retryAfterMs).toISOString(),
          },
        },
      );
    }
  }

  const id = shortId(18);
  const callbackUrl = `${String(publicBaseUrl || '').replace(/\/+$/, '')}/api/openclaw/callback`;
  const callbackProof = randomSecret(16);
  const accessToken = randomSecret(16);
  const connect = {
    id,
    email: String(email || '').trim().toLowerCase() || 'anonymous',
    status: 'pending_confirmation',
    callbackUrl,
    callbackProof,
    accessToken,
    accessTokenHash: hashSecret(accessToken),
    callbackProofHash: hashSecret(callbackProof),
    createdAt: now,
    expiresAt: now + CONNECT_SESSION_TTL_MS,
    ownerUserId: cleanOwnerUserId,
    agentId: null,
    agentName: null,
    connectedAt: null,
  };
  connectSessions.set(id, connect);
  await createConnectSessionRecord({
    id: connect.id,
    ownerUserId: connect.ownerUserId,
    emailSnapshot: connect.email,
    status: connect.status,
    callbackUrl: connect.callbackUrl,
    accessTokenHash: connect.accessTokenHash,
    callbackProofHash: connect.callbackProofHash,
    agentId: connect.agentId,
    agentName: connect.agentName,
    createdAt: toIso(connect.createdAt),
    expiresAt: toIso(connect.expiresAt),
    connectedAt: toIso(connect.connectedAt),
  });
  return {
    connect,
    reusedExisting: false,
    activePendingCount: 1,
  };
}

async function getConnectSession(connectSessions, id) {
  const cleanId = String(id || '').trim();
  if (!cleanId) return null;
  const cached = connectSessions.get(cleanId);
  if (cached) return cached;

  const persisted = await getConnectSessionRecord(cleanId);
  const hydrated = hydrateConnectSession(persisted);
  if (hydrated) connectSessions.set(cleanId, hydrated);
  return hydrated;
}

async function saveConnectSession(connectSessions, connect) {
  if (!connect?.id) return null;
  connectSessions.set(connect.id, connect);
  const persisted = await updateConnectSessionRecord(connect.id, {
    ownerUserId: connect.ownerUserId,
    emailSnapshot: connect.email,
    status: connect.status,
    callbackUrl: connect.callbackUrl,
    accessTokenHash: connect.accessTokenHash || hashSecret(connect.accessToken),
    callbackProofHash: connect.callbackProofHash || hashSecret(connect.callbackProof),
    agentId: connect.agentId,
    agentName: connect.agentName,
    createdAt: toIso(connect.createdAt),
    expiresAt: toIso(connect.expiresAt),
    connectedAt: toIso(connect.connectedAt),
  });
  return hydrateConnectSession({
    ...persisted,
    accessTokenHash: connect.accessTokenHash || persisted?.access_token_hash || persisted?.accessTokenHash || '',
    callbackProofHash: connect.callbackProofHash || persisted?.callback_proof_hash || persisted?.callbackProofHash || '',
  });
}

function sanitizeConnectSession(connect, {
  includeSecrets = false,
  publicBaseUrl,
  summarizeAgentArenaState,
  sanitizeArenaState,
} = {}) {
  if (!connect) return null;
  const internalArena = getConnectArenaState(connect, summarizeAgentArenaState);
  const arena = typeof sanitizeArenaState === 'function'
    ? sanitizeArenaState(internalArena)
    : internalArena;
  const onboarding = buildOnboardingContract({
    publicBaseUrl,
    sessionId: connect.id,
    accessToken: includeSecrets ? connect.accessToken : '',
    token: connect.id,
    callbackUrl: connect.callbackUrl,
    callbackProof: includeSecrets ? connect.callbackProof : '',
  });
  const base = {
    id: connect.id,
    email: connect.email,
    status: connect.status,
    command: onboarding.connectCommand,
    callbackUrl: connect.callbackUrl,
    createdAt: connect.createdAt,
    expiresAt: connect.expiresAt,
    agentId: connect.agentId,
    agentName: connect.agentName,
    connectedAt: connect.connectedAt,
    arena,
    arenaUrl: getConnectArenaUrl(connect),
    watchUrl: null,
    onboarding,
  };
  if (includeSecrets) {
    base.accessToken = connect.accessToken || '';
    base.callbackProof = connect.callbackProof || '';
  }
  return base;
}

function readConnectAccessToken(req, {
  allowQuery = false,
  allowBody = false,
} = {}) {
  return String(
    req.headers['x-connect-access-token']
      || (allowQuery ? req.query?.accessToken : '')
      || (allowBody ? req.body?.accessToken : '')
      || ''
  ).trim();
}

function readConnectCallbackProof(req, { allowQuery = false } = {}) {
  return String(
    req.headers['x-openclaw-callback-proof']
      || req.headers['x-connect-callback-proof']
      || req.body?.proof
      || req.body?.callbackProof
      || (allowQuery ? (req.query?.proof || req.query?.callbackProof) : '')
      || ''
  ).trim();
}

function doesConnectSecretMatch(connect, token, {
  allowAccessToken = true,
  allowCallbackProof = true,
} = {}) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken || !connect) return false;
  if (allowAccessToken && normalizedToken === String(connect.accessToken || '').trim()) return true;
  if (allowCallbackProof && normalizedToken === String(connect.callbackProof || '').trim()) return true;
  return (allowAccessToken && secretMatches(normalizedToken, connect.accessTokenHash))
    || (allowCallbackProof && secretMatches(normalizedToken, connect.callbackProofHash));
}

function authorizeConnectSessionRead(req, connect, { allowQuery = false } = {}) {
  if (!connect) return false;
  const accessToken = readConnectAccessToken(req, { allowQuery });
  const callbackProof = readConnectCallbackProof(req);
  if (!accessToken && !callbackProof) return false;
  return doesConnectSecretMatch(connect, accessToken, { allowCallbackProof: false })
    || doesConnectSecretMatch(connect, callbackProof, { allowAccessToken: false });
}

function authorizeConnectSessionWrite(req, connect) {
  if (!connect) return false;
  const callbackProof = readConnectCallbackProof(req);
  if (!callbackProof) return false;
  return doesConnectSecretMatch(connect, callbackProof, { allowAccessToken: false });
}

function isConnectSessionExpired(connect) {
  return toMillis(connect?.expiresAt) <= Date.now();
}

module.exports = {
  CONNECT_SESSION_TTL_MS,
  authorizeConnectSessionRead,
  authorizeConnectSessionWrite,
  buildConnectSessionLimitError,
  createConnectSession,
  getConnectSession,
  getConnectArenaUrl,
  hydrateConnectSession,
  isConnectSessionExpired,
  listReusablePendingConnectSessions,
  readConnectAccessToken,
  readConnectCallbackProof,
  saveConnectSession,
  sanitizeConnectSession,
};
