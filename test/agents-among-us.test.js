const test = require('node:test');
const assert = require('node:assert/strict');

const amongUs = require('../games/agents-among-us');

function setupStartedGame() {
  const store = amongUs.createStore();
  const created = amongUs.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  amongUs.joinRoom(store, { roomId: created.room.id, name: 'P2' });
  amongUs.joinRoom(store, { roomId: created.room.id, name: 'P3' });
  amongUs.joinRoom(store, { roomId: created.room.id, name: 'P4' });
  const started = amongUs.startGame(store, { roomId: created.room.id, hostPlayerId: created.player.id });
  assert.equal(started.ok, true);
  return { store, room: started.room };
}

test('agents-among-us create/join/start minimal crew-task win', () => {
  const { store, room } = setupStartedGame();
  assert.equal(room.phase, 'tasks');

  const crew = room.players.filter((p) => p.role === 'crew');
  crew.forEach((c) => {
    const action = amongUs.submitAction(store, { roomId: room.id, playerId: c.id, type: 'task' });
    assert.equal(action.ok, true);
  });

  assert.equal(room.status, 'finished');
  assert.equal(room.winner, 'crew');
});

test('agents-among-us meeting resolves back to tasks when no winner yet', () => {
  const { store, room } = setupStartedGame();

  const aliveBefore = room.players.filter((p) => p.alive);
  const meetingCaller = aliveBefore[0];
  const called = amongUs.submitAction(store, { roomId: room.id, playerId: meetingCaller.id, type: 'callMeeting' });
  assert.equal(called.ok, true);

  const inMeeting = room.players.filter((p) => p.alive);
  const voteTarget = inMeeting.find((p) => p.role === 'crew');
  const altTarget = inMeeting.find((p) => p.id !== voteTarget.id);
  inMeeting.forEach((p) => {
    // Self-vote is blocked, so voteTarget votes for someone else
    const target = p.id === voteTarget.id ? altTarget.id : voteTarget.id;
    const vote = amongUs.submitAction(store, { roomId: room.id, playerId: p.id, type: 'vote', targetId: target });
    assert.equal(vote.ok, true);
  });

  assert.equal(room.status, 'in_progress');
  assert.equal(room.phase, 'tasks');
});

test('agents-among-us transitionRoomState rejects lobby -> meeting', () => {
  const store = amongUs.createStore();
  const created = amongUs.createRoom(store, { hostName: 'Host' });
  const bad = amongUs.transitionRoomState(created.room, 'meeting');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_PHASE_TRANSITION');
  assert.deepEqual(bad.error.details, { fromPhase: 'lobby', toPhase: 'meeting' });
});

test('agents-among-us disconnectPlayer returns whether state changed', () => {
  const store = amongUs.createStore();
  const created = amongUs.createRoom(store, { hostName: 'Host', hostSocketId: 'host-socket' });

  assert.equal(amongUs.disconnectPlayer(store, { roomId: created.room.id, socketId: 'missing' }), false);
  assert.equal(amongUs.disconnectPlayer(store, { roomId: created.room.id, socketId: 'host-socket' }), true);
  assert.equal(amongUs.disconnectPlayer(store, { roomId: created.room.id, socketId: 'host-socket' }), false);
});

test('agents-among-us enforces lobby capacity and avoids duplicate name identities', () => {
  const store = amongUs.createStore();
  const created = amongUs.createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  const roomId = created.room.id;

  assert.equal(amongUs.joinRoom(store, { roomId, name: 'P2', socketId: 's2' }).ok, true);
  assert.equal(amongUs.joinRoom(store, { roomId, name: 'P3', socketId: 's3' }).ok, true);
  assert.equal(amongUs.joinRoom(store, { roomId, name: 'P4', socketId: 's4' }).ok, true);

  const full = amongUs.joinRoom(store, { roomId, name: 'P5', socketId: 's5' });
  assert.equal(full.ok, false);
  assert.equal(full.error.code, 'ROOM_FULL');

  const nameInUse = amongUs.joinRoom(store, { roomId, name: 'P2', socketId: 's6' });
  assert.equal(nameInUse.ok, false);
  assert.equal(nameInUse.error.code, 'NAME_IN_USE');

  const reclaimed = amongUs.joinRoom(store, { roomId, name: 'P2', socketId: 's2' });
  assert.equal(reclaimed.ok, true);
  assert.equal(created.room.players.filter((p) => p.name === 'P2').length, 1);
});
