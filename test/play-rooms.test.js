const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

const {
  server,
  mafiaRooms,
  roomEvents,
  clearAllGameTimers,
  resetPlayTelemetry,
  seedPlayTelemetry,
} = require('../server');

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

test('play rooms API lists mafia rooms and open-room filtering', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const guestA = ioc(url, { reconnection: false, autoUnref: true });
    const guestB = ioc(url, { reconnection: false, autoUnref: true });
    const guestC = ioc(url, { reconnection: false, autoUnref: true });

    try {
      const created = await emitAck(host, 'mafia:room:create', { name: 'Host' });
      assert.equal(created.ok, true);

      let roomsRes = await fetch(`${url}/api/play/rooms`);
      let roomsData = await roomsRes.json();
      assert.equal(roomsData.ok, true);
      assert.equal(roomsData.summary.totalRooms, 1);
      assert.equal(roomsData.summary.byMode.mafia, 1);
      assert.equal(roomsData.summary.openRooms, 1);
      assert.equal(roomsData.rooms[0].mode, 'mafia');
      assert.equal(roomsData.rooms[0].canJoin, true);
      assert.equal(roomsData.rooms[0].hostPlayerId, null);
      assert.equal('disconnectedHumans' in (roomsData.rooms[0].launchReadiness || {}), false);

      await emitAck(guestA, 'mafia:room:join', { roomId: created.roomId, name: 'GuestA' });
      await emitAck(guestB, 'mafia:room:join', { roomId: created.roomId, name: 'GuestB' });
      await emitAck(guestC, 'mafia:room:join', { roomId: created.roomId, name: 'GuestC' });

      const started = await emitAck(host, 'mafia:start-ready', { roomId: created.roomId, playerId: created.playerId });
      assert.equal(started.ok, true);
      assert.equal(started.state.status, 'in_progress');
      assert.equal(started.state.players.length, 6);
      assert.equal(started.addedBots, 2);

      roomsRes = await fetch(`${url}/api/play/rooms?status=open`);
      roomsData = await roomsRes.json();
      assert.equal(roomsData.ok, true);
      assert.equal(roomsData.summary.openRooms, 0);
      assert.equal(roomsData.rooms.length, 0);
    } finally {
      host.disconnect();
      guestA.disconnect();
      guestB.disconnect();
      guestC.disconnect();
    }
  });
});

test('quick-join picks the highest-quality mafia lobby and returns a join ticket', async () => {
  await withServer(async (url) => {
    const hostA = ioc(url, { reconnection: false, autoUnref: true });
    const hostB = ioc(url, { reconnection: false, autoUnref: true });
    const guest = ioc(url, { reconnection: false, autoUnref: true });

    try {
      const baseRoom = await emitAck(hostA, 'mafia:room:create', { name: 'BaseHost' });
      const hotRoom = await emitAck(hostB, 'mafia:room:create', { name: 'HotHost' });
      assert.equal(baseRoom.ok, true);
      assert.equal(hotRoom.ok, true);

      await emitAck(guest, 'mafia:room:join', { roomId: hotRoom.roomId, name: 'HotGuest' });
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
      assert.equal(typeof quickJoinData.quickJoinDecision?.code, 'string');
      assert.match(quickJoinData.joinTicket.joinUrl, new RegExp(`room=${hotRoom.roomId}`));
      assert.match(quickJoinData.joinTicket.joinUrl, /game=mafia/);
      assert.doesNotMatch(quickJoinData.joinTicket.joinUrl, /claimToken|reclaimName|reclaimHost/);
    } finally {
      hostA.disconnect();
      hostB.disconnect();
      guest.disconnect();
    }
  });
});

test('public lobby recovery routes are unavailable and disconnected identities are not exposed', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const guest = ioc(url, { reconnection: false, autoUnref: true });

    try {
      const created = await emitAck(host, 'mafia:room:create', { name: 'Host' });
      const joined = await emitAck(guest, 'mafia:room:join', { roomId: created.roomId, name: 'Guest' });
      assert.equal(created.ok, true);
      assert.equal(joined.ok, true);

      guest.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 25));

      const roomsRes = await fetch(`${url}/api/play/rooms`);
      const roomsData = await roomsRes.json();
      assert.equal(roomsData.ok, true);
      assert.equal(roomsData.rooms[0].hostPlayerId, null);
      assert.equal(roomsData.rooms[0].launchReadiness.disconnectedCount, 1);
      assert.equal('disconnectedHumans' in (roomsData.rooms[0].launchReadiness || {}), false);

      const claimsRes = await fetch(`${url}/api/play/lobby/claims?mode=mafia&roomId=${encodeURIComponent(created.roomId)}`);
      assert.equal(claimsRes.status, 404);

      const telemetryRes = await fetch(`${url}/api/play/reconnect-telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'mafia', roomId: created.roomId, outcome: 'attempt', event: 'reclaim_clicked' }),
      });
      assert.equal(telemetryRes.status, 404);
    } finally {
      host.disconnect();
    }
  });
});

test('disconnected player names cannot be reclaimed and public lobby autofill is unavailable', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const guest = ioc(url, { reconnection: false, autoUnref: true });
    const attacker = ioc(url, { reconnection: false, autoUnref: true });

    try {
      const created = await emitAck(host, 'mafia:room:create', { name: 'Host' });
      const joined = await emitAck(guest, 'mafia:room:join', { roomId: created.roomId, name: 'Guest' });
      assert.equal(created.ok, true);
      assert.equal(joined.ok, true);

      const invalidModeRes = await fetch(`${url}/api/play/lobby/autofill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'amongus', roomId: created.roomId, minPlayers: 4 }),
      });
      assert.equal(invalidModeRes.status, 404);

      guest.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 25));

      const reclaimAttempt = await emitAck(attacker, 'mafia:room:join', { roomId: created.roomId, name: 'Guest' });
      assert.equal(reclaimAttempt.ok, false);
      assert.equal(reclaimAttempt.error?.code, 'NAME_RESERVED');

      const startReady = await emitAck(host, 'mafia:start-ready', { roomId: created.roomId, playerId: created.playerId });
      assert.equal(startReady.ok, true);
      assert.equal(startReady.removedDisconnectedHumans, 1);
      assert.equal(startReady.addedBots, 5);
      assert.ok(['in_progress', 'finished'].includes(startReady.state.status));
      assert.equal(startReady.state.players.length, 6);
    } finally {
      host.disconnect();
      attacker.disconnect();
    }
  });
});
