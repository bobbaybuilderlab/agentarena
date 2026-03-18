function sendRetiredAccountResponse(res) {
  res.status(410).json({
    ok: false,
    error: 'Website accounts, ownership claims, and personal dashboards are not part of the current MVP.',
  });
}

function createAccountModule({
  createAnonymousUser,
  createSession,
  expiresAtFromNow,
  getCachedSession,
  getSessionByToken,
  getUserByToken,
  isProduction,
  logStructured,
  readBearerToken,
  setCachedSession,
  shortId,
}) {
  async function resolveSiteSession(req) {
    const token = readBearerToken(req);
    if (!token) return null;

    try {
      const [session, user] = await Promise.all([
        getSessionByToken(token),
        getUserByToken(token),
      ]);
      if (session || user) {
        return {
          token,
          userId: user?.id || session?.user_id || null,
          email: user?.email || null,
          displayName: user?.display_name || null,
          agentId: user?.agent_id || null,
          primaryAgentId: user?.agent_id || null,
          isAnonymous: !!user?.is_anonymous,
          expiresAt: session?.expires_at || null,
          durable: true,
        };
      }
    } catch (err) {
      logStructured('error.resolveSiteSession', { error: err.message });
      if (isProduction) return null;
    }

    const fallback = getCachedSession(token);
    if (!fallback) return null;
    return {
      token,
      userId: fallback.userId || null,
      email: fallback.email || null,
      displayName: fallback.displayName || null,
      agentId: fallback.agentId || null,
      primaryAgentId: fallback.agentId || null,
      isAnonymous: !fallback.email,
      expiresAt: fallback.expiresAt || null,
      durable: false,
    };
  }

  async function handleSession(req, res) {
    const existingToken = String(
      req.headers.authorization?.replace('Bearer ', '')
        || req.body?.token
        || ''
    ).trim();

    if (existingToken) {
      const [siteSession, existing] = await Promise.all([
        resolveSiteSession({ headers: { authorization: `Bearer ${existingToken}` } }),
        getSessionByToken(existingToken),
      ]);
      if (siteSession?.userId) {
        return res.json({
          ok: true,
          session: {
            token: existingToken,
            userId: siteSession.userId || existing?.user_id || null,
            agentId: siteSession.agentId || null,
            primaryAgentId: siteSession.agentId || null,
            isAnonymous: siteSession.isAnonymous !== false,
            expiresAt: siteSession.expiresAt || existing?.expires_at || null,
            durable: siteSession.durable !== false,
          },
          renewed: true,
        });
      }
    }

    const userId = shortId(12);
    const token = shortId(24);
    const expiresAt = expiresAtFromNow();

    try {
      await createAnonymousUser(userId);
      await createSession(shortId(8), userId, token, expiresAt);
      setCachedSession({ token, userId, email: null, createdAt: Date.now(), expiresAt });

      return res.json({
        ok: true,
        session: {
          token,
          userId,
          agentId: null,
          primaryAgentId: null,
          isAnonymous: true,
          expiresAt,
          durable: true,
        },
      });
    } catch (err) {
      logStructured('error.auth.session.create', { error: err.message });
      if (isProduction) {
        return res.status(503).json({ ok: false, error: 'Session storage unavailable' });
      }

      const fallbackToken = shortId(20);
      const fallbackExpiresAt = expiresAtFromNow();
      setCachedSession({ token: fallbackToken, userId, createdAt: Date.now(), expiresAt: fallbackExpiresAt });
      return res.json({
        ok: true,
        session: {
          token: fallbackToken,
          userId,
          agentId: null,
          primaryAgentId: null,
          isAnonymous: true,
          expiresAt: fallbackExpiresAt,
          durable: false,
        },
      });
    }
  }

  function registerRoutes(app) {
    app.post('/api/auth/session', handleSession);

    app.post('/api/auth/magic-link/start', (_req, res) => {
      sendRetiredAccountResponse(res);
    });

    app.post('/api/auth/magic-link/consume', (_req, res) => {
      sendRetiredAccountResponse(res);
    });

    app.post('/api/auth/logout', (_req, res) => {
      sendRetiredAccountResponse(res);
    });

    app.get('/api/auth/me', (_req, res) => {
      sendRetiredAccountResponse(res);
    });

    app.post('/api/auth/register', (_req, res) => {
      sendRetiredAccountResponse(res);
    });

    app.post('/api/auth/upgrade', (_req, res) => {
      sendRetiredAccountResponse(res);
    });

    app.post('/api/owner/token', (_req, res) => {
      sendRetiredAccountResponse(res);
    });

    app.get('/api/matches/mine', (_req, res) => {
      sendRetiredAccountResponse(res);
    });
  }

  return {
    registerRoutes,
    resolveSiteSession,
    sendRetiredAccountResponse,
  };
}

module.exports = {
  createAccountModule,
  sendRetiredAccountResponse,
};
