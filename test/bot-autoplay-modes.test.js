const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

const { server, mafiaRooms, amongUsRooms, roomEvents, clearAllGameTimers } = require('../server');

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 20000, intervalMs = 150) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function withServer(fn) {
  mafiaRooms.clear();
  amongUsRooms.clear();
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

test('mafia bot autopilot can finish bot-filled room loop with one human', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });

    const created = await emitAck(host, 'mafia:room:create', { name: 'SoloHost' });
    assert.equal(created.ok, true);

    const autofilled = await emitAck(host, 'mafia:autofill', {
      roomId: created.roomId,
      playerId: created.playerId,
      minPlayers: 4,
    });
    assert.equal(autofilled.ok, true);
    assert.equal(autofilled.state.players.length, 4);

    const started = await emitAck(host, 'mafia:start', { roomId: created.roomId, playerId: created.playerId });
    assert.equal(started.ok, true);

    const finished = await waitFor(() => {
      const room = mafiaRooms.get(created.roomId);
      return room && room.status === 'finished' ? room : null;
    });

    assert.ok(finished, 'mafia room should finish with bot autopilot');
    assert.ok(['mafia', 'town'].includes(finished.winner));

    host.disconnect();
  });
});

test('among-us bot autopilot can finish bot-filled room loop with one human', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });

    const created = await emitAck(host, 'amongus:room:create', { name: 'SoloHost' });
    assert.equal(created.ok, true);

    const autofilled = await emitAck(host, 'amongus:autofill', {
      roomId: created.roomId,
      playerId: created.playerId,
      minPlayers: 4,
    });
    assert.equal(autofilled.ok, true);
    assert.equal(autofilled.state.players.length, 4);

    const started = await emitAck(host, 'amongus:start', { roomId: created.roomId, playerId: created.playerId });
    assert.equal(started.ok, true);

    const finished = await waitFor(() => {
      const room = amongUsRooms.get(created.roomId);
      return room && room.status === 'finished' ? room : null;
    });

    assert.ok(finished, 'amongus room should finish with bot autopilot');
    assert.ok(['crew', 'imposter'].includes(finished.winner));

    host.disconnect();
  });
});
