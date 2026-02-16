const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

const { server, mafiaRooms, amongUsRooms, roomEvents, clearAllGameTimers } = require('../server');

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
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

test('play rooms API lists cross-mode room discovery with open-room filtering', async () => {
  await withServer(async (url) => {
    const s1 = ioc(url, { reconnection: false, autoUnref: true });
    const s2 = ioc(url, { reconnection: false, autoUnref: true });

    const mafiaCreate = await emitAck(s1, 'mafia:room:create', { name: 'MHost' });
    assert.equal(mafiaCreate.ok, true);

    const amongCreate = await emitAck(s2, 'amongus:room:create', { name: 'AHost' });
    assert.equal(amongCreate.ok, true);

    const allRes = await fetch(`${url}/api/play/rooms`);
    const allData = await allRes.json();

    assert.equal(allData.ok, true);
    assert.equal(allData.summary.totalRooms, 2);
    assert.equal(allData.summary.openRooms, 2);

    const modes = allData.rooms.map((r) => r.mode).sort();
    assert.deepEqual(modes, ['amongus', 'mafia']);

    const mafiaItem = allData.rooms.find((r) => r.mode === 'mafia');
    assert.equal(mafiaItem.roomId, mafiaCreate.roomId);
    assert.equal(mafiaItem.canJoin, true);

    const s3 = ioc(url, { reconnection: false, autoUnref: true });
    const s4 = ioc(url, { reconnection: false, autoUnref: true });
    const s5 = ioc(url, { reconnection: false, autoUnref: true });

    await emitAck(s3, 'mafia:room:join', { roomId: mafiaCreate.roomId, name: 'M2' });
    await emitAck(s4, 'mafia:room:join', { roomId: mafiaCreate.roomId, name: 'M3' });
    await emitAck(s5, 'mafia:room:join', { roomId: mafiaCreate.roomId, name: 'M4' });

    const startRes = await emitAck(s1, 'mafia:start', { roomId: mafiaCreate.roomId, playerId: mafiaCreate.playerId });
    assert.equal(startRes.ok, true);

    const openRes = await fetch(`${url}/api/play/rooms?status=open`);
    const openData = await openRes.json();
    assert.equal(openData.ok, true);
    assert.equal(openData.summary.openRooms, 1);
    assert.equal(openData.rooms.length, 1);
    assert.equal(openData.rooms[0].mode, 'amongus');
    assert.ok(openData.rooms.every((r) => r.status === 'lobby'));

    s1.disconnect();
    s2.disconnect();
    s3.disconnect();
    s4.disconnect();
    s5.disconnect();
  });
});

test('quick-join API picks fullest open room or creates one with join ticket', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const p2 = ioc(url, { reconnection: false, autoUnref: true });

    const created = await emitAck(host, 'mafia:room:create', { name: 'HostM' });
    assert.equal(created.ok, true);
    await emitAck(p2, 'mafia:room:join', { roomId: created.roomId, name: 'M2' });

    const quickJoinRes = await fetch(`${url}/api/play/quick-join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'mafia', name: 'QueueRunner' }),
    });
    const quickJoinData = await quickJoinRes.json();

    assert.equal(quickJoinData.ok, true);
    assert.equal(quickJoinData.created, false);
    assert.equal(quickJoinData.room.roomId, created.roomId);
    assert.match(quickJoinData.joinTicket.joinUrl, new RegExp(`room=${created.roomId}`));
    assert.match(quickJoinData.joinTicket.joinUrl, /name=QueueRunner/);

    host.disconnect();
    p2.disconnect();
  });

  await withServer(async (url) => {
    const res = await fetch(`${url}/api/play/quick-join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'amongus', name: 'FreshPlayer' }),
    });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.created, true);
    assert.equal(data.room.mode, 'amongus');
    assert.equal(data.room.players, 4);
    assert.equal(data.room.hostName, 'FreshPlayer');
    assert.match(data.joinTicket.joinUrl, /game=amongus/);
  });
});

test('host can autofill lobby bots to start immediately; non-host cannot', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const guest = ioc(url, { reconnection: false, autoUnref: true });

    const created = await emitAck(host, 'mafia:room:create', { name: 'HostM' });
    assert.equal(created.ok, true);

    const guestJoin = await emitAck(guest, 'mafia:room:join', { roomId: created.roomId, name: 'Guest' });
    assert.equal(guestJoin.ok, true);

    const denied = await emitAck(guest, 'mafia:autofill', { roomId: created.roomId, playerId: guestJoin.playerId, minPlayers: 4 });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'HOST_ONLY');

    const filled = await emitAck(host, 'mafia:autofill', { roomId: created.roomId, playerId: created.playerId, minPlayers: 4 });
    assert.equal(filled.ok, true);
    assert.equal(filled.addedBots, 2);
    assert.equal(filled.state.players.length, 4);
    assert.equal(filled.state.players.filter((p) => p.isBot).length, 2);

    const started = await emitAck(host, 'mafia:start', { roomId: created.roomId, playerId: created.playerId });
    assert.equal(started.ok, true);

    host.disconnect();
    guest.disconnect();
  });
});
