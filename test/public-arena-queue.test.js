const test = require('node:test');
const assert = require('node:assert/strict');

const {
  io,
  mafiaRooms,
  agentProfiles,
  liveAgentRuntimes,
  agentRuntimeSockets,
  completedMatchRecords,
  idleLaunchAgents,
  selectPublicArenaBatch,
  processPublicArenaQueue,
  clearAllGameTimers,
  resetAgentArenaRuntime,
} = require('../server');

const syntheticSocketIds = new Set();

function resetState() {
  clearAllGameTimers();
  mafiaRooms.clear();
  agentProfiles.clear();
  syntheticSocketIds.forEach((socketId) => io.sockets.sockets.delete(socketId));
  syntheticSocketIds.clear();
  resetAgentArenaRuntime();
}

function seedCompletedArenaMatch(agentIds, { publicArena = true } = {}) {
  completedMatchRecords.unshift({
    id: `match-${completedMatchRecords.length + 1}`,
    mode: 'mafia',
    publicArena,
    finishedAt: new Date().toISOString(),
    players: agentIds.map((id, index) => ({
      userId: id,
      name: id,
      isBot: false,
      survived: true,
      placement: index + 1,
    })),
  });
}

function seedIdleAgent(id, offsetMs, { idleSince, withSocket = false } = {}) {
  const timestamp = Date.now() - offsetMs;
  agentProfiles.set(id, {
    id,
    name: id,
    deployed: true,
    owner: `owner-${id}`,
  });
  liveAgentRuntimes.set(id, {
    agentId: id,
    connected: true,
    status: 'idle',
    socketId: withSocket ? `socket-${id}` : `socket-${id}`,
    connectSessionId: null,
    currentRoomId: null,
    currentPlayerId: null,
    connectedAt: timestamp,
    idleSince: idleSince ?? timestamp,
    lastSeenAt: timestamp,
  });
  if (withSocket) {
    const socketId = `socket-${id}`;
    io.sockets.sockets.set(socketId, {
      id: socketId,
      emit() {},
      join() {},
      disconnect() {},
    });
    syntheticSocketIds.add(socketId);
    agentRuntimeSockets.set(socketId, id);
  }
}

function currentRoomAgentIds() {
  const room = [...mafiaRooms.values()][0];
  return (room?.players || []).map((player) => player.agentId || player.userId);
}

async function waitFor(fn, timeoutMs = 1000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

test.afterEach(() => {
  delete process.env.PUBLIC_ARENA_REPEAT_IDLE_FALLBACK_MS;
  resetState();
});

test('public arena selector avoids 4+ overlap when a 3-overlap batch exists', () => {
  seedCompletedArenaMatch(['A', 'B', 'C', 'D', 'E', 'F']);
  ['A', 'B', 'C', 'D', 'G', 'H', 'I'].forEach((id, index) => {
    seedIdleAgent(id, 120000 - (index * 1000), { idleSince: Date.now() - 10000 });
  });

  const selection = selectPublicArenaBatch(idleLaunchAgents());

  assert.equal(selection.reason, 'overlap_safe');
  assert.deepEqual(selection.batch.map((agent) => agent.id), ['A', 'B', 'C', 'G', 'H', 'I']);
});

test('public arena selector blocks an immediate rematch of the same six agents', () => {
  seedCompletedArenaMatch(['A', 'B', 'C', 'D', 'E', 'F']);
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((id, index) => {
    seedIdleAgent(id, 120000 - (index * 1000), { idleSince: Date.now() - 5000 });
  });

  const selection = selectPublicArenaBatch(idleLaunchAgents());

  assert.equal(selection.batch, null);
  assert.equal(selection.reason, 'blocked_recent_overlap');
  assert.deepEqual(selection.repeatedAgentIds, ['A', 'B', 'C', 'D', 'E', 'F']);
});

test('public arena selector allows the blocked rematch once repeated agents waited 60 seconds idle', () => {
  seedCompletedArenaMatch(['A', 'B', 'C', 'D', 'E', 'F']);
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((id, index) => {
    seedIdleAgent(id, 180000 - (index * 1000), { idleSince: Date.now() - 61000 });
  });

  const selection = selectPublicArenaBatch(idleLaunchAgents());

  assert.equal(selection.reason, 'fallback_after_idle_timeout');
  assert.deepEqual(selection.batch.map((agent) => agent.id), ['A', 'B', 'C', 'D', 'E', 'F']);
});

test('public arena queue self-wakes after the repeat timeout without another external event', async () => {
  process.env.PUBLIC_ARENA_REPEAT_IDLE_FALLBACK_MS = '30';
  seedCompletedArenaMatch(['A', 'B', 'C', 'D', 'E', 'F']);
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((id, index) => {
    seedIdleAgent(id, 120000 - (index * 1000), { idleSince: Date.now() - 5, withSocket: true });
  });

  await processPublicArenaQueue();
  assert.equal(mafiaRooms.size, 0);

  const roomAgentIds = await waitFor(() => (
    mafiaRooms.size === 1 ? currentRoomAgentIds() : null
  ), 500, 20);

  assert.deepEqual(roomAgentIds, ['A', 'B', 'C', 'D', 'E', 'F']);
});

test('failed public arena room creation preserves idleSince for the retried batch', async () => {
  seedCompletedArenaMatch(['A', 'B', 'C', 'D', 'E', 'F']);
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((id, index) => {
    seedIdleAgent(id, 120000 - (index * 1000), { idleSince: Date.now() - 50000, withSocket: true });
  });
  const beforeIdleSince = liveAgentRuntimes.get('A')?.idleSince;
  const brokenSocketId = liveAgentRuntimes.get('F')?.socketId;
  agentRuntimeSockets.delete(brokenSocketId);
  io.sockets.sockets.delete(brokenSocketId);
  syntheticSocketIds.delete(brokenSocketId);

  await processPublicArenaQueue();

  assert.equal(mafiaRooms.size, 0);
  assert.equal(liveAgentRuntimes.get('A')?.status, 'idle');
  assert.equal(liveAgentRuntimes.get('A')?.idleSince, beforeIdleSince);
});

test('private or human matches do not influence the public arena overlap check', () => {
  seedCompletedArenaMatch(['A', 'B', 'C', 'D', 'E', 'F'], { publicArena: false });
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((id, index) => {
    seedIdleAgent(id, 120000 - (index * 1000), { idleSince: Date.now() - 5000 });
  });

  const selection = selectPublicArenaBatch(idleLaunchAgents());

  assert.equal(selection.reason, 'no_recent_public_table');
  assert.deepEqual(selection.batch.map((agent) => agent.id), ['A', 'B', 'C', 'D', 'E', 'F']);
});
