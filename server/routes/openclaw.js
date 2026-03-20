const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const {
  authorizeConnectSessionRead,
  authorizeConnectSessionWrite,
  createConnectSession,
  getConnectSession,
  isConnectSessionExpired,
  readConnectAccessToken,
  readConnectCallbackProof,
  sanitizeConnectSession,
  saveConnectSession,
} = require('../services/connect-sessions');
const { createConnectedOpenClawAgent } = require('../services/agent-registry');
const { buildOnboardingContract, buildSessionSkillMarkdown } = require('../services/onboarding-contract');
const { cleanStylePhrase, normalizePresetToken } = require('../../extensions/clawofdeceit-connect/style-presets.cjs');

function readBooleanEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

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
  const accessToken = readConnectAccessToken(req, { allowQuery: true });
  const callbackProof = readConnectCallbackProof(req);
  const authToken = callbackProof || accessToken;
  if (sessionId && authToken) return `session:${sessionId}:${authToken}`;
  if (sessionId) return `session:${sessionId}`;
  if (authToken) return `token:${authToken}`;
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

function sendThrottleResponse(res, {
  error,
  code,
  retryAfterMs,
  extra = null,
}) {
  const retryAfterSec = Math.max(1, Math.ceil(Math.max(0, Number(retryAfterMs) || 0) / 1000) || 1);
  res.set('Retry-After', String(retryAfterSec));
  return res.status(429).json({
    ok: false,
    error,
    code,
    retryAfterSec,
    retryAfterMs: retryAfterSec * 1000,
    ...(extra && typeof extra === 'object' ? extra : {}),
  });
}

function appendConnectStarted(roomEvents, connect) {
  roomEvents.append('growth', connect.id, 'CONNECT_SESSION_STARTED', {
    status: connect.status,
    emailDomain: connect.email.split('@')[1] || null,
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

function createOpenClawRouter({
  bindOwnedAgent,
  agentProfiles,
  connectSessions,
  getOwnerDailyMatchQuota,
  incrementGrowthMetric,
  issueRuntimeCredential,
  persistState,
  resolvePublicBaseUrl,
  resolveSiteSession,
  roomEvents,
  sanitizeArenaState,
  shortId,
  summarizeAgentArenaState,
}) {
  const router = express.Router();
  const createLimiter = createOpenClawLimiter(
    Number(process.env.OPENCLAW_CREATE_RATE_LIMIT_MAX || 5),
    'Too many onboarding attempts. Please try again shortly.',
  );
  const callbackLimiter = createOpenClawLimiter(
    Number(process.env.OPENCLAW_CALLBACK_RATE_LIMIT_MAX || 30),
    'Too many connector callbacks. Please retry in a moment.',
  );
  const statusLimiter = createOpenClawLimiter(
    Number(process.env.OPENCLAW_STATUS_RATE_LIMIT_MAX || 60),
    'Too many onboarding status checks. Please wait a moment and retry.',
  );
  const openClawConnectEnabled = readBooleanEnv('OPENCLAW_CONNECT_ENABLED', true);

  async function buildConnectSessionPayload(connect, req, includeSecrets = false) {
    const payload = sanitizeConnectSession(connect, {
      includeSecrets,
      publicBaseUrl: resolvePublicBaseUrl(req),
      sanitizeArenaState,
      summarizeAgentArenaState,
    });
    const ownerUserId = String(connect?.ownerUserId || '').trim() || null;
    if (!ownerUserId) {
      if (payload.arena?.runtimeConnected) {
        const queueStatus = String(payload.arena.queueStatus || 'offline').trim().toLowerCase();
        if (queueStatus !== 'in_match' && queueStatus !== 'reserved') {
          payload.arena.queueStatus = 'ownership_required';
        }
      }
      return payload;
    }
    if (typeof getOwnerDailyMatchQuota !== 'function') return payload;
    const quota = await getOwnerDailyMatchQuota(ownerUserId);
    payload.quota = quota;
    if (payload.arena?.runtimeConnected && quota?.blocked) {
      const queueStatus = String(payload.arena.queueStatus || 'offline').trim().toLowerCase();
      if (queueStatus !== 'in_match' && queueStatus !== 'reserved') {
        payload.arena.queueStatus = 'daily_limit_reached';
      }
    }
    return payload;
  }

  async function sendConnectSession(res, connect, req, includeSecrets = false) {
    res.json({
      ok: true,
      connect: await buildConnectSessionPayload(connect, req, includeSecrets),
    });
  }

  async function confirmSession(req, res, note) {
    const connect = await getConnectSession(connectSessions, req.params.id || String(req.body?.token || '').trim());
    if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
    if (isConnectSessionExpired(connect)) return res.status(410).json({ ok: false, error: 'connect session expired' });
    if (req.params.id && !authorizeConnectSessionWrite(req, connect)) {
      return res.status(401).json({ ok: false, error: 'connect session auth required' });
    }
    if (!req.params.id && !authorizeConnectSessionWrite(req, connect)) {
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
        connect: await buildConnectSessionPayload(connect, req, false),
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
      if (error?.code === 'AGENT_OWNER_REQUIRED') {
        return res.status(409).json({
          ok: false,
          error: 'connect session missing owner binding',
          code: 'CONNECT_SESSION_OWNER_REQUIRED',
        });
      }
      throw error;
    }
  }

  router.post('/connect-session', createLimiter, async (req, res) => {
    if (!openClawConnectEnabled) {
      return res.status(503).json({
        ok: false,
        error: 'New connect messages are temporarily disabled.',
        code: 'OPENCLAW_CONNECT_DISABLED',
      });
    }
    const siteSession = typeof resolveSiteSession === 'function' ? await resolveSiteSession(req) : null;
    const ownerUserId = siteSession?.userId || null;

    if (!ownerUserId) {
      return res.status(401).json({
        ok: false,
        error: 'Create a site session before generating a connect message.',
      });
    }

    try {
      const created = await createConnectSession({
        connectSessions,
        email: req.body?.email,
        ownerUserId,
        publicBaseUrl: resolvePublicBaseUrl(req),
        shortId,
      });
      const connect = created.connect;
      if (!created.reusedExisting) {
        incrementGrowthMetric('funnel.connectSessionStarts', 1);
        appendConnectStarted(roomEvents, connect);
      } else {
        res.set('X-Connect-Session-Reused', '1');
      }
      await sendConnectSession(res, connect, req, true);
    } catch (error) {
      if (error?.statusCode === 429) {
        return sendThrottleResponse(res, {
          error: error.message || 'Too many connect messages. Please try again later.',
          code: error.code || 'OPENCLAW_CONNECT_LIMIT_REACHED',
          retryAfterMs: error.retryAfterMs,
          extra: error.extra,
        });
      }
      throw error;
    }
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
    if (!authorizeConnectSessionRead(req, connect)) return res.status(401).json({ ok: false, error: 'connect session auth required' });
    await sendConnectSession(res, connect, req, false);
  });

  router.get('/connect-session/:id/skill.md', statusLimiter, async (req, res) => {
    const connect = await getConnectSession(connectSessions, req.params.id);
    if (!connect) return res.status(404).json({ ok: false, error: 'connect session not found' });
    if (isConnectSessionExpired(connect)) return res.status(410).json({ ok: false, error: 'connect session expired' });
    if (!authorizeConnectSessionRead(req, connect, { allowQuery: true })) {
      return res.status(401).json({ ok: false, error: 'connect session auth required' });
    }

    const publicBaseUrl = resolvePublicBaseUrl(req);
    const accessToken = readConnectAccessToken(req, { allowQuery: true });
    const callbackProof = String(connect.callbackProof || '').trim();
    const markdown = buildSessionSkillMarkdown({
      publicBaseUrl,
      token: connect.id,
      callbackUrl: connect.callbackUrl,
      callbackProof,
      connectCommand: sanitizeConnectSession(connect, {
        includeSecrets: Boolean(callbackProof),
        publicBaseUrl,
        sanitizeArenaState,
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
