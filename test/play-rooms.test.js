const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

const { server, mafiaRooms, amongUsRooms, roomEvents, clearAllGameTimers, resetPlayTelemetry, seedPlayTelemetry } = require('../server');

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function withServer(fn) {
  mafiaRooms.clear();
  amongUsRooms.clear();
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

test('quick-join API picks highest-fit open room or creates one with join ticket', async () => {
  await withServer(async (url) => {
    const hostA = ioc(url, { reconnection: false, autoUnref: true });
    const hostB = ioc(url, { reconnection: false, autoUnref: true });
    const p2 = ioc(url, { reconnection: false, autoUnref: true });
    const p3 = ioc(url, { reconnection: false, autoUnref: true });

    try {
      const baseRoom = await emitAck(hostA, 'mafia:room:create', { name: 'HostA' });
      const hotRoom = await emitAck(hostB, 'mafia:room:create', { name: 'HostB' });
      assert.equal(baseRoom.ok, true);
      assert.equal(hotRoom.ok, true);

      await emitAck(p2, 'mafia:room:join', { roomId: baseRoom.roomId, name: 'M2' });
      await emitAck(p3, 'mafia:room:join', { roomId: hotRoom.roomId, name: 'M3' });

      seedPlayTelemetry('mafia', hotRoom.roomId, {
        rematchCount: 2,
        quickMatchTickets: 10,
        quickMatchConversions: 9,
      });

      const quickJoinRes = await fetch(`${url}/api/play/quick-join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'mafia', name: 'QueueRunner' }),
      });
      const quickJoinData = await quickJoinRes.json();

      assert.equal(quickJoinData.ok, true);
      assert.equal(quickJoinData.created, false);
      assert.equal(quickJoinData.room.roomId, hotRoom.roomId);
      assert.ok((quickJoinData.room.matchQuality?.score || 0) > 0.5);
      assert.match(quickJoinData.joinTicket.joinUrl, new RegExp(`room=${hotRoom.roomId}`));
      assert.match(quickJoinData.joinTicket.joinUrl, /name=QueueRunner/);

      const roomsRes = await fetch(`${url}/api/play/rooms?mode=mafia`);
      const roomsData = await roomsRes.json();
      const room = roomsData.rooms.find((r) => r.roomId === hotRoom.roomId);
      assert.equal(room.quickMatch.tickets, 11);
      assert.equal(room.quickMatch.conversions, 9);
      assert.ok(room.matchQuality.score > 0.6);
    } finally {
      hostA.disconnect();
      hostB.disconnect();
      p2.disconnect();
      p3.disconnect();
    }
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

test('rooms API surfaces recent winners telemetry for finished rooms', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const created = await emitAck(host, 'mafia:room:create', { name: 'HostM' });
    assert.equal(created.ok, true);

    const room = mafiaRooms.get(created.roomId);
    room.status = 'finished';
    room.phase = 'finished';
    room.winner = 'town';

    const res = await fetch(`${url}/api/play/rooms?mode=mafia`);
    const data = await res.json();
    const card = data.rooms.find((r) => r.roomId === created.roomId);
    assert.equal(card.recentWinners.length, 1);
    assert.equal(card.recentWinners[0].winner, 'town');

    host.disconnect();
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

test('finished rooms support one-click rematch for host in both modes', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const guest = ioc(url, { reconnection: false, autoUnref: true });

    const mafiaCreated = await emitAck(host, 'mafia:room:create', { name: 'HostM' });
    const mafiaGuest = await emitAck(guest, 'mafia:room:join', { roomId: mafiaCreated.roomId, name: 'Guest' });
    await emitAck(host, 'mafia:autofill', { roomId: mafiaCreated.roomId, playerId: mafiaCreated.playerId, minPlayers: 4 });
    await emitAck(host, 'mafia:start', { roomId: mafiaCreated.roomId, playerId: mafiaCreated.playerId });

    const mafiaRoom = mafiaRooms.get(mafiaCreated.roomId);
    mafiaRoom.status = 'finished';
    mafiaRoom.phase = 'finished';

    const mafiaDenied = await emitAck(guest, 'mafia:rematch', { roomId: mafiaCreated.roomId, playerId: mafiaGuest.playerId });
    assert.equal(mafiaDenied.ok, false);
    assert.equal(mafiaDenied.error.code, 'HOST_ONLY');

    const mafiaRematch = await emitAck(host, 'mafia:rematch', { roomId: mafiaCreated.roomId, playerId: mafiaCreated.playerId });
    assert.equal(mafiaRematch.ok, true);
    assert.equal(mafiaRematch.state.status, 'in_progress');
    assert.ok(['night', 'discussion', 'voting'].includes(mafiaRematch.state.phase));
    assert.equal(mafiaRematch.state.players.length, 4);

    const mafiaAfterRematch = await fetch(`${url}/api/play/rooms?mode=mafia`);
    const mafiaAfterRematchData = await mafiaAfterRematch.json();
    const mafiaCard = mafiaAfterRematchData.rooms.find((r) => r.roomId === mafiaCreated.roomId);
    assert.equal(mafiaCard.rematchCount, 1);

    const amongHost = ioc(url, { reconnection: false, autoUnref: true });
    const amongGuest = ioc(url, { reconnection: false, autoUnref: true });

    const amongCreated = await emitAck(amongHost, 'amongus:room:create', { name: 'HostA' });
    await emitAck(amongGuest, 'amongus:room:join', { roomId: amongCreated.roomId, name: 'GuestA' });
    await emitAck(amongHost, 'amongus:autofill', { roomId: amongCreated.roomId, playerId: amongCreated.playerId, minPlayers: 4 });
    await emitAck(amongHost, 'amongus:start', { roomId: amongCreated.roomId, playerId: amongCreated.playerId });

    const amongRoom = amongUsRooms.get(amongCreated.roomId);
    amongRoom.status = 'finished';
    amongRoom.phase = 'finished';

    const amongRematch = await emitAck(amongHost, 'amongus:rematch', { roomId: amongCreated.roomId, playerId: amongCreated.playerId });
    assert.equal(amongRematch.ok, true);
    assert.equal(amongRematch.state.status, 'in_progress');
    assert.ok(['tasks', 'meeting'].includes(amongRematch.state.phase));
    assert.equal(amongRematch.state.players.length, 4);

    host.disconnect();
    guest.disconnect();
    amongHost.disconnect();
    amongGuest.disconnect();
  });
});
