const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

const { server, mafiaRooms, amongUsRooms, villaRooms, clearAllGameTimers } = require('../server');

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res)));
}

test('non-host socket cannot spoof host playerId to start/autofill mafia room', async () => {
  mafiaRooms.clear();
  amongUsRooms.clear();
  villaRooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const host = ioClient(base, { transports: ['websocket'] });
  const attacker = ioClient(base, { transports: ['websocket'] });

  try {
    await Promise.all([
      new Promise((resolve) => host.on('connect', resolve)),
      new Promise((resolve) => attacker.on('connect', resolve)),
    ]);

    const created = await emit(host, 'mafia:room:create', { name: 'Host' });
    assert.equal(created.ok, true);

    const roomId = created.roomId;
    const hostPlayerId = created.playerId;

    const joined = await emit(attacker, 'mafia:room:join', { roomId, name: 'Attacker' });
    assert.equal(joined.ok, true);

    const spoofAutofill = await emit(attacker, 'mafia:autofill', {
      roomId,
      playerId: hostPlayerId,
      minPlayers: 6,
    });
    assert.equal(spoofAutofill.ok, false);
    assert.equal(spoofAutofill.error.code, 'HOST_ONLY');

    const spoofStart = await emit(attacker, 'mafia:start', {
      roomId,
      playerId: hostPlayerId,
    });
    assert.equal(spoofStart.ok, false);
    assert.equal(spoofStart.error.code, 'HOST_ONLY');
  } finally {
    host.close();
    attacker.close();
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('single socket cannot claim multiple human seats in mafia/amongus/villa lobbies', async () => {
  mafiaRooms.clear();
  amongUsRooms.clear();
  villaRooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const socket = ioClient(base, { transports: ['websocket'] });

  try {
    await new Promise((resolve) => socket.on('connect', resolve));

    const mafiaCreated = await emit(socket, 'mafia:room:create', { name: 'MHost' });
    assert.equal(mafiaCreated.ok, true);
    const mafiaSecondSeat = await emit(socket, 'mafia:room:join', { roomId: mafiaCreated.roomId, name: 'MAttacker' });
    assert.equal(mafiaSecondSeat.ok, false);
    assert.equal(mafiaSecondSeat.error.code, 'SOCKET_ALREADY_JOINED');

    const amongCreated = await emit(socket, 'amongus:room:create', { name: 'AHost' });
    assert.equal(amongCreated.ok, true);
    const amongSecondSeat = await emit(socket, 'amongus:room:join', { roomId: amongCreated.roomId, name: 'AAttacker' });
    assert.equal(amongSecondSeat.ok, false);
    assert.equal(amongSecondSeat.error.code, 'SOCKET_ALREADY_JOINED');

    const villaCreated = await emit(socket, 'villa:room:create', { name: 'VHost' });
    assert.equal(villaCreated.ok, true);
    const villaSecondSeat = await emit(socket, 'villa:room:join', { roomId: villaCreated.roomId, name: 'VAttacker' });
    assert.equal(villaSecondSeat.ok, false);
    assert.equal(villaSecondSeat.error.code, 'SOCKET_ALREADY_JOINED');

    const opsRes = await fetch(`${base}/api/ops/reconnect`);
    const ops = await opsRes.json();
    assert.equal(ops.ok, true);
    assert.equal(ops.totals.socket_seat_cap_blocked, 3);
    assert.equal(ops.byMode.mafia.socket_seat_cap_blocked, 1);
    assert.equal(ops.byMode.amongus.socket_seat_cap_blocked, 1);
    assert.equal(ops.byMode.villa.socket_seat_cap_blocked, 1);
  } finally {
    socket.close();
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});
