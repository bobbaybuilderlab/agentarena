const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

process.env.ROUND_MS = '700';
process.env.VOTE_MS = '500';

const { server, rooms, clearAllGameTimers } = require('../server');

function onceEvent(socket, name, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${name}`)), timeoutMs);
    socket.once(name, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function withServer(fn) {
  rooms.clear();
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

test('battle flow: round/vote timers transition and reset blocks stale finalize', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const p2 = ioc(url, { reconnection: false, autoUnref: true });
    const watcher = ioc(url, { reconnection: false, autoUnref: true });

    const created = await emitAck(host, 'room:create', { name: 'Host', type: 'human' });
    assert.equal(created.ok, true);

    const joined = await emitAck(p2, 'room:join', { roomId: created.roomId, name: 'P2', type: 'human' });
    assert.equal(joined.ok, true);

    await emitAck(watcher, 'room:watch', { roomId: created.roomId });

    const started = await emitAck(host, 'battle:start', { roomId: created.roomId });
    assert.equal(started.ok, true);

    const roundUpdate = await onceEvent(watcher, 'room:update');
    assert.equal(roundUpdate.status, 'round');
    assert.ok(roundUpdate.roundEndsAt > Date.now());

    const inRoundReset = await emitAck(host, 'battle:reset', { roomId: created.roomId });
    assert.equal(inRoundReset.ok, true);

    const lobbyAfterReset = await onceEvent(watcher, 'room:update');
    assert.equal(lobbyAfterReset.status, 'lobby');
    assert.equal(lobbyAfterReset.round, 0);
    assert.equal(lobbyAfterReset.voteEndsAt, null);

    await new Promise((r) => setTimeout(r, 1400));
    const room = rooms.get(created.roomId);
    assert.equal(room.status, 'lobby');
    assert.equal(room.round, 0);

    host.disconnect();
    p2.disconnect();
    watcher.disconnect();
  });
});

test('battle flow: voting rules enforce self-vote and duplicate-vote blocks', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const agentB = ioc(url, { reconnection: false, autoUnref: true });
    const watcher = ioc(url, { reconnection: false, autoUnref: true });

    const created = await emitAck(host, 'room:create', { name: 'AgentA', type: 'agent', owner: 'a@example.com' });
    assert.equal(created.ok, true);

    const joined = await emitAck(agentB, 'room:join', { roomId: created.roomId, name: 'AgentB', type: 'agent', owner: 'b@example.com' });
    assert.equal(joined.ok, true);

    await emitAck(watcher, 'room:watch', { roomId: created.roomId });
    await emitAck(host, 'battle:start', { roomId: created.roomId });

    let roundState;
    do {
      roundState = await onceEvent(watcher, 'room:update');
    } while (roundState.status !== 'round');

    await emitAck(host, 'roast:submit', { roomId: created.roomId, text: 'a roast' });
    await emitAck(agentB, 'roast:submit', { roomId: created.roomId, text: 'b roast' });

    let voteState;
    do {
      voteState = await onceEvent(watcher, 'room:update');
    } while (voteState.status !== 'voting');

    const selfVote = await emitAck(host, 'vote:cast', { roomId: created.roomId, playerId: created.playerId });
    assert.equal(selfVote.ok, false);
    assert.equal(selfVote.error, 'Self vote blocked');

    const firstValid = await emitAck(host, 'vote:cast', { roomId: created.roomId, playerId: joined.playerId });
    assert.equal(firstValid.ok, true);

    const duplicate = await emitAck(host, 'vote:cast', { roomId: created.roomId, playerId: joined.playerId });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error, 'Already voted');

    host.disconnect();
    agentB.disconnect();
    watcher.disconnect();
  });
});

test('battle flow: vote timer does not double-finalize after early unanimous voting', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const p2 = ioc(url, { reconnection: false, autoUnref: true });
    const watcher = ioc(url, { reconnection: false, autoUnref: true });

    const created = await emitAck(host, 'room:create', { name: 'Host', type: 'agent', owner: 'h@example.com' });
    const joined = await emitAck(p2, 'room:join', { roomId: created.roomId, name: 'P2', type: 'agent', owner: 'p2@example.com' });
    assert.equal(created.ok && joined.ok, true);

    await emitAck(watcher, 'room:watch', { roomId: created.roomId });
    await emitAck(host, 'battle:start', { roomId: created.roomId });

    let state;
    do {
      state = await onceEvent(watcher, 'room:update');
    } while (state.status !== 'round');

    await emitAck(host, 'roast:submit', { roomId: created.roomId, text: 'host roast' });
    await emitAck(p2, 'roast:submit', { roomId: created.roomId, text: 'p2 roast' });

    do {
      state = await onceEvent(watcher, 'room:update');
    } while (state.status !== 'voting');

    await emitAck(host, 'vote:cast', { roomId: created.roomId, playerId: joined.playerId });
    await emitAck(p2, 'vote:cast', { roomId: created.roomId, playerId: created.playerId });

    do {
      state = await onceEvent(watcher, 'room:update');
    } while (state.status !== 'lobby');

    const room = rooms.get(created.roomId);
    const scoreHost = room.totalVotes[created.playerId] || 0;
    const scoreP2 = room.totalVotes[joined.playerId] || 0;

    await new Promise((r) => setTimeout(r, 650));

    assert.equal(room.round, 1);
    assert.equal((room.totalVotes[created.playerId] || 0) + (room.totalVotes[joined.playerId] || 0), scoreHost + scoreP2);
    assert.equal(room.status, 'lobby');

    host.disconnect();
    p2.disconnect();
    watcher.disconnect();
  });
});

test('battle flow: reconnect keeps same player identity instead of duplicating', async () => {
  await withServer(async (url) => {
    const host = ioc(url, { reconnection: false, autoUnref: true });
    const agent1 = ioc(url, { reconnection: false, autoUnref: true });

    const created = await emitAck(host, 'room:create', { name: 'Host', type: 'human' });
    assert.equal(created.ok, true);

    const joined = await emitAck(agent1, 'room:join', {
      roomId: created.roomId,
      name: 'ReconnectMe',
      type: 'agent',
      owner: 'reconnect@example.com',
    });
    assert.equal(joined.ok, true);

    const roomBefore = rooms.get(created.roomId);
    assert.equal(roomBefore.players.length, 2);

    agent1.disconnect();
    await new Promise((r) => setTimeout(r, 80));

    const agent1Reconnect = ioc(url, { reconnection: false, autoUnref: true });
    const rejoined = await emitAck(agent1Reconnect, 'room:join', {
      roomId: created.roomId,
      name: 'ReconnectMe',
      type: 'agent',
      owner: 'reconnect@example.com',
    });
    assert.equal(rejoined.ok, true);
    assert.equal(rejoined.playerId, joined.playerId);

    const roomAfter = rooms.get(created.roomId);
    assert.equal(roomAfter.players.length, 2);
    const player = roomAfter.players.find((p) => p.id === joined.playerId);
    assert.equal(player.isConnected, true);

    host.disconnect();
    agent1Reconnect.disconnect();
  });
});
