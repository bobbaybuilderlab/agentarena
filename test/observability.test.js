const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

const { server, rooms, mafiaRooms, amongUsRooms, villaRooms, roomEvents, clearAllGameTimers } = require('../server');

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function withServer(fn) {
  rooms.clear();
  mafiaRooms.clear();
  amongUsRooms.clear();
  villaRooms.clear();
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

test('health exposes scheduler + queue metrics and correlation id header', async () => {
  await withServer(async (url) => {
    const socket = ioc(url, { reconnection: false, autoUnref: true });
    const created = await emitAck(socket, 'amongus:room:create', { name: 'Host' });
    await emitAck(socket, 'amongus:start', { roomId: created.roomId, playerId: created.playerId });

    const healthRes = await fetch(`${url}/health`, { headers: { 'x-correlation-id': 'test-cid-123' } });
    const health = await healthRes.json();

    assert.equal(health.ok, true);
    assert.equal(healthRes.headers.get('x-correlation-id'), 'test-cid-123');
    assert.equal(typeof health.eventQueueDepth, 'number');
    assert.equal(typeof health.eventQueueByMode, 'object');
    assert.equal(typeof health.schedulerTimers.total, 'number');
    assert.equal(typeof health.schedulerTimers.byNamespace, 'object');

    const opsRes = await fetch(`${url}/api/ops/events`);
    const ops = await opsRes.json();
    assert.equal(ops.ok, true);
    assert.equal(typeof ops.pending, 'number');
    assert.equal(typeof ops.pendingByMode, 'object');

    const canaryRes = await fetch(`${url}/api/ops/canary`);
    const canary = await canaryRes.json();
    assert.equal(canary.ok, true);
    assert.equal(typeof canary.config.enabled, 'boolean');
    assert.equal(typeof canary.config.percent, 'number');
    assert.equal(typeof canary.stats.control.decisions, 'number');
    assert.equal(typeof canary.stats.canary.decisions, 'number');

    assert.equal(typeof health.canary.enabled, 'boolean');
    assert.equal(typeof health.canary.percent, 'number');
    assert.equal(typeof health.canary.stats.control.decisions, 'number');

    socket.disconnect();
  });
});
