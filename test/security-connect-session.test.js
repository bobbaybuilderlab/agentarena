const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app, agentProfiles, connectSessions, liveAgentRuntimes } = require('../server');

async function withServer(run) {
  const server = http.createServer(app);
  agentProfiles.clear();
  connectSessions.clear();
  liveAgentRuntimes.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await run(base);
  } finally {
    liveAgentRuntimes.clear();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function createSiteSession(base) {
  const authRes = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(authRes.status, 200);
  const authData = await authRes.json();
  assert.equal(authData.ok, true);
  assert.ok(authData.session?.token);
  return authData.session.token;
}

test('connect-session routes require a site session and keep the session skill aligned with the reduced MVP surface', async () => {
  await withServer(async (base) => {
    const noSessionRes = await fetch(`${base}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noSessionRes.status, 401);

    const sessionToken = await createSiteSession(base);
    const createRes = await fetch(`${base}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.equal(created.ok, true);
    const id = created.connect.id;
    const accessToken = created.connect.accessToken;
    assert.ok(accessToken);
    assert.equal(created.connect.callbackProof.length > 0, true);
    assert.equal(created.connect.onboarding.pluginId, 'clawofdeceit-connect');
    assert.equal(created.connect.onboarding.pluginPackage, '@clawofdeceit/clawofdeceit-connect');
    assert.match(created.connect.onboarding.installCommand, /openclaw plugins install --pin @clawofdeceit\/clawofdeceit-connect/);
    assert.match(created.connect.onboarding.trustCommand, /openclaw config set plugins\.allow/);
    assert.match(created.connect.onboarding.enableCommand, /openclaw plugins enable clawofdeceit-connect/);
    assert.match(created.connect.onboarding.installerCommand, /openclaw plugins install --pin @clawofdeceit\/clawofdeceit-connect && openclaw config set plugins\.allow .* && openclaw plugins enable clawofdeceit-connect/);
    assert.equal(created.connect.onboarding.connectCommand, created.connect.command);
    assert.match(created.connect.onboarding.skillUrl, /\/skill\.md$/);
    assert.match(created.connect.onboarding.sessionSkillUrl, new RegExp(`/api/openclaw/connect-session/${id}/skill\\.md\\?accessToken=`));
    assert.equal(
      created.connect.onboarding.agentPrompt,
      `Read this Claw of Deceit skill and follow it exactly: ${created.connect.onboarding.sessionSkillUrl}`,
    );
    assert.equal(created.connect.onboarding.defaultPresetId, 'pragmatic');
    assert.equal(created.connect.onboarding.stylePresets.length, 8);
    assert.equal(created.connect.onboarding.advancedSetupUrl, '/connect.html');

    const noAuthStatus = await fetch(`${base}/api/openclaw/connect-session/${id}`);
    assert.equal(noAuthStatus.status, 401);

    const noAuthSkill = await fetch(`${base}/api/openclaw/connect-session/${id}/skill.md`);
    assert.equal(noAuthSkill.status, 401);

    const noAuthConfirm = await fetch(`${base}/api/openclaw/connect-session/${id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentName: 'attacker' }),
    });
    assert.equal(noAuthConfirm.status, 401);

    const authStatus = await fetch(`${base}/api/openclaw/connect-session/${id}?accessToken=${encodeURIComponent(accessToken)}`);
    assert.equal(authStatus.status, 200);
    const statusData = await authStatus.json();
    assert.equal(statusData.ok, true);
    assert.equal('accessToken' in statusData.connect, false);
    assert.equal('callbackProof' in statusData.connect, false);
    assert.equal('watchUrl' in statusData.connect, false);
    assert.equal(statusData.connect.onboarding.connectCommand, null);
    assert.equal(statusData.connect.onboarding.agentPrompt, null);
    assert.equal(statusData.connect.onboarding.sessionSkillUrl, null);
    assert.equal(statusData.connect.onboarding.stylePresets.length, 8);

    const authSkill = await fetch(`${base}/api/openclaw/connect-session/${id}/skill.md?accessToken=${encodeURIComponent(accessToken)}`);
    assert.equal(authSkill.status, 200);
    assert.match(authSkill.headers.get('content-type') || '', /text\/markdown/);
    assert.match(authSkill.headers.get('cache-control') || '', /no-store/);
    assert.equal(authSkill.headers.get('x-robots-tag'), 'noindex, nofollow');
    const skillBody = await authSkill.text();
    assert.match(skillBody, /Claw of Deceit Session Skill/);
    assert.match(skillBody, /openclaw clawofdeceit connect --help/);
    assert.match(skillBody, /openclaw plugins install --pin @clawofdeceit\/clawofdeceit-connect/);
    assert.match(skillBody, new RegExp(`Connect token: ${id}`));
    assert.match(skillBody, new RegExp(`Callback proof: ${created.connect.callbackProof}`));
    assert.match(skillBody, /return to `\/connect\.html` and use the step-by-step fallback/);
    const namePromptIndex = skillBody.indexOf('Help me pick a short agent name.');
    const branchPromptIndex = skillBody.indexOf('Do you want to play now with the starter Mafia strategy, or customize first?');
    assert.notEqual(namePromptIndex, -1);
    assert.notEqual(branchPromptIndex, -1);
    assert.equal(namePromptIndex < branchPromptIndex, true);
    assert.match(skillBody, /play now with the starter Mafia strategy, or customize first/);
    assert.match(skillBody, /pick and play/);
    assert.match(skillBody, /pick and customize/);
    assert.match(skillBody, /Pragmatic \(pragmatic\)/);
    assert.doesNotMatch(skillBody, /owner token/i);
    assert.doesNotMatch(skillBody, /dashboard/i);
    assert.doesNotMatch(skillBody, /magic link/i);
    assert.doesNotMatch(skillBody, /sync-style/i);
    assert.doesNotMatch(skillBody, /\/guide\.html/);

    const storedConnect = connectSessions.get(id);
    assert.ok(storedConnect);
    storedConnect.expiresAt = Date.now() - 1;

    const expiredSkill = await fetch(`${base}/api/openclaw/connect-session/${id}/skill.md?accessToken=${encodeURIComponent(accessToken)}`);
    assert.equal(expiredSkill.status, 410);
  });
});

test('each confirmed connect session creates a fresh agent id for multi-agent use', async () => {
  await withServer(async (base) => {
    const sessionToken = await createSiteSession(base);

    async function connectAgent(agentName, style) {
      const createRes = await fetch(`${base}/api/openclaw/connect-session`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(createRes.status, 200);
      const created = await createRes.json();

      const confirmRes = await fetch(`${base}/api/openclaw/connect-session/${created.connect.id}/confirm?accessToken=${encodeURIComponent(created.connect.accessToken)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentName, style }),
      });
      assert.equal(confirmRes.status, 200);
      const confirmed = await confirmRes.json();
      assert.equal(confirmed.ok, true);
      assert.equal('watchUrl' in confirmed.connect, false);
      return confirmed;
    }

    const alpha = await connectAgent('alpha_one', 'paranoid detective');
    const bravo = await connectAgent('bravo_two', 'friendly manipulator');

    assert.notEqual(alpha.agent.id, bravo.agent.id);
    assert.equal(alpha.agent.persona.presetId, 'paranoid');
    assert.equal(bravo.agent.persona.presetId, 'charming');
    assert.equal(agentProfiles.size, 2);
  });
});

test('retired dashboard and ownership routes return 410 and old pages redirect to the leaderboard', async () => {
  await withServer(async (base) => {
    const retiredRoutes = [
      { method: 'post', path: '/api/auth/magic-link/start' },
      { method: 'post', path: '/api/auth/magic-link/consume' },
      { method: 'post', path: '/api/auth/logout' },
      { method: 'get', path: '/api/auth/me' },
      { method: 'post', path: '/api/auth/register' },
      { method: 'post', path: '/api/auth/upgrade' },
      { method: 'post', path: '/api/owner/token' },
      { method: 'get', path: '/api/matches/mine' },
      { method: 'get', path: '/api/agents/mine' },
      { method: 'post', path: '/api/openclaw/style-sync' },
      { method: 'get', path: '/api/play/watch' },
    ];

    for (const route of retiredRoutes) {
      const res = await fetch(`${base}${route.path}`, {
        method: route.method.toUpperCase(),
        headers: { 'content-type': 'application/json' },
        body: route.method === 'post' ? JSON.stringify({}) : undefined,
      });
      assert.equal(res.status, 410, `${route.method.toUpperCase()} ${route.path} should be retired`);
      const data = await res.json();
      assert.match(data.error || '', /not part of the current MVP/i);
    }

    const arenaRedirect = await fetch(`${base}/arena.html`, { redirect: 'manual' });
    assert.equal(arenaRedirect.status, 302);
    assert.equal(arenaRedirect.headers.get('location'), '/leaderboard.html');

    const accountRedirect = await fetch(`${base}/account.html`, { redirect: 'manual' });
    assert.equal(accountRedirect.status, 302);
    assert.equal(accountRedirect.headers.get('location'), '/leaderboard.html');
  });
});

test('public legal and help pages do not advertise the retired My Games surface', async () => {
  await withServer(async (base) => {
    for (const pagePath of ['/help.html', '/privacy.html', '/terms.html']) {
      const res = await fetch(`${base}${pagePath}`);
      assert.equal(res.status, 200, `${pagePath} should load`);
      const html = await res.text();
      assert.doesNotMatch(html, /href="\/arena\.html"/i, `${pagePath} should not link to /arena.html`);
      assert.doesNotMatch(html, />My Games</i, `${pagePath} should not mention My Games`);
    }
  });
});
