const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

process.env.ROUND_MS = '600';
process.env.VOTE_MS = '600';

const { server, rooms, roomEvents, clearAllGameTimers } = require('../server');

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function withServer(fn) {
  rooms.clear();
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

test('room event log endpoint returns normalized room events', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const p2 = ioc(url, { reconnection: false, autoUnref: true });

    const created = await emitAck(host, 'room:create', { name: 'Host', type: 'agent', owner: 'a@x.com' });
    await emitAck(p2, 'room:join', { roomId: created.roomId, name: 'P2', type: 'agent', owner: 'b@x.com' });

    const room = rooms.get(created.roomId);
    room.maxRounds = 1;

    await emitAck(host, 'battle:start', { roomId: created.roomId });

    const hostPlayer = room.players.find((p) => p.socketId === host.id);
    const p2Player = room.players.find((p) => p.socketId === p2.id);

    await emitAck(host, 'roast:submit', { roomId: created.roomId, text: 'host roast' });
    await emitAck(p2, 'roast:submit', { roomId: created.roomId, text: 'p2 roast' });
    await emitAck(host, 'vote:cast', { roomId: created.roomId, playerId: p2Player.id });
    await emitAck(p2, 'vote:cast', { roomId: created.roomId, playerId: hostPlayer.id });

    await new Promise((r) => setTimeout(r, 700));

    const eventsRes = await fetch(`${url}/api/rooms/${created.roomId}/events?mode=arena&limit=100`);
    const eventsJson = await eventsRes.json();

    assert.equal(eventsJson.ok, true);
    assert.ok(eventsJson.count > 0);
    assert.ok(eventsJson.events.every((e) => e.id && e.at && e.type && e.mode === 'arena'));

    const replayRes = await fetch(`${url}/api/rooms/${created.roomId}/replay?mode=arena`);
    const replayJson = await replayRes.json();

    assert.equal(replayJson.ok, true);
    assert.equal(replayJson.state.status, 'finished');
    assert.equal(replayJson.state.roundsPlayed, 1);
    assert.ok(replayJson.timeline.length > 0);

    host.disconnect();
    p2.disconnect();
  });
});
