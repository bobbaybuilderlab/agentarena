const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

process.env.ENABLE_LOCAL_OPS = '1';
process.env.ENABLE_MANUAL_MAFIA_SOCKET = '1';

const { server, mafiaRooms, roomEvents, clearAllGameTimers } = require('../server');

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function withServer(fn) {
  mafiaRooms.clear();
  roomEvents.clear();
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

test('public health stays minimal while ops health exposes scheduler + queue metrics', async () => {
  await withServer(async (url) => {
    const socket = ioc(url, { reconnection: false, autoUnref: true });
    const created = await emitAck(socket, 'mafia:room:create', { name: 'Host' });
    await emitAck(socket, 'mafia:autofill', { roomId: created.roomId, playerId: created.playerId, minPlayers: 4 });
    await emitAck(socket, 'mafia:start', { roomId: created.roomId, playerId: created.playerId });

    const healthRes = await fetch(`${url}/health`, { headers: { 'x-correlation-id': 'test-cid-123' } });
    const health = await healthRes.json();

    assert.equal(health.ok, true);
    assert.equal(healthRes.headers.get('x-correlation-id'), 'test-cid-123');
    assert.equal(health.status, 'healthy');
    assert.equal(typeof health.timestamp, 'string');
    assert.equal(typeof health.uptimeSec, 'number');
    assert.equal('launchMode' in health, false);
    assert.equal('eventQueueDepth' in health, false);
    assert.equal('schedulerTimers' in health, false);

    const opsHealthRes = await fetch(`${url}/api/ops/health`);
    const opsHealth = await opsHealthRes.json();
    assert.equal(opsHealth.ok, true);
    assert.equal(typeof opsHealth.launchMode, 'string');
    assert.equal(typeof opsHealth.rooms?.mafia, 'number');
    assert.equal(typeof opsHealth.agents, 'number');
    assert.equal(typeof opsHealth.eventQueueDepth, 'number');
    assert.equal(typeof opsHealth.eventQueueByMode, 'object');
    assert.equal(typeof opsHealth.schedulerTimers?.total, 'number');
    assert.equal(typeof opsHealth.schedulerTimers?.byNamespace, 'object');

    const opsRes = await fetch(`${url}/api/ops/events`);
    const ops = await opsRes.json();
    assert.equal(ops.ok, true);
    assert.equal(typeof ops.pending, 'number');
    assert.equal(typeof ops.pendingByMode, 'object');

    socket.disconnect();
  });
});
