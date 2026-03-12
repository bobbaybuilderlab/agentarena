const { buildOnboardingContract } = require('./onboarding-contract');

const CONNECT_SESSION_TTL_MS = 15 * 60_000;

function createConnectSession({
  connectSessions,
  email,
  publicBaseUrl,
  shortId,
}) {
  const id = shortId(18);
  const callbackUrl = `${String(publicBaseUrl || '').replace(/\/+$/, '')}/api/openclaw/callback`;
  const callbackProof = shortId(24);
  const accessToken = shortId(24);
  const connect = {
    id,
    email: String(email || '').trim().toLowerCase() || 'anonymous',
    status: 'pending_confirmation',
    callbackUrl,
    callbackProof,
    accessToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + CONNECT_SESSION_TTL_MS,
    agentId: null,
    agentName: null,
    connectedAt: null,
  };
  connectSessions.set(id, connect);
  return connect;
}

function getConnectArenaState(connect, summarizeAgentArenaState) {
  if (!connect?.agentId || typeof summarizeAgentArenaState !== 'function') return null;
  return summarizeAgentArenaState(connect.agentId);
}

function getConnectWatchUrl(arena) {
  if (!arena?.activeRoomId) return null;
  return `/play.html?mode=mafia&room=${encodeURIComponent(arena.activeRoomId)}&spectate=1`;
}

function sanitizeConnectSession(connect, {
  includeSecrets = false,
  publicBaseUrl,
  summarizeAgentArenaState,
} = {}) {
  if (!connect) return null;
  const arena = getConnectArenaState(connect, summarizeAgentArenaState);
  const onboarding = buildOnboardingContract({
    publicBaseUrl,
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
    watchUrl: getConnectWatchUrl(arena),
    onboarding,
  };
  if (includeSecrets) {
    base.accessToken = connect.accessToken;
    base.callbackProof = connect.callbackProof;
  }
  return base;
}

function readConnectAccessToken(req) {
  return String(
    req.query?.accessToken
      || req.headers['x-connect-access-token']
      || req.body?.accessToken
      || req.body?.proof
      || ''
  ).trim();
}

function authorizeConnectSession(req, connect) {
  if (!connect) return false;
  const token = readConnectAccessToken(req);
  if (!token) return false;
  return token === connect.accessToken || token === connect.callbackProof;
}

module.exports = {
  CONNECT_SESSION_TTL_MS,
  authorizeConnectSession,
  createConnectSession,
  readConnectAccessToken,
  sanitizeConnectSession,
};
