const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

const { server, mafiaRooms, amongUsRooms, villaRooms, roomEvents, clearAllGameTimers } = require('../server');

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function withServer(fn) {
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

test('socket flow: mafia full minimal round ends without deadlock', async () => {
  await withServer(async (url) => {
    const sockets = [ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true })];
    const byPlayerId = new Map();

    const c1 = await emitAck(sockets[0], 'mafia:room:create', { name: 'A' });
    byPlayerId.set(c1.playerId, sockets[0]);

    const j2 = await emitAck(sockets[1], 'mafia:room:join', { roomId: c1.roomId, name: 'B' });
    const j3 = await emitAck(sockets[2], 'mafia:room:join', { roomId: c1.roomId, name: 'C' });
    const j4 = await emitAck(sockets[3], 'mafia:room:join', { roomId: c1.roomId, name: 'D' });
    byPlayerId.set(j2.playerId, sockets[1]);
    byPlayerId.set(j3.playerId, sockets[2]);
    byPlayerId.set(j4.playerId, sockets[3]);

    const started = await emitAck(sockets[0], 'mafia:start', { roomId: c1.roomId, playerId: c1.playerId });
    assert.equal(started.ok, true);

    let room = mafiaRooms.get(c1.roomId);
    const mafia = room.players.find((p) => p.role === 'mafia');
    const target = room.players.find((p) => p.alive && p.id !== mafia.id);

    await emitAck(byPlayerId.get(mafia.id), 'mafia:action', {
      roomId: room.id,
      playerId: mafia.id,
      type: 'nightKill',
      targetId: target.id,
    });

    room = mafiaRooms.get(c1.roomId);
    const alive = room.players.filter((p) => p.alive);
    await Promise.all(alive.map((p) => emitAck(byPlayerId.get(p.id), 'mafia:action', {
      roomId: room.id,
      playerId: p.id,
      type: 'ready',
    })));

    room = mafiaRooms.get(c1.roomId);
    const aliveForVote = room.players.filter((p) => p.alive);
    const voteTarget = aliveForVote[0];
    await Promise.all(aliveForVote.map((p) => emitAck(byPlayerId.get(p.id), 'mafia:action', {
      roomId: room.id,
      playerId: p.id,
      type: 'vote',
      targetId: voteTarget.id,
    })));

    room = mafiaRooms.get(c1.roomId);
    assert.equal(room.status, 'finished');

    sockets.forEach((s) => s.disconnect());
  });
});

test('socket flow: among-us loop + timer collision guard', async () => {
  await withServer(async (url) => {
    const sockets = [ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true })];
    const byPlayerId = new Map();

    const c1 = await emitAck(sockets[0], 'amongus:room:create', { name: 'A' });
    byPlayerId.set(c1.playerId, sockets[0]);

    const j2 = await emitAck(sockets[1], 'amongus:room:join', { roomId: c1.roomId, name: 'B' });
    const j3 = await emitAck(sockets[2], 'amongus:room:join', { roomId: c1.roomId, name: 'C' });
    const j4 = await emitAck(sockets[3], 'amongus:room:join', { roomId: c1.roomId, name: 'D' });
    byPlayerId.set(j2.playerId, sockets[1]);
    byPlayerId.set(j3.playerId, sockets[2]);
    byPlayerId.set(j4.playerId, sockets[3]);

    const started = await emitAck(sockets[0], 'amongus:start', { roomId: c1.roomId, playerId: c1.playerId });
    assert.equal(started.ok, true);

    const room = amongUsRooms.get(c1.roomId);
    const crew = room.players.filter((p) => p.role === 'crew');

    await emitAck(byPlayerId.get(crew[0].id), 'amongus:action', { roomId: room.id, playerId: crew[0].id, type: 'task' });
    await emitAck(byPlayerId.get(crew[1].id), 'amongus:action', { roomId: room.id, playerId: crew[1].id, type: 'task' });
    await emitAck(byPlayerId.get(crew[2].id), 'amongus:action', { roomId: room.id, playerId: crew[2].id, type: 'task' });

    assert.equal(room.status, 'finished');
    assert.equal(room.phase, 'finished');

    await new Promise((r) => setTimeout(r, 8500));
    assert.equal(room.status, 'finished');
    assert.equal(room.phase, 'finished');

    sockets.forEach((s) => s.disconnect());
  });
});

test('socket flow: among-us kill -> meeting vote -> completion', async () => {
  await withServer(async (url) => {
    const sockets = [ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true })];
    const byPlayerId = new Map();

    const c1 = await emitAck(sockets[0], 'amongus:room:create', { name: 'A' });
    byPlayerId.set(c1.playerId, sockets[0]);

    const j2 = await emitAck(sockets[1], 'amongus:room:join', { roomId: c1.roomId, name: 'B' });
    const j3 = await emitAck(sockets[2], 'amongus:room:join', { roomId: c1.roomId, name: 'C' });
    const j4 = await emitAck(sockets[3], 'amongus:room:join', { roomId: c1.roomId, name: 'D' });
    byPlayerId.set(j2.playerId, sockets[1]);
    byPlayerId.set(j3.playerId, sockets[2]);
    byPlayerId.set(j4.playerId, sockets[3]);

    const started = await emitAck(sockets[0], 'amongus:start', { roomId: c1.roomId, playerId: c1.playerId });
    assert.equal(started.ok, true);

    const room = amongUsRooms.get(c1.roomId);
    const imposter = room.players.find((p) => p.role === 'imposter');
    const crewTarget = room.players.find((p) => p.role === 'crew' && p.alive);

    const kill = await emitAck(byPlayerId.get(imposter.id), 'amongus:action', {
      roomId: room.id,
      playerId: imposter.id,
      type: 'kill',
      targetId: crewTarget.id,
    });
    assert.equal(kill.ok, true);
    assert.equal(room.phase, 'meeting');

    const alive = room.players.filter((p) => p.alive);
    const voteTarget = alive.find((p) => p.role === 'crew') || imposter;
    await Promise.all(alive.map((p) => emitAck(byPlayerId.get(p.id), 'amongus:action', {
      roomId: room.id,
      playerId: p.id,
      type: 'vote',
      targetId: voteTarget.id,
    })));

    assert.equal(room.status, 'finished');
    assert.equal(room.phase, 'finished');
    assert.ok(['crew', 'imposter'].includes(room.winner));

    sockets.forEach((s) => s.disconnect());
  });
});

test('socket flow: villa full loop resolves to terminal state', async () => {
  await withServer(async (url) => {
    const sockets = [ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true }), ioc(url, { reconnection: false, autoUnref: true })];
    const byPlayerId = new Map();
    const phaseAction = {
      pairing: 'pair',
      challenge: 'challengeVote',
      twist: 'twistVote',
      recouple: 'recouple',
      elimination: 'eliminateVote',
    };

    const c1 = await emitAck(sockets[0], 'villa:room:create', { name: 'A' });
    byPlayerId.set(c1.playerId, sockets[0]);

    const j2 = await emitAck(sockets[1], 'villa:room:join', { roomId: c1.roomId, name: 'B' });
    const j3 = await emitAck(sockets[2], 'villa:room:join', { roomId: c1.roomId, name: 'C' });
    const j4 = await emitAck(sockets[3], 'villa:room:join', { roomId: c1.roomId, name: 'D' });
    byPlayerId.set(j2.playerId, sockets[1]);
    byPlayerId.set(j3.playerId, sockets[2]);
    byPlayerId.set(j4.playerId, sockets[3]);

    const started = await emitAck(sockets[0], 'villa:start', { roomId: c1.roomId, playerId: c1.playerId });
    assert.equal(started.ok, true);
    assert.equal(started.state.phase, 'pairing');

    let guard = 0;
    while (guard < 40) {
      guard += 1;
      const room = villaRooms.get(c1.roomId);
      if (!room || room.status === 'finished') break;

      const type = phaseAction[room.phase];
      assert.equal(typeof type, 'string');

      const immunity = room.roundState?.challenge?.immunityPlayerId || null;
      const alive = room.players.filter((p) => p.alive);
      await Promise.all(alive.map((player) => {
        const target = alive
          .filter((p) => p.id !== player.id && !(immunity && (room.phase === 'twist' || room.phase === 'elimination') && p.id === immunity))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
        return emitAck(byPlayerId.get(player.id), 'villa:action', {
          roomId: room.id,
          playerId: player.id,
          type,
          targetId: target?.id,
        });
      }));
    }

    const finished = villaRooms.get(c1.roomId);
    assert.ok(finished, 'villa room should exist');
    assert.equal(finished.status, 'finished');
    assert.equal(finished.phase, 'finished');
    assert.ok(['final_couple', 'viewer_favorite'].includes(finished.winner));

    sockets.forEach((s) => s.disconnect());
  });
});
