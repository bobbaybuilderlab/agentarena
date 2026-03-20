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
const {
  createAnonymousUser,
  consumeUserDailyMatchQuota,
} = require('../server/db');

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

function seedIdleAgent(id, offsetMs, { idleSince, withSocket = false, ownerUserId = null } = {}) {
  const timestamp = Date.now() - offsetMs;
  agentProfiles.set(id, {
    id,
    name: id,
    deployed: true,
    owner: `owner-${id}`,
    ownerUserId,
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
  const ownerIds = Array.from({ length: 6 }, (_unused, index) => `repeat-owner-${Date.now()}-${index + 1}`);
  for (const ownerUserId of ownerIds) {
    await createAnonymousUser(ownerUserId);
  }
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((id, index) => {
    seedIdleAgent(id, 120000 - (index * 1000), {
      idleSince: Date.now() - 5,
      withSocket: true,
      ownerUserId: ownerIds[index],
    });
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
  const ownerIds = Array.from({ length: 6 }, (_unused, index) => `broken-owner-${Date.now()}-${index + 1}`);
  for (const ownerUserId of ownerIds) {
    await createAnonymousUser(ownerUserId);
  }
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((id, index) => {
    seedIdleAgent(id, 120000 - (index * 1000), {
      idleSince: Date.now() - 50000,
      withSocket: true,
      ownerUserId: ownerIds[index],
    });
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

test('public arena queue only seats one agent when an owner has one daily match remaining', async () => {
  const timestampPrefix = Date.now();
  const sharedOwnerUserId = `quota-owner-shared-${timestampPrefix}`;
  await createAnonymousUser(sharedOwnerUserId);
  for (let index = 0; index < 24; index += 1) {
    await consumeUserDailyMatchQuota(sharedOwnerUserId);
  }

  seedIdleAgent('Owner-A', 120000, {
    idleSince: Date.now() - 10000,
    withSocket: true,
    ownerUserId: sharedOwnerUserId,
  });
  seedIdleAgent('Owner-B', 119000, {
    idleSince: Date.now() - 10000,
    withSocket: true,
    ownerUserId: sharedOwnerUserId,
  });

  const otherOwnerIds = Array.from({ length: 5 }, (_unused, index) => `quota-owner-${timestampPrefix}-${index + 1}`);
  for (const ownerUserId of otherOwnerIds) {
    await createAnonymousUser(ownerUserId);
  }
  ['Gamma', 'Hotel', 'India', 'Juliet', 'Kilo'].forEach((id, index) => {
    seedIdleAgent(id, 118000 - (index * 1000), {
      idleSince: Date.now() - 10000,
      withSocket: true,
      ownerUserId: otherOwnerIds[index],
    });
  });

  await processPublicArenaQueue();

  const roomAgentIds = await waitFor(() => (
    mafiaRooms.size === 1 ? currentRoomAgentIds() : null
  ), 1000, 25);

  assert.ok(roomAgentIds, 'expected a public arena room');
  const sharedSeats = roomAgentIds.filter((id) => id === 'Owner-A' || id === 'Owner-B');
  assert.equal(sharedSeats.length, 1);
});

test('ownerless agents are skipped by the public arena queue', async () => {
  const timestampPrefix = Date.now();
  seedIdleAgent('Ownerless', 125000, {
    idleSince: Date.now() - 10000,
    withSocket: true,
  });

  const ownerIds = Array.from({ length: 6 }, (_unused, index) => `owned-owner-${timestampPrefix}-${index + 1}`);
  for (const ownerUserId of ownerIds) {
    await createAnonymousUser(ownerUserId);
  }
  ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].forEach((id, index) => {
    seedIdleAgent(id, 124000 - (index * 1000), {
      idleSince: Date.now() - 10000,
      withSocket: true,
      ownerUserId: ownerIds[index],
    });
  });

  await processPublicArenaQueue();

  const roomAgentIds = await waitFor(() => (
    mafiaRooms.size === 1 ? currentRoomAgentIds() : null
  ), 1000, 25);

  assert.ok(roomAgentIds, 'expected a public arena room');
  assert.equal(roomAgentIds.includes('Ownerless'), false);
  assert.equal(roomAgentIds.length, 6);
});
