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
  inMeeting.forEach((p) => {
    const vote = amongUs.submitAction(store, { roomId: room.id, playerId: p.id, type: 'vote', targetId: voteTarget.id });
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
