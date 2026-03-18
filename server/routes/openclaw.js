const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const {
  authorizeConnectSession,
  createConnectSession,
  getConnectSession,
  isConnectSessionExpired,
  readConnectAccessToken,
  sanitizeConnectSession,
  saveConnectSession,
} = require('../services/connect-sessions');
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
  });
}

function appendConnectCompleted(roomEvents, connect, agent) {
  roomEvents.append('growth', connect.id, 'CONNECT_SESSION_CONNECTED', {
    status: connect.status,
    agentId: agent.id,
    agentName: agent.name,
  });
}

function createOpenClawRouter({
  agentProfiles,
  connectSessions,
  incrementGrowthMetric,
  issueRuntimeCredential,
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

  async function confirmSession(req, res, note) {
    const connect = await getConnectSession(connectSessions, req.params.id || String(req.body?.token || '').trim());
    if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
    if (isConnectSessionExpired(connect)) return res.status(410).json({ ok: false, error: 'connect session expired' });
    if (req.params.id && !authorizeConnectSession(req, connect)) {
      return res.status(401).json({ ok: false, error: 'connect session auth required' });
    }
    if (!req.params.id && !authorizeConnectSession(req, connect)) {
      return res.status(401).json({ ok: false, error: 'invalid callback proof' });
    }

    if (connect.status === 'connected') {
      return sendConnectSession(res, connect, req, false);
    }

    try {
      const agent = await createConnectedOpenClawAgent({
        agentProfiles,
        connect,
        name: normalizeAgentName(req.body?.agentName, shortId),
        style: normalizeAgentStyle(req.body?.style),
        presetId: normalizeAgentPresetId(req.body?.presetId),
        note,
      });
      if (typeof bindOwnedAgent === 'function' && connect.ownerUserId) {
        await bindOwnedAgent(connect.ownerUserId, agent.id);
      }
      const runtimeCredential = typeof issueRuntimeCredential === 'function'
        ? await issueRuntimeCredential(agent.id)
        : null;
      await saveConnectSession(connectSessions, connect);
      appendConnectCompleted(roomEvents, connect, agent);
      persistState();

      res.json({
        ok: true,
        connect: sanitizeConnectSession(connect, {
          publicBaseUrl: resolvePublicBaseUrl(req),
          summarizeAgentArenaState,
        }),
        agent,
        runtimeCredential,
      });
    } catch (error) {
      if (error?.code === 'AGENT_NAME_TAKEN') {
        return res.status(409).json({
          ok: false,
          error: 'agent name already taken',
          code: 'AGENT_NAME_TAKEN',
        });
      }
      throw error;
    }
  }

  router.post('/connect-session', createLimiter, async (req, res) => {
    incrementGrowthMetric('funnel.connectSessionStarts', 1);
    const siteSession = typeof resolveSiteSession === 'function' ? await resolveSiteSession(req) : null;
    const connect = await createConnectSession({
      connectSessions,
      email: req.body?.email,
      ownerUserId: siteSession?.userId || null,
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

  router.get('/connect-session/:id', statusLimiter, async (req, res) => {
    const connect = await getConnectSession(connectSessions, req.params.id);
    if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
    if (isConnectSessionExpired(connect)) return res.status(410).json({ ok: false, error: 'connect session expired' });
    if (!authorizeConnectSession(req, connect)) return res.status(401).json({ ok: false, error: 'connect session auth required' });
    sendConnectSession(res, connect, req, false);
  });

  router.get('/connect-session/:id/skill.md', statusLimiter, async (req, res) => {
    const connect = await getConnectSession(connectSessions, req.params.id);
    if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
    if (isConnectSessionExpired(connect)) return res.status(410).json({ ok: false, error: 'connect session expired' });
    if (!authorizeConnectSession(req, connect)) return res.status(401).json({ ok: false, error: 'connect session auth required' });

    const publicBaseUrl = resolvePublicBaseUrl(req);
    const accessToken = readConnectAccessToken(req);
    const callbackProof = String(connect.callbackProof || accessToken || '').trim();
    const markdown = buildSessionSkillMarkdown({
      publicBaseUrl,
      token: connect.id,
      callbackUrl: connect.callbackUrl,
      callbackProof,
      connectCommand: sanitizeConnectSession(connect, {
        includeSecrets: Boolean(connect.callbackProof),
        publicBaseUrl,
        summarizeAgentArenaState,
      })?.onboarding?.connectCommand || (
        callbackProof
          ? buildOnboardingContract({
            publicBaseUrl,
            sessionId: connect.id,
            accessToken,
            token: connect.id,
            callbackUrl: connect.callbackUrl,
            callbackProof,
          })?.connectCommand || ''
          : ''
      ),
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
