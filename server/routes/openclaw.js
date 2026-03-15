const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { createPendingAgent, activateAgent } = require('../services/agent-registry');
const { buildOnboardingContract } = require('../services/onboarding-contract');
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
  const token = readBearerToken(req);
  if (token) return `token:${token}`;
  return `ip:${ipKeyGenerator(req.ip || req.headers['x-forwarded-for'] || 'unknown')}`;
}

function readBearerToken(req) {
  const header = String(req.headers?.authorization || '').trim();
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return String(req.body?.token || req.query?.token || '').trim() || null;
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

function appendAgentCreated(roomEvents, userId, agent) {
  roomEvents.append('growth', userId, 'AGENT_CREATED', {
    agentId: agent.id,
    agentName: agent.name,
  });
}

function createOpenClawRouter({
  addUserAgent,
  agentProfiles,
  incrementGrowthMetric,
  persistState,
  resolvePublicBaseUrl,
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
    'Too many onboarding callbacks. Please retry in a moment.',
  );

  router.post('/create-agent', createLimiter, async (req, res) => {
    incrementGrowthMetric('funnel.createAgentStarts', 1);
    const siteSession = typeof resolveSiteSession === 'function' ? await resolveSiteSession(req) : null;
    if (!siteSession?.userId) {
      return res.status(401).json({ ok: false, error: 'Sign up required to create an agent.' });
    }
    if (siteSession.email === null || siteSession.email === undefined) {
      return res.status(403).json({ ok: false, error: 'Please register with an email before creating an agent.' });
    }

    const agent = createPendingAgent({
      agentProfiles,
      ownerId: siteSession.userId,
      ownerEmail: siteSession.email || 'anonymous',
      shortId,
    });

    if (typeof addUserAgent === 'function') await addUserAgent(siteSession.userId, agent.id);
    persistState();

    const onboarding = buildOnboardingContract({
      publicBaseUrl: resolvePublicBaseUrl(req),
      sessionToken: siteSession.token,
      agentId: agent.id,
    });

    res.json({
      ok: true,
      agentId: agent.id,
      joinMessage: onboarding.joinMessage,
      onboarding,
    });
  });

  router.get('/onboarding', (req, res) => {
    res.json({
      ok: true,
      onboarding: buildOnboardingContract({
        publicBaseUrl: resolvePublicBaseUrl(req),
        sessionToken: '',
        agentId: '',
      }),
    });
  });

  router.post('/callback', callbackLimiter, async (req, res) => {
    const siteSession = typeof resolveSiteSession === 'function' ? await resolveSiteSession(req) : null;
    if (!siteSession?.userId) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired session token.' });
    }

    const agentId = String(req.body?.agentId || '').trim();
    if (!agentId) {
      return res.status(400).json({ ok: false, error: 'agentId is required.' });
    }

    const agent = agentProfiles.get(agentId);
    if (!agent) {
      return res.status(404).json({ ok: false, error: 'Agent not found.' });
    }
    if (agent.ownerId !== siteSession.userId) {
      return res.status(403).json({ ok: false, error: 'Agent does not belong to this account.' });
    }
    if (agent.deployed) {
      return res.json({
        ok: true,
        agent,
        arena: summarizeAgentArenaState(agent.id),
      });
    }

    const activated = activateAgent({
      agentProfiles,
      agentId,
      name: normalizeAgentName(req.body?.agentName, shortId),
      style: normalizeAgentStyle(req.body?.style),
      presetId: normalizeAgentPresetId(req.body?.presetId),
      note: 'connected through direct runtime onboarding callback',
    });

    appendAgentCreated(roomEvents, siteSession.userId, activated);
    persistState();

    res.json({
      ok: true,
      agent: activated,
      arena: summarizeAgentArenaState(activated.id),
    });
  });

  return router;
}

module.exports = {
  createOpenClawRouter,
};
