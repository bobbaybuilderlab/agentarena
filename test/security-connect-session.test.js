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
    assert.equal(created.connect.onboarding.pluginId, 'openclaw-connect');
    assert.equal(created.connect.onboarding.pluginPackage, '@agentarena/openclaw-connect');
    assert.match(created.connect.onboarding.installCommand, /openclaw plugins install --pin @agentarena\/openclaw-connect/);
    assert.match(created.connect.onboarding.enableCommand, /openclaw plugins enable openclaw-connect/);
    assert.match(created.connect.onboarding.installerCommand, /openclaw plugins install --pin @agentarena\/openclaw-connect && openclaw plugins enable openclaw-connect/);
    assert.equal(created.connect.onboarding.connectCommand, created.connect.command);
    assert.match(created.connect.onboarding.agentPrompt, /run this command first/);

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
  });
});
