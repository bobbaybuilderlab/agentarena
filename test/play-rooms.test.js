const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

const {
  server,
  mafiaRooms,
  roomEvents,
  clearAllGameTimers,
  resetPlayTelemetry,
  isLoopbackRemoteAddress,
  opsSurfaceEnabled,
  manualMafiaSocketFeatureEnabled,
} = require('../server');

function setEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function withServer(fn) {
  mafiaRooms.clear();
  roomEvents.clear();
  resetPlayTelemetry();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  try {
    await fn(url);
  } finally {
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('public play routes are retired from the MVP surface', async () => {
  await withServer(async (url) => {
    const retiredRoutes = [
      { method: 'GET', path: '/api/play/rooms' },
      { method: 'GET', path: '/api/play/lobby/claims?mode=mafia&roomId=ROOM1' },
      { method: 'POST', path: '/api/play/reconnect-telemetry', body: { mode: 'mafia', roomId: 'ROOM1', outcome: 'attempt' } },
      { method: 'POST', path: '/api/play/quick-join', body: { mode: 'mafia', name: 'QueueRunner' } },
      { method: 'POST', path: '/api/play/lobby/autofill', body: { mode: 'mafia', roomId: 'ROOM1' } },
      { method: 'POST', path: '/api/play/instant', body: { mode: 'mafia' } },
    ];

    for (const route of retiredRoutes) {
      const res = await fetch(`${url}${route.path}`, {
        method: route.method,
        headers: route.body ? { 'Content-Type': 'application/json' } : undefined,
        body: route.body ? JSON.stringify(route.body) : undefined,
      });
      assert.equal(res.status, 410, `${route.method} ${route.path} should be retired`);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(body.error || '', /not part of the current MVP/i);
    }
  });
});

test('loopback helper only allows localhost addresses for ops access', () => {
  assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true);
  assert.equal(isLoopbackRemoteAddress('::1'), true);
  assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackRemoteAddress('10.0.0.2'), false);
  assert.equal(isLoopbackRemoteAddress('::ffff:10.0.0.2'), false);
});

test('manual mafia socket controls require an explicit local flag and stay disabled in production', () => {
  const previous = process.env.ENABLE_MANUAL_MAFIA_SOCKET;
  try {
    setEnv('ENABLE_MANUAL_MAFIA_SOCKET', null);
    assert.equal(manualMafiaSocketFeatureEnabled('development'), false);
    assert.equal(manualMafiaSocketFeatureEnabled(''), false);
    setEnv('ENABLE_MANUAL_MAFIA_SOCKET', '1');
    assert.equal(manualMafiaSocketFeatureEnabled('production'), false);
    assert.equal(manualMafiaSocketFeatureEnabled('Production'), false);
    assert.equal(manualMafiaSocketFeatureEnabled('development'), true);
    assert.equal(manualMafiaSocketFeatureEnabled(''), true);
  } finally {
    setEnv('ENABLE_MANUAL_MAFIA_SOCKET', previous);
  }
});

test('ops surface requires an explicit local flag and stays disabled in production', () => {
  const previous = process.env.ENABLE_LOCAL_OPS;
  try {
    setEnv('ENABLE_LOCAL_OPS', null);
    assert.equal(opsSurfaceEnabled('development'), false);
    assert.equal(opsSurfaceEnabled(''), false);
    setEnv('ENABLE_LOCAL_OPS', '1');
    assert.equal(opsSurfaceEnabled('production'), false);
    assert.equal(opsSurfaceEnabled('Production'), false);
    assert.equal(opsSurfaceEnabled('development'), true);
    assert.equal(opsSurfaceEnabled(''), true);
  } finally {
    setEnv('ENABLE_LOCAL_OPS', previous);
  }
});

test('ops rooms endpoint is loopback-only and returns the legacy room summary shape locally', async () => {
  const previousOps = process.env.ENABLE_LOCAL_OPS;
  const previousManual = process.env.ENABLE_MANUAL_MAFIA_SOCKET;
  setEnv('ENABLE_LOCAL_OPS', '1');
  setEnv('ENABLE_MANUAL_MAFIA_SOCKET', '1');
  try {
    await withServer(async (url) => {
      const host = ioc(url, { reconnection: false, autoUnref: true });
      const guest = ioc(url, { reconnection: false, autoUnref: true });

      try {
        const created = await emitAck(host, 'mafia:room:create', { name: 'Host' });
        assert.equal(created.ok, true);
        const joined = await emitAck(guest, 'mafia:room:join', { roomId: created.roomId, name: 'Guest' });
        assert.equal(joined.ok, true);

        const opsPage = await fetch(`${url}/ops.html`);
        assert.equal(opsPage.status, 200);

        const roomsRes = await fetch(`${url}/api/ops/rooms?status=all`);
        assert.equal(roomsRes.status, 200);
        const payload = await roomsRes.json();

        assert.equal(payload.ok, true);
        assert.equal(payload.summary.totalRooms, 1);
        assert.equal(payload.summary.byMode.mafia, 1);
        assert.equal(payload.rooms.length, 1);
        assert.equal(payload.rooms[0].roomId, created.roomId);
        assert.equal(payload.rooms[0].players, 2);
        assert.equal(payload.rooms[0].launchReadiness.hostConnected, true);
        assert.equal(typeof payload.rooms[0].hotLobby, 'boolean');
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });
  } finally {
    setEnv('ENABLE_LOCAL_OPS', previousOps);
    setEnv('ENABLE_MANUAL_MAFIA_SOCKET', previousManual);
  }
});
