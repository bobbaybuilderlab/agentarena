const test = require('node:test');
const assert = require('node:assert/strict');

const villa = require('../games/agent-villa');

function pickTarget(room, actorId) {
  const immunity = room.roundState?.challenge?.immunityPlayerId || null;
  return room.players
    .filter((p) => p.alive && p.id !== actorId && !(immunity && (room.phase === 'twist' || room.phase === 'elimination') && p.id === immunity))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
}

test('agent-villa room create/join/start loop is playable', () => {
  const store = villa.createStore();
  const created = villa.createRoom(store, { hostName: 'Host', hostSocketId: 's-host' });
  assert.equal(created.ok, true);

  const roomId = created.room.id;
  const hostPlayerId = created.player.id;

  villa.joinRoom(store, { roomId, name: 'P2', socketId: 's2' });
  villa.joinRoom(store, { roomId, name: 'P3', socketId: 's3' });
  villa.joinRoom(store, { roomId, name: 'P4', socketId: 's4' });

  const started = villa.startGame(store, { roomId, hostPlayerId });
  assert.equal(started.ok, true);
  assert.equal(started.room.status, 'in_progress');
  assert.equal(started.room.phase, 'pairing');
  assert.equal(started.room.round, 1);

  const actionByPhase = {
    pairing: 'pair',
    challenge: 'challengeVote',
    twist: 'twistVote',
    recouple: 'recouple',
    elimination: 'eliminateVote',
  };

  let room = store.get(roomId);
  let guard = 0;
  while (room && room.status !== 'finished' && guard < 60) {
    guard += 1;
    const type = actionByPhase[room.phase];
    const alive = room.players.filter((p) => p.alive);

    for (const player of alive) {
      const target = pickTarget(room, player.id);
      const result = villa.submitAction(store, {
        roomId,
        playerId: player.id,
        type,
        targetId: target?.id,
      });
      assert.equal(result.ok, true);
      room = result.room;
      if (room.status === 'finished') break;
      if (room.phase !== Object.keys(actionByPhase).find((phase) => actionByPhase[phase] === type)) break;
    }
    room = store.get(roomId);
  }

  assert.ok(room, 'room should still exist');
  assert.equal(room.status, 'finished');
  assert.equal(room.phase, 'finished');
  assert.ok(['final_couple', 'viewer_favorite'].includes(room.winner));
});

test('agent-villa transitionRoomState rejects lobby -> twist', () => {
  const store = villa.createStore();
  const created = villa.createRoom(store, { hostName: 'Host' });
  const bad = villa.transitionRoomState(created.room, 'twist');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_PHASE_TRANSITION');
  assert.deepEqual(bad.error.details, { fromPhase: 'lobby', toPhase: 'twist' });
});

test('agent-villa enforces one connected seat per socket in lobby', () => {
  const store = villa.createStore();
  const created = villa.createRoom(store, { hostName: 'Host', hostSocketId: 'same-socket' });
  assert.equal(created.ok, true);

  const denied = villa.joinRoom(store, {
    roomId: created.room.id,
    name: 'AltSeat',
    socketId: 'same-socket',
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'SOCKET_ALREADY_JOINED');
});
