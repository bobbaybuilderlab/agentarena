const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { authorizeConnectSession, createConnectSession, readConnectAccessToken, sanitizeConnectSession } = require('../services/connect-sessions');
const { createConnectedOpenClawAgent } = require('../services/agent-registry');
const { buildOnboardingContract, buildSessionSkillMarkdown } = require('../services/onboarding-contract');
const { cleanStylePhrase, normalizePresetToken } = require('../../extensions/clawofdeceit-connect/style-presets.cjs');

function createLimiterHandler(errorMessage) {
  return (req, res, _next, options) => {
    const retryAfterHeader = res.getHeader('Retry-After');
    const retryAfterSec = Math.max(1, Number(retryAfterHeader) || Math.ceil((options.windowMs || 60_000) / 1000));
    res.status(options.statusCode).json({
      ok: false,
      error: errorMessage,
      code: 'OPENCLAW_RATE_LIMITED',
      retryAfterSec,
      retryAfterMs: retryAfterSec * 1000,
    });
  };
}

function getRateLimitKey(req) {
  const sessionId = String(req.params?.id || req.body?.token || '').trim();
  const accessToken = readConnectAccessToken(req);
  if (sessionId && accessToken) return `session:${sessionId}:${accessToken}`;
  if (sessionId) return `session:${sessionId}`;
  if (accessToken) return `token:${accessToken}`;
  return `ip:${ipKeyGenerator(req.ip || req.headers['x-forwarded-for'] || 'unknown')}`;
}

function createOpenClawLimiter(max, errorMessage) {
  const windowMs = Number(process.env.OPENCLAW_RATE_LIMIT_WINDOW_MS || process.env.RATE_LIMIT_WINDOW_MS || 60_000);
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getRateLimitKey,
    handler: createLimiterHandler(errorMessage),
  });
}

function normalizeAgentName(value, shortId) {
  return String(value || `agent-${shortId(4)}`).trim().slice(0, 24);
}

function normalizeAgentStyle(value) {
  return cleanStylePhrase(value);
}

function normalizeAgentPresetId(value) {
  return normalizePresetToken(value).slice(0, 32);
}

function appendConnectStarted(roomEvents, connect) {
  roomEvents.append('growth', connect.id, 'CONNECT_SESSION_STARTED', {
    status: connect.status,
    emailDomain: String(connect.email || '').split('@')[1] || null,
  });
}

function appendConnectCompleted(roomEvents, connect, agent) {
  roomEvents.append('growth', connect.id, 'CONNECT_SESSION_CONNECTED', {
    status: connect.status,
    agentId: agent.id,
    agentName: agent.name,
    emailDomain: String(connect.email || '').split('@')[1] || null,
  });
}

function invalidOwnerTokenError() {
  const error = new Error('invalid owner token');
  error.statusCode = 401;
  return error;
}

function createOpenClawRouter({
  bindOwnedAgent,
  agentProfiles,
  connectSessions,
  getUserById,
  incrementGrowthMetric,
  persistState,
  resolvePublicBaseUrl,
  resolveOwnerTokenUser,
  resolveSiteSession,
  roomEvents,
  shortId,
  summarizeAgentArenaState,
}) {
  const router = express.Router();
  const createLimiter = createOpenClawLimiter(
    Number(process.env.OPENCLAW_CREATE_RATE_LIMIT_MAX || 20),
    'Too many onboarding attempts. Please try again shortly.',
  );
  const callbackLimiter = createOpenClawLimiter(
    Number(process.env.OPENCLAW_CALLBACK_RATE_LIMIT_MAX || 120),
    'Too many connector callbacks. Please retry in a moment.',
  );
  const statusLimiter = createOpenClawLimiter(
    Number(process.env.OPENCLAW_STATUS_RATE_LIMIT_MAX || 240),
    'Too many onboarding status checks. Please wait a moment and retry.',
  );

  function sendConnectSession(res, connect, req, includeSecrets = false) {
    res.json({
      ok: true,
      connect: sanitizeConnectSession(connect, {
        includeSecrets,
        publicBaseUrl: resolvePublicBaseUrl(req),
        summarizeAgentArenaState,
      }),
    });
  }

  async function resolveVerifiedOwner(req, connect) {
    const rawOwnerToken = String(req.body?.ownerToken || '').trim();
    if (rawOwnerToken) {
      if (typeof resolveOwnerTokenUser !== 'function') throw invalidOwnerTokenError();
      const ownerUser = await resolveOwnerTokenUser(rawOwnerToken);
      if (!ownerUser?.id) throw invalidOwnerTokenError();
      connect.ownerUserId = ownerUser.id;
      if (!connect.email && ownerUser.email) connect.email = ownerUser.email;
      return ownerUser;
    }

    if (!connect?.ownerUserId || typeof getUserById !== 'function') return null;
    const ownerUser = await getUserById(connect.ownerUserId);
    if (ownerUser?.email && !connect.email) connect.email = ownerUser.email;
    return ownerUser?.id ? ownerUser : null;
  }

  async function confirmSession(req, res, note) {
    const connect = connectSessions.get(req.params.id || String(req.body?.token || '').trim());
    if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
    if (Date.now() > (connect.expiresAt || 0)) return res.status(410).json({ ok: false, error: 'connect session expired' });
    if (req.params.id && !authorizeConnectSession(req, connect)) {
      return res.status(401).json({ ok: false, error: 'connect session auth required' });
    }
    const providedProof = String(req.body?.proof || '').trim();
    if (!req.params.id && (!providedProof || providedProof !== connect.callbackProof)) {
      return res.status(401).json({ ok: false, error: 'invalid callback proof' });
    }

    if (connect.status === 'connected') {
      return sendConnectSession(res, connect, req, false);
    }

    let verifiedOwner = null;
    try {
      verifiedOwner = await resolveVerifiedOwner(req, connect);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, error: error.message || 'owner auth failed' });
    }
    const reusableClaimedAgentId = verifiedOwner?.email
      ? String(verifiedOwner.agent_id || '').trim() || null
      : null;

    const agent = createConnectedOpenClawAgent({
      agentProfiles,
      connect,
      shortId,
      name: normalizeAgentName(req.body?.agentName, shortId),
      style: normalizeAgentStyle(req.body?.style),
      presetId: normalizeAgentPresetId(req.body?.presetId),
      note,
      preferredAgentId: reusableClaimedAgentId,
      owner: verifiedOwner?.email || null,
      ownerEmail: verifiedOwner?.email || null,
      ownerUserId: verifiedOwner?.id || connect.ownerUserId || null,
    });
    if (typeof bindOwnedAgent === 'function') await bindOwnedAgent(connect.ownerUserId, agent.id);
    appendConnectCompleted(roomEvents, connect, agent);
    persistState();

    res.json({
      ok: true,
      connect: sanitizeConnectSession(connect, {
        publicBaseUrl: resolvePublicBaseUrl(req),
        summarizeAgentArenaState,
      }),
      agent,
    });
  }

  router.post('/connect-session', createLimiter, async (req, res) => {
    incrementGrowthMetric('funnel.connectSessionStarts', 1);
    const siteSession = typeof resolveSiteSession === 'function' ? await resolveSiteSession(req) : null;
    let ownerUserId = siteSession?.userId || null;
    let email = req.body?.email;
    const rawOwnerToken = String(req.body?.ownerToken || '').trim();

    if (rawOwnerToken) {
      if (typeof resolveOwnerTokenUser !== 'function') {
        return res.status(401).json({ ok: false, error: 'invalid owner token' });
      }
      const ownerUser = await resolveOwnerTokenUser(rawOwnerToken);
      if (!ownerUser?.id) return res.status(401).json({ ok: false, error: 'invalid owner token' });
      ownerUserId = ownerUser.id;
      if (!email && ownerUser.email) email = ownerUser.email;
    }

    if (!ownerUserId) {
      return res.status(401).json({
        ok: false,
        error: 'Create a site session before generating a connect message.',
      });
    }

    const connect = createConnectSession({
      connectSessions,
      email,
      ownerUserId,
      publicBaseUrl: resolvePublicBaseUrl(req),
      shortId,
    });
    appendConnectStarted(roomEvents, connect);
    sendConnectSession(res, connect, req, true);
  });

  router.get('/onboarding', (req, res) => {
    res.json({
      ok: true,
      onboarding: buildOnboardingContract({
        publicBaseUrl: resolvePublicBaseUrl(req),
        token: '',
        callbackUrl: `${String(resolvePublicBaseUrl(req) || '').replace(/\/+$/, '')}/api/openclaw/callback`,
        callbackProof: '',
      }),
    });
  });

  router.post('/callback', callbackLimiter, async (req, res) => {
    await confirmSession(req, res, 'connected through OpenClaw CLI callback');
  });

  router.get('/connect-session/:id', statusLimiter, (req, res) => {
    const connect = connectSessions.get(req.params.id);
    if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
    if (Date.now() > (connect.expiresAt || 0)) return res.status(410).json({ ok: false, error: 'connect session expired' });
    if (!authorizeConnectSession(req, connect)) return res.status(401).json({ ok: false, error: 'connect session auth required' });
    sendConnectSession(res, connect, req, false);
  });

  router.get('/connect-session/:id/skill.md', statusLimiter, (req, res) => {
    const connect = connectSessions.get(req.params.id);
    if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
    if (Date.now() > (connect.expiresAt || 0)) return res.status(410).json({ ok: false, error: 'connect session expired' });
    if (!authorizeConnectSession(req, connect)) return res.status(401).json({ ok: false, error: 'connect session auth required' });

    const publicBaseUrl = resolvePublicBaseUrl(req);
    const markdown = buildSessionSkillMarkdown({
      publicBaseUrl,
      token: connect.id,
      callbackUrl: connect.callbackUrl,
      callbackProof: connect.callbackProof,
      connectCommand: sanitizeConnectSession(connect, {
        includeSecrets: true,
        publicBaseUrl,
        summarizeAgentArenaState,
      })?.onboarding?.connectCommand || '',
    });

    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.send(markdown);
  });

  router.post('/connect-session/:id/confirm', callbackLimiter, async (req, res) => {
    await confirmSession(req, res, 'connected through OpenClaw CLI confirmation flow');
  });

  return router;
}

module.exports = {
  createOpenClawRouter,
};
