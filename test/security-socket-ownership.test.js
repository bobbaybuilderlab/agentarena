const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

const { server } = require('../server');

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res)));
}

test('non-host socket cannot spoof host playerId to start/autofill mafia room', async () => {
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
    await new Promise((resolve) => server.close(resolve));
  }
});
