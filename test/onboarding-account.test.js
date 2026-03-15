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

async function registerUser(base, email = 'test@example.com', displayName = 'Test User') {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, displayName }),
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  return data.session.token;
}

test('unauthenticated create-agent returns 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/openclaw/create-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });
});

test('register user, create agent, activate via callback, list in /agents/mine', async () => {
  await withServer(async (base) => {
    const token = await registerUser(base, 'owner@example.com', 'Owner');

    // Create a pending agent
    const createRes = await fetch(`${base}/api/openclaw/create-agent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.equal(created.ok, true);
    assert.ok(created.agentId);
    assert.match(created.joinMessage, /Read .*\/skill\.md and follow the instructions to join Claw of Deceit\./);
    assert.match(created.joinMessage, /Your session token:/);
    assert.match(created.joinMessage, /Your agent ID:/);
    assert.equal(created.onboarding.defaultPresetId, 'pragmatic');
    assert.equal(created.onboarding.stylePresets.length, 8);

    // Activate via callback
    const callbackRes = await fetch(`${base}/api/openclaw/callback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        agentId: created.agentId,
        agentName: 'owner_agent',
        style: 'paranoid detective',
      }),
    });
    assert.equal(callbackRes.status, 200);
    const activated = await callbackRes.json();
    assert.equal(activated.ok, true);
    assert.equal(activated.agent.persona.presetId, 'paranoid');
    assert.equal(activated.agent.persona.style, 'paranoid detective');
    assert.equal(activated.agent.deployed, true);

    // Verify in /agents/mine
    const mineRes = await fetch(`${base}/api/agents/mine`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(mineRes.status, 200);
    const mine = await mineRes.json();
    assert.equal(mine.ok, true);
    assert.equal(mine.agents.length, 1);
    assert.equal(mine.agents[0].id, created.agentId);
    assert.match(mine.agents[0].watchUrl, /\/browse\.html\?agentId=/);
  });
});

test('callback with wrong agentId returns 404', async () => {
  await withServer(async (base) => {
    const token = await registerUser(base, 'wrong@example.com', 'Wrong');

    const callbackRes = await fetch(`${base}/api/openclaw/callback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        agentId: 'nonexistent',
        agentName: 'attacker',
      }),
    });
    assert.equal(callbackRes.status, 404);
  });
});

test('multiple agents per user', async () => {
  await withServer(async (base) => {
    const token = await registerUser(base, 'multi@example.com', 'Multi');
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };

    // Create and activate two agents
    const create1 = await (await fetch(`${base}/api/openclaw/create-agent`, { method: 'POST', headers, body: '{}' })).json();
    const create2 = await (await fetch(`${base}/api/openclaw/create-agent`, { method: 'POST', headers, body: '{}' })).json();
    assert.equal(create1.ok, true);
    assert.equal(create2.ok, true);
    assert.notEqual(create1.agentId, create2.agentId);

    await fetch(`${base}/api/openclaw/callback`, {
      method: 'POST', headers,
      body: JSON.stringify({ agentId: create1.agentId, agentName: 'agent_one', style: 'pragmatic operator' }),
    });
    await fetch(`${base}/api/openclaw/callback`, {
      method: 'POST', headers,
      body: JSON.stringify({ agentId: create2.agentId, agentName: 'agent_two', style: 'chaotic preacher' }),
    });

    const mine = await (await fetch(`${base}/api/agents/mine`, { headers })).json();
    assert.equal(mine.ok, true);
    assert.equal(mine.agents.length, 2);
    const names = mine.agents.map(a => a.name).sort();
    assert.deepEqual(names, ['agent_one', 'agent_two']);
  });
});

test('style sync preserves the human style phrase while resolving a gameplay preset', async () => {
  await withServer(async (base) => {
    const token = await registerUser(base, 'preset-owner@example.com', 'Preset Owner');
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };

    const created = await (await fetch(`${base}/api/openclaw/create-agent`, { method: 'POST', headers, body: '{}' })).json();
    assert.equal(created.ok, true);

    const callbackRes = await fetch(`${base}/api/openclaw/callback`, {
      method: 'POST', headers,
      body: JSON.stringify({
        agentId: created.agentId,
        agentName: 'preset_owner',
        style: 'friendly manipulator',
      }),
    });
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
    const synced = await syncRes.json();
    assert.equal(synced.ok, true);
    assert.equal(synced.agent.persona.presetId, 'chaotic');
    assert.equal(synced.agent.persona.style, 'chaotic preacher');
    assert.equal(synced.agent.persona.intensity, 9);
  });
});
