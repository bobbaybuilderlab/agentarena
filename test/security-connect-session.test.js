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

test('connect session endpoints require a site session and secret access token', async () => {
  await withServer(async (base) => {
    const noSessionRes = await fetch(`${base}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'victim@example.com' }),
    });
    assert.equal(noSessionRes.status, 401);

    const sessionToken = await createSiteSession(base);
    const createRes = await fetch(`${base}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ email: 'victim@example.com' }),
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
    assert.equal(created.connect.onboarding.stylePresets[0].starterPrompt.length > 0, true);
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
    assert.match(skillBody, /openclaw clawofdeceit auth --owner-token <token>/);
    assert.doesNotMatch(skillBody, /\/guide\.html/);

    const storedConnect = connectSessions.get(id);
    assert.ok(storedConnect);
    storedConnect.expiresAt = Date.now() - 1;

    const expiredSkill = await fetch(`${base}/api/openclaw/connect-session/${id}/skill.md?accessToken=${encodeURIComponent(accessToken)}`);
    assert.equal(expiredSkill.status, 410);
  });
});

test('connected OpenClaw agents bind to the current site session for owner watch', async () => {
  await withServer(async (base) => {
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

    const confirmRes = await fetch(`${base}/api/openclaw/connect-session/${created.connect.id}/confirm?accessToken=${encodeURIComponent(created.connect.accessToken)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentName: 'owner_agent', style: 'paranoid detective' }),
    });
    assert.equal(confirmRes.status, 200);
    const confirmed = await confirmRes.json();
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.connect.agentId.length > 0, true);
    assert.equal(confirmed.agent.persona.presetId, 'paranoid');
    assert.equal(confirmed.agent.persona.style, 'paranoid detective');
    liveAgentRuntimes.set(confirmed.connect.agentId, {
      agentId: confirmed.connect.agentId,
      connected: true,
      status: 'idle',
      socketId: `sock-${confirmed.connect.agentId}`,
      currentRoomId: null,
      currentPlayerId: null,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    const mineRes = await fetch(`${base}/api/agents/mine`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(mineRes.status, 200);
    const mine = await mineRes.json();
    assert.equal(mine.ok, true);
    assert.equal(mine.session.agentId, confirmed.connect.agentId);
    assert.equal(mine.session.primaryAgentId, confirmed.connect.agentId);
    assert.equal(mine.session.isAnonymous, true);
    assert.equal(Array.isArray(mine.agents), true);
    assert.equal(mine.agents.length, 1);
    assert.equal(mine.selectedAgentId, confirmed.connect.agentId);
    assert.equal(mine.agent.id, confirmed.connect.agentId);
    assert.match(mine.agent.watchUrl, /\/arena\.html\?agentId=/);
    assert.equal(mine.agent.arena.runtimeConnected, true);
    assert.equal(typeof mine.stats, 'object');
    assert.equal(mine.stats.gamesPlayed, 0);
    assert.equal(mine.stats.mmr, 1000);
    assert.equal(mine.stats.ratedMatches, 0);
    assert.equal(mine.stats.isProvisional, true);
    assert.equal(mine.stats.nightKillCredits, 0);
    assert.equal(confirmed.agent.ownerUserId, mine.session.userId);
  });
});

test('logout clears only the browser session and magic-link login restores the same claimed agent', async () => {
  await withServer(async (base) => {
    const sessionToken = await createSiteSession(base);
    const createRes = await fetch(`${base}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ email: 'preset-owner@example.com' }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.equal(created.ok, true);

    const callbackRes = await fetch(`${base}/api/openclaw/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: created.connect.id,
        proof: created.connect.callbackProof,
        agentName: 'preset_owner',
        style: 'friendly manipulator',
      }),
    });
    assert.equal(callbackRes.status, 200);
    const connected = await callbackRes.json();
    assert.equal(connected.ok, true);
    assert.equal(connected.agent.persona.presetId, 'charming');
    assert.equal(connected.agent.persona.style, 'friendly manipulator');

    const claimStartRes = await fetch(`${base}/api/auth/magic-link/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        email: 'preset-owner@example.com',
        mode: 'claim',
        agentId: connected.agent.id,
      }),
    });
    assert.equal(claimStartRes.status, 200);
    const claimStart = await claimStartRes.json();
    assert.equal(claimStart.ok, true);
    assert.ok(claimStart.debug?.magicLinkToken);

    const claimConsumeRes = await fetch(`${base}/api/auth/magic-link/consume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ token: claimStart.debug.magicLinkToken }),
    });
    assert.equal(claimConsumeRes.status, 200);
    const claimConsume = await claimConsumeRes.json();
    assert.equal(claimConsume.ok, true);
    assert.equal(claimConsume.user.email, 'preset-owner@example.com');
    assert.equal(claimConsume.user.agentId, connected.agent.id);

    const ownerTokenRes = await fetch(`${base}/api/owner/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${claimConsume.session.token}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(ownerTokenRes.status, 200);
    const ownerTokenData = await ownerTokenRes.json();
    assert.equal(ownerTokenData.ok, true);
    assert.ok(ownerTokenData.ownerToken);

    const syncRes = await fetch(`${base}/api/openclaw/style-sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ownerTokenData.ownerToken}`,
      },
      body: JSON.stringify({
        profile: {
          preset: 'chaotic',
          tone: 'chaotic preacher',
          intensity: 9,
        },
      }),
    });
    assert.equal(syncRes.status, 200);
    const synced = await syncRes.json();
    assert.equal(synced.ok, true);
    assert.equal(synced.agent.persona.presetId, 'chaotic');
    assert.equal(synced.agent.persona.style, 'chaotic preacher');
    assert.equal(synced.agent.persona.intensity, 9);

    const logoutRes = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${claimConsume.session.token}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(logoutRes.status, 200);
    const logoutData = await logoutRes.json();
    assert.equal(logoutData.ok, true);

    const meAfterLogoutRes = await fetch(`${base}/api/auth/me`, {
      headers: { authorization: `Bearer ${claimConsume.session.token}` },
    });
    assert.equal(meAfterLogoutRes.status, 401);

    const loginStartRes = await fetch(`${base}/api/auth/magic-link/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'preset-owner@example.com',
        mode: 'login',
      }),
    });
    assert.equal(loginStartRes.status, 200);
    const loginStart = await loginStartRes.json();
    assert.equal(loginStart.ok, true);
    assert.ok(loginStart.debug?.magicLinkToken);

    const loginConsumeRes = await fetch(`${base}/api/auth/magic-link/consume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: loginStart.debug.magicLinkToken }),
    });
    assert.equal(loginConsumeRes.status, 200);
    const loginConsume = await loginConsumeRes.json();
    assert.equal(loginConsume.ok, true);
    assert.equal(loginConsume.user.email, 'preset-owner@example.com');
    assert.equal(loginConsume.user.agentId, connected.agent.id);

    const restoredMineRes = await fetch(`${base}/api/agents/mine`, {
      headers: { authorization: `Bearer ${loginConsume.session.token}` },
    });
    assert.equal(restoredMineRes.status, 200);
    const restoredMine = await restoredMineRes.json();
    assert.equal(restoredMine.ok, true);
    assert.equal(restoredMine.selectedAgentId, connected.agent.id);
    assert.equal(restoredMine.session.primaryAgentId, connected.agent.id);
    assert.equal(restoredMine.agent.id, connected.agent.id);
  });
});

test('one site session can own multiple connected OpenClaws and select between them', async () => {
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
      liveAgentRuntimes.set(confirmed.agent.id, {
        agentId: confirmed.agent.id,
        connected: true,
        status: 'idle',
        socketId: `sock-${confirmed.agent.id}`,
        currentRoomId: null,
        currentPlayerId: null,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      return confirmed.agent.id;
    }

    const alphaId = await connectAgent('alpha_watch', 'patient observer');
    const bravoId = await connectAgent('bravo_watch', 'chaotic preacher');

    const mineRes = await fetch(`${base}/api/agents/mine`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(mineRes.status, 200);
    const mine = await mineRes.json();
    assert.equal(mine.ok, true);
    assert.equal(mine.session.primaryAgentId, bravoId);
    assert.equal(mine.selectedAgentId, bravoId);
    assert.equal(mine.agents.length, 2);
    assert.deepEqual(mine.agents.map((agent) => agent.id).sort(), [alphaId, bravoId].sort());

    const alphaRes = await fetch(`${base}/api/agents/mine?agentId=${encodeURIComponent(alphaId)}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(alphaRes.status, 200);
    const alphaMine = await alphaRes.json();
    assert.equal(alphaMine.ok, true);
    assert.equal(alphaMine.selectedAgentId, alphaId);
    assert.equal(alphaMine.agent.id, alphaId);
    assert.equal(alphaMine.session.primaryAgentId, alphaId);

    liveAgentRuntimes.set(bravoId, {
      ...liveAgentRuntimes.get(bravoId),
      connected: false,
      status: 'offline',
      socketId: null,
    });

    const offlineRes = await fetch(`${base}/api/agents/mine`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(offlineRes.status, 200);
    const offlineMine = await offlineRes.json();
    assert.equal(offlineMine.ok, true);
    assert.equal(Array.isArray(offlineMine.agents), true);
    assert.equal(offlineMine.agents.length, 2);
    assert.equal(offlineMine.agents.some((agent) => agent.id === bravoId), true);
    const offlineBravo = offlineMine.agents.find((agent) => agent.id === bravoId);
    assert.equal(offlineBravo.arena.runtimeConnected, false);
    assert.equal(typeof offlineBravo.lastConnectedAt, 'string');

    const offlineBravoRes = await fetch(`${base}/api/agents/mine?agentId=${encodeURIComponent(bravoId)}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(offlineBravoRes.status, 200);
    const offlineBravoMine = await offlineBravoRes.json();
    assert.equal(offlineBravoMine.ok, true);
    assert.equal(offlineBravoMine.selectedAgentId, bravoId);
    assert.equal(offlineBravoMine.agent.id, bravoId);
  });
});
