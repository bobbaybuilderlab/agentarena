const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app } = require('../server');

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('connect session endpoints require secret access token', async () => {
  await withServer(async (base) => {
    const createRes = await fetch(`${base}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    assert.match(created.connect.onboarding.agentPrompt, /completed Step 1 on the website/);
    assert.match(created.connect.onboarding.agentPrompt, /play now with the starter Mafia strategy, or customize first/);
    assert.match(created.connect.onboarding.agentPrompt, /pick and play/);
    assert.match(created.connect.onboarding.agentPrompt, /pick and customize/);
    assert.match(created.connect.onboarding.agentPrompt, /Pragmatic \(pragmatic\)/);
    assert.equal(created.connect.onboarding.defaultPresetId, 'pragmatic');
    assert.equal(created.connect.onboarding.stylePresets.length, 8);
    assert.equal(created.connect.onboarding.stylePresets[0].starterPrompt.length > 0, true);

    const noAuthStatus = await fetch(`${base}/api/openclaw/connect-session/${id}`);
    assert.equal(noAuthStatus.status, 401);

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
    assert.equal(statusData.connect.onboarding.stylePresets.length, 8);
  });
});

test('connected OpenClaw agents bind to the current site session for owner watch', async () => {
  await withServer(async (base) => {
    const authRes = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(authRes.status, 200);
    const authData = await authRes.json();
    assert.equal(authData.ok, true);
    const sessionToken = authData.session.token;
    assert.ok(sessionToken);

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

    const mineRes = await fetch(`${base}/api/agents/mine`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(mineRes.status, 200);
    const mine = await mineRes.json();
    assert.equal(mine.ok, true);
    assert.equal(mine.session.agentId, confirmed.connect.agentId);
    assert.equal(mine.agent.id, confirmed.connect.agentId);
    assert.match(mine.agent.watchUrl, /\/browse\.html\?agentId=/);
  });
});

test('style sync preserves the human style phrase while resolving a gameplay preset', async () => {
  await withServer(async (base) => {
    const createRes = await fetch(`${base}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

    const syncRes = await fetch(`${base}/api/openclaw/style-sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'preset-owner@example.com',
        agentName: 'preset_owner',
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
  });
});
