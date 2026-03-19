const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app, agentProfiles, connectSessions, liveAgentRuntimes } = require('../server');
const {
  createAnonymousUser,
  upgradeUser,
  createMagicLinkTokenRecord,
  getSessionByToken,
} = require('../server/db');
const { hashSecret } = require('../server/services/secret-tokens');

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

function agentAuthHeaders(agentId, runtimeSecret) {
  return {
    authorization: `Bearer ${runtimeSecret}`,
    'x-openclaw-agent-id': agentId,
    'content-type': 'application/json',
  };
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

async function createAnonymousConnectSession(base) {
  const sessionToken = await createSiteSession(base);
  const createRes = await fetch(`${base}/api/openclaw/connect-session`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  assert.equal(created.ok, true);
  return created;
}

async function confirmConnectSession(base, created, body) {
  const confirmRes = await fetch(`${base}/api/openclaw/connect-session/${created.connect.id}/confirm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openclaw-callback-proof': created.connect.callbackProof,
    },
    body: JSON.stringify(body),
  });
  return {
    response: confirmRes,
    json: await confirmRes.json(),
  };
}

test('connect session endpoints require a site session and still require secret session access', async () => {
  await withServer(async (base) => {
    const noSessionRes = await fetch(`${base}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noSessionRes.status, 401);

    const created = await createAnonymousConnectSession(base);
    const id = created.connect.id;
    const accessToken = created.connect.accessToken;

    assert.ok(accessToken);
    assert.equal(created.connect.callbackProof.length > 0, true);
    assert.equal(created.connect.onboarding.pluginId, 'clawofdeceit-connect');
    assert.equal(created.connect.onboarding.pluginPackage, '@clawofdeceit/clawofdeceit-connect');
    assert.match(created.connect.onboarding.installCommand, /openclaw --profile clawofdeceit plugins install --pin @clawofdeceit\/clawofdeceit-connect/);
    assert.match(created.connect.onboarding.trustCommand, /openclaw --profile clawofdeceit config set plugins\.allow/);
    assert.match(created.connect.onboarding.enableCommand, /openclaw --profile clawofdeceit plugins enable clawofdeceit-connect/);
    assert.match(created.connect.onboarding.installerCommand, /openclaw --profile clawofdeceit plugins install --pin @clawofdeceit\/clawofdeceit-connect && openclaw --profile clawofdeceit config set plugins\.allow .* && openclaw --profile clawofdeceit plugins enable clawofdeceit-connect/);
    assert.equal(created.connect.onboarding.connectCommand, created.connect.command);
    assert.match(created.connect.onboarding.connectCommand, /openclaw --profile clawofdeceit clawofdeceit connect/);
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

    const queryStatus = await fetch(`${base}/api/openclaw/connect-session/${id}?accessToken=${encodeURIComponent(accessToken)}`);
    assert.equal(queryStatus.status, 401);

    const authStatus = await fetch(`${base}/api/openclaw/connect-session/${id}`, {
      headers: { 'x-connect-access-token': accessToken },
    });
    assert.equal(authStatus.status, 200);
    const statusData = await authStatus.json();
    assert.equal(statusData.ok, true);
    assert.equal('accessToken' in statusData.connect, false);
    assert.equal('callbackProof' in statusData.connect, false);
    assert.match(statusData.connect.arenaUrl, /\/connect\.html$/);
    assert.equal(statusData.connect.watchUrl, null);
    assert.equal('activeRoomId' in (statusData.connect.arena || {}), false);
    assert.equal('isLive' in (statusData.connect.arena || {}), true);
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
    assert.match(skillBody, /openclaw --profile clawofdeceit clawofdeceit connect --help/);
    assert.match(skillBody, /openclaw --profile clawofdeceit clawofdeceit agents --help/);
    assert.match(skillBody, /openclaw --profile clawofdeceit plugins install --pin @clawofdeceit\/clawofdeceit-connect/);
    assert.match(skillBody, new RegExp(`Connect token: ${id}`));
    assert.match(skillBody, new RegExp(`Callback proof: ${created.connect.callbackProof}`));
    assert.match(skillBody, /installed connector is outdated and rerun the same setup block/);
    assert.match(skillBody, /return to `\/connect\.html` and use the step-by-step fallback/);
    assert.match(skillBody, /dedicated OpenClaw profile `clawofdeceit`|dedicated `clawofdeceit` OpenClaw profile/);
    assert.match(skillBody, /future startup remains manual unless I explicitly enable it later/);
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
    assert.doesNotMatch(skillBody, /current OpenClaw profile/i);
    assert.doesNotMatch(skillBody, /automatically on future startup/i);
    assert.doesNotMatch(skillBody, /migrate-profile/i);
    assert.doesNotMatch(skillBody, /from `main`/i);
    assert.doesNotMatch(skillBody, /\/guide\.html/);

    const queryConfirm = await fetch(`${base}/api/openclaw/connect-session/${id}/confirm?accessToken=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentName: 'query_attacker' }),
    });
    assert.equal(queryConfirm.status, 401);

    const storedConnect = connectSessions.get(id);
    assert.ok(storedConnect);
    storedConnect.expiresAt = Date.now() - 1;

    const expiredSkill = await fetch(`${base}/api/openclaw/connect-session/${id}/skill.md?accessToken=${encodeURIComponent(accessToken)}`);
    assert.equal(expiredSkill.status, 410);
  });
});

test('duplicate agent names are rejected during permanent binding', async () => {
  await withServer(async (base) => {
    const sharedName = `duplicate_agent_${Date.now()}`;

    const first = await createAnonymousConnectSession(base);
    const firstConfirm = await confirmConnectSession(base, first, {
      agentName: sharedName,
      style: 'friendly manipulator',
    });
    assert.equal(firstConfirm.response.status, 200);
    assert.equal(firstConfirm.json.ok, true);
    assert.ok(firstConfirm.json.agent?.id);

    const second = await createAnonymousConnectSession(base);
    const secondConfirm = await confirmConnectSession(base, second, {
      agentName: sharedName,
      style: 'pragmatic operator',
    });
    assert.equal(secondConfirm.response.status, 409);
    assert.equal(secondConfirm.json.ok, false);
    assert.equal(secondConfirm.json.code, 'AGENT_NAME_TAKEN');
  });
});

test('magic link verification sets a site session cookie and redirects without leaking the token in the URL', async () => {
  await withServer(async (base) => {
    const loginToken = 'magic-link-test-token';
    const expiresAt = new Date(Date.now() + (5 * 60 * 1000)).toISOString();

    await createAnonymousUser('magic-user');
    await upgradeUser('magic-user', { email: 'magic@example.com', displayName: 'Magic User' });
    await createMagicLinkTokenRecord({
      tokenHash: hashSecret(loginToken),
      userId: 'magic-user',
      email: 'magic@example.com',
      intent: 'login',
      expiresAt,
    });

    const verifyRes = await fetch(`${base}/api/auth/verify?token=${encodeURIComponent(loginToken)}`, {
      redirect: 'manual',
    });

    assert.equal(verifyRes.status, 302);
    assert.equal(verifyRes.headers.get('location'), '/connect.html');

    const setCookie = verifyRes.headers.get('set-cookie') || '';
    assert.match(setCookie, /site_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(String(verifyRes.headers.get('location') || ''), /authToken=/);

    const issuedToken = decodeURIComponent((setCookie.match(/site_session=([^;]+)/) || [])[1] || '');
    assert.ok(issuedToken);

    const session = await getSessionByToken(issuedToken);
    assert.ok(session);
    assert.equal(session.user_id, 'magic-user');
  });
});

test('bound-agent management routes use the saved reusable agent token', async () => {
  await withServer(async (base) => {
    const created = await createAnonymousConnectSession(base);
    const confirmed = await confirmConnectSession(base, created, {
      agentName: `bound_agent_${Date.now()}`,
      style: 'friendly manipulator',
    });

    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.json.ok, true);
    assert.ok(confirmed.json.agent?.id);
    assert.equal(confirmed.json.agent.persona.presetId, 'charming');
    assert.equal(confirmed.json.agent.persona.style, 'friendly manipulator');
    assert.ok(confirmed.json.runtimeCredential?.runtimeSecret);

    const agentId = confirmed.json.agent.id;
    const runtimeSecret = confirmed.json.runtimeCredential.runtimeSecret;

    const managedRes = await fetch(`${base}/api/openclaw/agents/${agentId}`, {
      headers: agentAuthHeaders(agentId, runtimeSecret),
    });
    assert.equal(managedRes.status, 200);
    const managed = await managedRes.json();
    assert.equal(managed.ok, true);
    assert.equal(managed.agent.id, agentId);
    assert.equal(managed.agent.lifecycleState, 'active');
    assert.match(managed.agent.arenaUrl, /\/connect\.html\?agentId=/);
    assert.equal(managed.management.styleSyncPath, `/api/openclaw/agents/${encodeURIComponent(agentId)}/style-sync`);
    assert.equal(managed.management.archivePath, `/api/openclaw/agents/${encodeURIComponent(agentId)}/archive`);

    const styleSyncRes = await fetch(`${base}/api/openclaw/agents/${agentId}/style-sync`, {
      method: 'POST',
      headers: agentAuthHeaders(agentId, runtimeSecret),
      body: JSON.stringify({
        profile: {
          preset: 'chaotic',
          tone: 'chaotic preacher',
          intensity: 9,
        },
      }),
    });
    assert.equal(styleSyncRes.status, 200);
    const synced = await styleSyncRes.json();
    assert.equal(synced.ok, true);
    assert.equal(synced.agent.persona.presetId, 'chaotic');
    assert.equal(synced.agent.persona.style, 'chaotic preacher');
    assert.equal(synced.agent.persona.intensity, 9);

    const archiveRes = await fetch(`${base}/api/openclaw/agents/${agentId}/archive`, {
      method: 'POST',
      headers: agentAuthHeaders(agentId, runtimeSecret),
      body: JSON.stringify({}),
    });
    assert.equal(archiveRes.status, 200);
    const archived = await archiveRes.json();
    assert.equal(archived.ok, true);
    assert.equal(archived.agent.id, agentId);
    assert.equal(archived.agent.lifecycleState, 'archived');
    assert.ok(archived.agent.archivedAt);

    const afterArchiveRes = await fetch(`${base}/api/openclaw/agents/${agentId}`, {
      headers: agentAuthHeaders(agentId, runtimeSecret),
    });
    assert.equal(afterArchiveRes.status, 401);
    const afterArchive = await afterArchiveRes.json();
    assert.equal(afterArchive.ok, false);
    assert.equal(afterArchive.code, 'INVALID_AGENT_TOKEN');
  });
});

test('legacy public openclaw style-sync route is unavailable', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/openclaw/style-sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: {
          preset: 'chaotic',
          tone: 'intruder',
        },
      }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'ROUTE_UNAVAILABLE');
  });
});
