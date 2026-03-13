const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStore,
  createRoom,
  joinRoom,
  startGame,
  submitAction,
  prepareRematch,
  addLobbyBots,
  transitionRoomState,
  disconnectPlayer,
} = require('../games/agent-mafia');

test('agent-mafia room create/join/start happy path', () => {
  const store = createStore();

  const created = createRoom(store, { hostName: 'Host', hostSocketId: 's-host' });
  assert.equal(created.ok, true);

  const roomId = created.room.id;
  const hostPlayerId = created.player.id;

  const p2 = joinRoom(store, { roomId, name: 'P2', socketId: 's2' });
  const p3 = joinRoom(store, { roomId, name: 'P3', socketId: 's3' });
  const p4 = joinRoom(store, { roomId, name: 'P4', socketId: 's4' });
  const p5 = joinRoom(store, { roomId, name: 'P5', socketId: 's5' });
  const p6 = joinRoom(store, { roomId, name: 'P6', socketId: 's6' });
  assert.equal(p2.ok && p3.ok && p4.ok && p5.ok && p6.ok, true);

  const started = startGame(store, { roomId, hostPlayerId });
  assert.equal(started.ok, true);
  assert.equal(started.room.status, 'in_progress');
  assert.equal(started.room.phase, 'night');

  const roles = started.room.players.map((p) => p.role);
  assert.equal(roles.filter((r) => r === 'mafia').length, 2);
  assert.equal(roles.filter((r) => r === 'town').length, 4);
});

test('agent-mafia assigns a fresh matchId for each rematch in the same room', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host', hostSocketId: 's-host' });
  const roomId = created.room.id;
  const hostPlayerId = created.player.id;

  joinRoom(store, { roomId, name: 'P2', socketId: 's2' });
  joinRoom(store, { roomId, name: 'P3', socketId: 's3' });
  joinRoom(store, { roomId, name: 'P4', socketId: 's4' });
  joinRoom(store, { roomId, name: 'P5', socketId: 's5' });
  joinRoom(store, { roomId, name: 'P6', socketId: 's6' });

  const firstStart = startGame(store, { roomId, hostPlayerId });
  assert.equal(firstStart.ok, true);
  const firstMatchId = firstStart.room.matchId;
  assert.equal(typeof firstMatchId, 'string');
  assert.equal(firstMatchId.length > 0, true);

  firstStart.room.status = 'finished';
  firstStart.room.phase = 'finished';

  const rematch = prepareRematch(store, { roomId, hostPlayerId });
  assert.equal(rematch.ok, true);
  assert.equal(rematch.room.matchId, null);

  const secondStart = startGame(store, { roomId, hostPlayerId });
  assert.equal(secondStart.ok, true);
  assert.notEqual(secondStart.room.matchId, firstMatchId);
});

test('agent-mafia start requires host and minimum players', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host', hostSocketId: 's-host' });

  const tooEarly = startGame(store, { roomId: created.room.id, hostPlayerId: created.player.id });
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.error.code, 'NOT_ENOUGH_PLAYERS');

  joinRoom(store, { roomId: created.room.id, name: 'P2' });
  joinRoom(store, { roomId: created.room.id, name: 'P3' });
  joinRoom(store, { roomId: created.room.id, name: 'P4' });
  joinRoom(store, { roomId: created.room.id, name: 'P5' });
  joinRoom(store, { roomId: created.room.id, name: 'P6' });

  const nonHost = startGame(store, { roomId: created.room.id, hostPlayerId: 'not-host' });
  assert.equal(nonHost.ok, false);
  assert.equal(nonHost.error.code, 'HOST_ONLY');
});

test('agent-mafia caps lobby bot fill at six seats and rejects oversized rooms', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host', hostSocketId: 's-host' });
  const roomId = created.room.id;

  assert.equal(addLobbyBots(store, { roomId, count: 10 }).ok, true);
  assert.equal(created.room.players.length, 6);
  assert.equal(joinRoom(store, { roomId, name: 'P7', socketId: 's7' }).ok, false);

  created.room.players.push({
    id: 'OVERSIZE1',
    name: 'Overflow',
    socketId: null,
    isConnected: true,
    alive: true,
    role: null,
  });

  const oversized = startGame(store, { roomId, hostPlayerId: created.player.id });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, 'TOO_MANY_PLAYERS');
});

test('agent-mafia transitionRoomState rejects lobby -> voting', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host' });
  const bad = transitionRoomState(created.room, 'voting');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_PHASE_TRANSITION');
  assert.deepEqual(bad.error.details, { fromPhase: 'lobby', toPhase: 'voting' });
});

test('agent-mafia transitionRoomState rejects finished -> night', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host' });
  created.room.phase = 'finished';
  const bad = transitionRoomState(created.room, 'night');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_PHASE_TRANSITION');
  assert.deepEqual(bad.error.details, { fromPhase: 'finished', toPhase: 'night' });
});

test('agent-mafia disconnectPlayer returns whether state changed', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host', hostSocketId: 'host-socket' });

  assert.equal(disconnectPlayer(store, { roomId: created.room.id, socketId: 'unknown' }), false);
  assert.equal(disconnectPlayer(store, { roomId: created.room.id, socketId: 'host-socket' }), true);
  assert.equal(disconnectPlayer(store, { roomId: created.room.id, socketId: 'host-socket' }), false);
});

test('agent-mafia enforces lobby capacity and avoids duplicate name identities', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host', hostSocketId: 's1' });
  const roomId = created.room.id;

  assert.equal(joinRoom(store, { roomId, name: 'P2', socketId: 's2' }).ok, true);
  assert.equal(joinRoom(store, { roomId, name: 'P3', socketId: 's3' }).ok, true);
  assert.equal(joinRoom(store, { roomId, name: 'P4', socketId: 's4' }).ok, true);
  assert.equal(joinRoom(store, { roomId, name: 'P5', socketId: 's5' }).ok, true);
  assert.equal(joinRoom(store, { roomId, name: 'P6', socketId: 's6' }).ok, true);

  const full = joinRoom(store, { roomId, name: 'P7', socketId: 's7' });
  assert.equal(full.ok, false);
  assert.equal(full.error.code, 'ROOM_FULL');

  const nameInUse = joinRoom(store, { roomId, name: 'P2', socketId: 's8' });
  assert.equal(nameInUse.ok, false);
  assert.equal(nameInUse.error.code, 'NAME_IN_USE');

  const reclaimed = joinRoom(store, { roomId, name: 'P2', socketId: 's2' });
  assert.equal(reclaimed.ok, true);
  assert.equal(created.room.players.filter((p) => p.name === 'P2').length, 1);
});

test('agent-mafia continues to day 2 when no faction has won after the first vote', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host', hostSocketId: 's-host' });
  const roomId = created.room.id;
  const hostPlayerId = created.player.id;

  joinRoom(store, { roomId, name: 'P2', socketId: 's2' });
  joinRoom(store, { roomId, name: 'P3', socketId: 's3' });
  joinRoom(store, { roomId, name: 'P4', socketId: 's4' });
  joinRoom(store, { roomId, name: 'P5', socketId: 's5' });
  joinRoom(store, { roomId, name: 'P6', socketId: 's6' });

  const started = startGame(store, { roomId, hostPlayerId });
  assert.equal(started.ok, true);

  const room = started.room;
  const playersByName = Object.fromEntries(room.players.map((player) => [player.name, player]));

  playersByName.Host.role = 'mafia';
  playersByName.P2.role = 'mafia';
  playersByName.P3.role = 'town';
  playersByName.P4.role = 'town';
  playersByName.P5.role = 'town';
  playersByName.P6.role = 'town';

  assert.equal(submitAction(store, { roomId, playerId: playersByName.Host.id, type: 'nightKill', targetId: playersByName.P3.id }).ok, true);
  assert.equal(submitAction(store, { roomId, playerId: playersByName.P2.id, type: 'nightKill', targetId: playersByName.P3.id }).ok, true);
  assert.equal(room.phase, 'discussion');
  assert.equal(room.day, 1);

  for (const player of room.players.filter((entry) => entry.alive)) {
    assert.equal(submitAction(store, { roomId, playerId: player.id, type: 'ready' }).ok, true);
  }
  assert.equal(room.phase, 'voting');

  assert.equal(submitAction(store, { roomId, playerId: playersByName.Host.id, type: 'vote', targetId: playersByName.P4.id }).ok, true);
  assert.equal(submitAction(store, { roomId, playerId: playersByName.P2.id, type: 'vote', targetId: playersByName.P4.id }).ok, true);
  assert.equal(submitAction(store, { roomId, playerId: playersByName.P4.id, type: 'vote', targetId: playersByName.Host.id }).ok, true);
  assert.equal(submitAction(store, { roomId, playerId: playersByName.P5.id, type: 'vote', targetId: playersByName.Host.id }).ok, true);
  assert.equal(submitAction(store, { roomId, playerId: playersByName.P6.id, type: 'vote', targetId: playersByName.P2.id }).ok, true);

  assert.equal(room.status, 'in_progress');
  assert.equal(room.phase, 'night');
  assert.equal(room.day, 2);
  assert.equal(room.winner, null);
});

test('agent-mafia tracks night kill credit for mafia voters who picked the resolved victim', () => {
  const store = createStore();
  const created = createRoom(store, { hostName: 'Host', hostSocketId: 's-host' });
  const roomId = created.room.id;
  const hostPlayerId = created.player.id;

  joinRoom(store, { roomId, name: 'P2', socketId: 's2' });
  joinRoom(store, { roomId, name: 'P3', socketId: 's3' });
  joinRoom(store, { roomId, name: 'P4', socketId: 's4' });
  joinRoom(store, { roomId, name: 'P5', socketId: 's5' });
  joinRoom(store, { roomId, name: 'P6', socketId: 's6' });

  const started = startGame(store, { roomId, hostPlayerId });
  assert.equal(started.ok, true);

  const room = started.room;
  const playersByName = Object.fromEntries(room.players.map((player) => [player.name, player]));
  playersByName.Host.role = 'mafia';
  playersByName.P2.role = 'mafia';
  playersByName.P3.role = 'town';
  playersByName.P4.role = 'town';
  playersByName.P5.role = 'town';
  playersByName.P6.role = 'town';

  assert.equal(submitAction(store, { roomId, playerId: playersByName.Host.id, type: 'nightKill', targetId: playersByName.P3.id }).ok, true);
  assert.equal(submitAction(store, { roomId, playerId: playersByName.P2.id, type: 'nightKill', targetId: playersByName.P3.id }).ok, true);

  assert.equal(room.phase, 'discussion');
  assert.equal(room.nightKillCredits[playersByName.Host.id], 1);
  assert.equal(room.nightKillCredits[playersByName.P2.id], 1);

  const elimination = room.events.find((event) => event.type === 'NIGHT_ELIMINATION');
  assert.deepEqual(elimination.actorIds.sort(), [playersByName.Host.id, playersByName.P2.id].sort());
});
