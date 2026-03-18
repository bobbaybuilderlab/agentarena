const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

process.env.ALLOW_INSECURE_DEV_SURFACES = '1';

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

test('health is minimal publicly and detailed metrics move behind ops auth', async () => {
  await withServer(async (url) => {
    const socket = ioc(url, { reconnection: false, autoUnref: true });
    const created = await emitAck(socket, 'mafia:room:create', { name: 'Host' });
    await emitAck(socket, 'mafia:autofill', { roomId: created.roomId, playerId: created.playerId, minPlayers: 4 });
    await emitAck(socket, 'mafia:start', { roomId: created.roomId, playerId: created.playerId });

    const healthRes = await fetch(`${url}/health`, { headers: { 'x-correlation-id': 'test-cid-123' } });
    const health = await healthRes.json();

    assert.equal(health.ok, true);
    assert.equal(healthRes.headers.get('x-correlation-id'), 'test-cid-123');
    assert.equal(health.launchMode, 'mafia');
    assert.equal(health.durableStorageRequired, false);
    assert.equal(typeof health.durableStorageHealthy, 'boolean');
    assert.equal('eventQueueDepth' in health, false);
    assert.equal('eventQueueByMode' in health, false);
    assert.equal('schedulerTimers' in health, false);
    assert.equal('publicArena' in health, false);
    assert.equal('roomEvents' in health, false);
    assert.equal('maintenance' in health, false);

    const opsHealthRes = await fetch(`${url}/api/ops/health`);
    const opsHealth = await opsHealthRes.json();
    assert.equal(opsHealth.ok, true);
    assert.equal(typeof opsHealth.eventQueueDepth, 'number');
    assert.equal(typeof opsHealth.eventQueueByMode, 'object');
    assert.equal(typeof opsHealth.schedulerTimers.total, 'number');
    assert.equal(typeof opsHealth.schedulerTimers.byNamespace, 'object');
    assert.equal(typeof opsHealth.publicArena.connectedAgents, 'number');
    assert.equal(typeof opsHealth.publicArena.idleAgents, 'number');
    assert.equal(typeof opsHealth.publicArena.reservedAgents, 'number');
    assert.equal(typeof opsHealth.publicArena.inMatchAgents, 'number');
    assert.equal(typeof opsHealth.publicArena.activeMatches, 'number');
    assert.equal(typeof opsHealth.publicArena.queueRunning, 'boolean');
    assert.equal(typeof opsHealth.roomEvents.publicReplayEnabled, 'boolean');
    assert.equal(typeof opsHealth.roomEvents.filePersistenceEnabled, 'boolean');
    assert.equal(typeof opsHealth.roomEvents.growthMetricsSnapshotStorage, 'string');
    assert.equal(typeof opsHealth.maintenance.cleanup.deleted.sessions, 'number');

    const opsRes = await fetch(`${url}/api/ops/events`);
    const ops = await opsRes.json();
    assert.equal(ops.ok, true);
    assert.equal(typeof ops.pending, 'number');
    assert.equal(typeof ops.pendingByMode, 'object');

    socket.disconnect();
  });
});
