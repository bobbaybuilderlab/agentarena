const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

process.env.MAFIA_NIGHT_MS = '80';
process.env.MAFIA_DISCUSSION_MS = '80';
process.env.MAFIA_VOTING_MS = '80';
process.env.MAFIA_DISCUSSION_TURN_MS = '30';
process.env.AUTH_RATE_LIMIT_MAX = '20';
process.env.OPS_RATE_LIMIT_MAX = '50';
process.env.OPENCLAW_CREATE_RATE_LIMIT_MAX = '200';
process.env.OPENCLAW_CALLBACK_RATE_LIMIT_MAX = '200';
process.env.OPENCLAW_STATUS_RATE_LIMIT_MAX = '200';
process.env.ALLOW_INSECURE_DEV_SURFACES = '1';

const {
  server,
  io,
  mafiaRooms,
  agentProfiles,
  connectSessions,
  liveAgentRuntimes,
  agentRuntimeSockets,
  roomEvents,
  processPublicArenaQueue,
  createPublicArenaMafiaRoom,
  recordFirstMatchCompletion,
  releasePublicArenaRoom,
  buildMatchBaseline,
  clearAllGameTimers,
  resetPlayTelemetry,
  resetAgentArenaRuntime,
} = require('../server');
const {
  createAnonymousUser,
  consumeUserDailyMatchQuota,
} = require('../server/db');

const syntheticSocketIds = new Set();

async function withServer(fn) {
  mafiaRooms.clear();
  agentProfiles.clear();
  connectSessions.clear();
  liveAgentRuntimes.clear();
  syntheticSocketIds.forEach((socketId) => io.sockets.sockets.delete(socketId));
  syntheticSocketIds.clear();
  roomEvents.clear();
  resetPlayTelemetry();
  resetAgentArenaRuntime();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  try {
    await fn(url);
  } finally {
    clearAllGameTimers();
    resetAgentArenaRuntime();
    syntheticSocketIds.forEach((socketId) => io.sockets.sockets.delete(socketId));
    syntheticSocketIds.clear();
    await new Promise((resolve) => server.close(resolve));
  }
}

function once(socket, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${eventName}`)), timeoutMs);
    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function waitFor(fn, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function emitAck(socket, eventName, payload) {
  return new Promise((resolve) => {
    socket.emit(eventName, payload, resolve);
  });
}

function addQueuedTestAgent(id, name, connectedAt, { ownerUserId = null } = {}) {
  const agent = {
    id,
    name,
    deployed: true,
    owner: `owner-${id}`,
    ownerUserId,
  };
  agentProfiles.set(id, agent);
  const socketId = `sock-${id}`;
  io.sockets.sockets.set(socketId, {
    id: socketId,
    emit() {},
    join() {},
    disconnect() {},
  });
  syntheticSocketIds.add(socketId);
  agentRuntimeSockets.set(socketId, id);
  liveAgentRuntimes.set(id, {
    agentId: id,
    connected: true,
    status: 'idle',
    socketId,
    currentRoomId: null,
    currentPlayerId: null,
    connectedAt,
    lastSeenAt: connectedAt,
  });
  return agent;
}

async function createSiteSessionData(url) {
  const authRes = await fetch(`${url}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const authData = await authRes.json();
  assert.equal(authData.ok, true);
  assert.ok(authData.session?.token);
  assert.ok(authData.session?.userId);
  return authData.session;
}

async function createRuntimeAgent(url, name, { sessionToken } = {}) {
  assert.ok(sessionToken, 'sessionToken is required for connect-session creation');
  const spokenDiscussionDays = new Set();
  const connectSessionRes = await fetch(`${url}/api/openclaw/connect-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify({ email: `${name.toLowerCase()}@example.com` }),
  });
  const connectSessionData = await connectSessionRes.json();
  assert.equal(connectSessionData.ok, true);

  const connect = connectSessionData.connect;
  const callbackProof = String(connect.callbackProof || '').trim();
  assert.ok(callbackProof);
  const callbackRes = await fetch(`${url}/api/openclaw/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: connect.id,
      proof: callbackProof,
      agentName: name,
      style: 'witty',
    }),
  });
  const callbackData = await callbackRes.json();
  assert.equal(callbackData.ok, true);
  assert.equal(callbackData.agent.persona.presetId, 'pragmatic');
  assert.equal(callbackData.agent.persona.style, 'witty');

  const socket = ioc(url, { reconnection: false, autoUnref: true });
  let assignedRoomId = null;
  let playerId = null;

  socket.on('mafia:state', (state) => {
    assignedRoomId = assignedRoomId || state.id;
    const me = (state.players || []).find((entry) => entry.name === name);
    playerId = playerId || me?.id || null;
  });

  socket.on('mafia:agent:night_request', (payload) => {
    const target = (payload.players || []).find((entry) => entry.id !== payload.playerId);
    socket.emit('mafia:agent:decision', {
      roomId: payload.roomId,
      playerId: payload.playerId,
      phase: payload.phase,
      type: 'nightKill',
      targetId: target?.id,
    });
  });

  socket.on('mafia:agent:discussion_request', (payload) => {
    const discussionKey = `${payload.roomId}:${payload.day}`;
    const hasSpokenThisDay = spokenDiscussionDays.has(discussionKey);
    if (!hasSpokenThisDay) spokenDiscussionDays.add(discussionKey);
    socket.emit('mafia:agent:decision', {
      roomId: payload.roomId,
      playerId: payload.playerId,
      phase: payload.phase,
      turnId: payload.turnId,
      type: hasSpokenThisDay ? 'pass' : 'discussion',
      message: hasSpokenThisDay
        ? undefined
        : `Pressure stays on ${(payload.players || []).find((entry) => entry.id !== payload.playerId)?.name || 'the quiet seat'}.`,
    });
  });

  socket.on('mafia:agent:vote_request', (payload) => {
    const target = (payload.players || []).find((entry) => entry.id !== payload.playerId);
    socket.emit('mafia:agent:decision', {
      roomId: payload.roomId,
      playerId: payload.playerId,
      phase: payload.phase,
      type: 'vote',
      targetId: target?.id,
    });
  });

  await once(socket, 'connect');
  const register = await new Promise((resolve) => {
    socket.emit('agent:runtime:register', {
      token: connect.id,
      proof: callbackProof,
    }, resolve);
  });
  assert.equal(register.ok, true);

  return {
    socket,
    agentId: callbackData.agent.id,
    legacyToken: connect.id,
    legacyProof: callbackProof,
    runtimeCredential: callbackData.runtimeCredential || null,
    getAssignedRoomId: () => assignedRoomId,
    getPlayerId: () => playerId,
  };
}

test('runtime secret can reconnect after the onboarding connect session expires', async () => {
  await withServer(async (url) => {
    const authRes = await fetch(`${url}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const authData = await authRes.json();
    assert.equal(authData.ok, true);

    const agent = await createRuntimeAgent(url, 'ReconnectBot', {
      sessionToken: authData.session.token,
    });

    try {
      assert.ok(agent.runtimeCredential?.runtimeSecret, 'expected runtime credential from connect callback');
      const storedConnect = connectSessions.get(agent.legacyToken);
      assert.ok(storedConnect, 'expected legacy connect session to exist');
      storedConnect.expiresAt = Date.now() - 1;

      agent.socket.disconnect();

      const socket = ioc(url, { reconnection: false, autoUnref: true });
      await once(socket, 'connect');

      const register = await new Promise((resolve) => {
        socket.emit('agent:runtime:register', {
          agentId: agent.agentId,
          runtimeSecret: agent.runtimeCredential.runtimeSecret,
        }, resolve);
      });

      assert.equal(register.ok, true);
      assert.equal(register.agent.id, agent.agentId);
      socket.disconnect();
    } finally {
      agent.socket.disconnect();
    }
  });
});

test('connect callback rejects sessions missing owner binding', async () => {
  await withServer(async (url) => {
    const connectId = 'ownerless-connect-session';
    connectSessions.set(connectId, {
      id: connectId,
      email: 'anonymous',
      status: 'pending_confirmation',
      callbackUrl: `${url}/api/openclaw/callback`,
      callbackProof: 'ownerless-proof',
      accessToken: 'ownerless-access',
      accessTokenHash: '',
      callbackProofHash: '',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      ownerUserId: null,
      agentId: null,
      agentName: null,
      connectedAt: null,
    });

    const callbackRes = await fetch(`${url}/api/openclaw/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: connectId,
        proof: 'ownerless-proof',
        agentName: 'OwnerlessBot',
        style: 'witty',
      }),
    });
    const callbackData = await callbackRes.json();

    assert.equal(callbackRes.status, 409);
    assert.equal(callbackData.ok, false);
    assert.equal(callbackData.code, 'CONNECT_SESSION_OWNER_REQUIRED');
    assert.equal(agentProfiles.size, 0);
    assert.equal(connectSessions.get(connectId)?.status, 'pending_confirmation');
  });
});

test('public arena match completion updates recency and changes the next batch', async () => {
  await withServer(async (url) => {
    void url;

    const repeatNames = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
    const freshNames = ['Golf', 'Hotel', 'India', 'Juliet', 'Kilo'];
    const ownerIds = Array.from(
      { length: repeatNames.length + freshNames.length },
      (_unused, index) => `history-owner-${Date.now()}-${index + 1}`,
    );
    for (const ownerUserId of ownerIds) {
      await createAnonymousUser(ownerUserId);
    }

    const repeatGroup = repeatNames
      .map((name, index) => addQueuedTestAgent(`history-${index + 1}`, name, index + 1, {
        ownerUserId: ownerIds[index],
      }));
    const freshGroup = freshNames
      .map((name, index) => addQueuedTestAgent(`history-fresh-${index + 1}`, name, repeatGroup.length + index + 1, {
        ownerUserId: ownerIds[repeatGroup.length + index],
      }));

    const firstRoom = createPublicArenaMafiaRoom(repeatGroup);
    assert.ok(firstRoom);

    firstRoom.status = 'finished';
    firstRoom.phase = 'finished';
    firstRoom.winner = 'town';
    firstRoom.finishedAt = Date.now();
    recordFirstMatchCompletion('mafia', firstRoom.id);
    releasePublicArenaRoom(firstRoom);

    const nextRoom = await waitFor(() => [...mafiaRooms.values()]
      .find((room) => room.id !== firstRoom.id && room.publicArena && room.status === 'in_progress') || null, 500, 10);
    assert.ok(nextRoom, 'expected a fresh public arena room after releasing the finished match');

    const nextAgentIds = new Set(nextRoom.players.map((player) => player.agentId));
    assert.equal(nextAgentIds.has(repeatGroup[0].id), true);
    for (const agent of repeatGroup.slice(1)) {
      assert.equal(nextAgentIds.has(agent.id), false, `expected ${agent.name} to be skipped after the completed match updated recency`);
    }
    for (const agent of freshGroup) {
      assert.equal(nextAgentIds.has(agent.id), true, `expected ${agent.name} to join the remixed batch`);
    }
  });
});

test('public arena queue does not double-book agents across simultaneous room creation', async () => {
  await withServer(async (url) => {
    void url;

    const ownerIds = Array.from(
      { length: 12 },
      (_unused, index) => `pool-owner-${Date.now()}-${index + 1}`,
    );
    for (const ownerUserId of ownerIds) {
      await createAnonymousUser(ownerUserId);
    }

    const agents = Array.from({ length: 12 }, (_unused, index) => (
      addQueuedTestAgent(`pool-${index + 1}`, `Agent ${index + 1}`, index + 1, {
        ownerUserId: ownerIds[index],
      })
    ));
    await processPublicArenaQueue();

    const rooms = [...mafiaRooms.values()].filter((room) => room.publicArena);
    assert.equal(rooms.length, 2);

    const seatedAgentIds = rooms.flatMap((room) => room.players.map((player) => player.agentId));
    assert.equal(seatedAgentIds.length, agents.length);
    assert.equal(new Set(seatedAgentIds).size, agents.length);
  });
});

test('over-cap owners stay connected but are skipped by the public arena queue', async () => {
  await withServer(async (url) => {
    const agents = [];
    try {
      const blockedSession = await createSiteSessionData(url);
      for (let index = 0; index < 25; index += 1) {
        await consumeUserDailyMatchQuota(blockedSession.userId);
      }

      const blockedAgent = await createRuntimeAgent(url, 'BlockedBot', {
        sessionToken: blockedSession.token,
      });
      agents.push({ ...blockedAgent, sessionToken: blockedSession.token, userId: blockedSession.userId });

      const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
      for (const name of names) {
        const session = await createSiteSessionData(url);
        const agent = await createRuntimeAgent(url, name, {
          sessionToken: session.token,
        });
        agents.push({ ...agent, sessionToken: session.token, userId: session.userId });
      }

      const activeRoom = await waitFor(() => (
        [...mafiaRooms.values()].find((room) => room.publicArena && room.status === 'in_progress') || null
      ), 4000, 25);
      assert.ok(activeRoom, 'expected an active public arena room');

      const seatedAgentIds = new Set((activeRoom.players || []).map((player) => player.agentId || player.userId));
      assert.equal(seatedAgentIds.has(blockedAgent.agentId), false);

      const mineRes = await fetch(`${url}/api/agents/mine`, {
        headers: { Authorization: `Bearer ${blockedSession.token}` },
      });
      const mineData = await mineRes.json();
      assert.equal(mineData.ok, true);
      assert.equal(mineData.quota.dailyLimit, 25);
      assert.equal(mineData.quota.used, 25);
      assert.equal(mineData.quota.remaining, 0);
      assert.equal(mineData.quota.blocked, true);
      assert.equal(mineData.agent.arena.queueStatus, 'daily_limit_reached');
      assert.equal(liveAgentRuntimes.get(blockedAgent.agentId)?.connected, true);
    } finally {
      agents.forEach(({ socket }) => socket.disconnect());
    }
  });
});

test('public read cache invalidates after a newly recorded match', async (t) => {
  await withServer(async (url) => {
    const agents = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']
      .map((name, index) => addQueuedTestAgent(`cache-${index + 1}`, name, index + 1));

    const firstRoom = createPublicArenaMafiaRoom(agents);
    assert.ok(firstRoom);
    firstRoom.status = 'finished';
    firstRoom.phase = 'finished';
    firstRoom.winner = 'town';
    firstRoom.finishedAt = Math.max(Date.now(), Number(firstRoom.startedAt || 0) + 1000);
    firstRoom._phaseScheduleKey = null;
    firstRoom._discussionTurnKey = null;
    firstRoom.phaseEndsAt = null;
    firstRoom.liveAgentPromptKey = null;
    recordFirstMatchCompletion('mafia', firstRoom.id);

    const trackedAgentId = agents[0].id;
    const firstSnapshot = await waitFor(async () => {
      const statsRes = await fetch(`${url}/api/stats`);
      const stats = await statsRes.json();
      const leaderboardRes = await fetch(`${url}/api/leaderboard?window=12h&limit=25`);
      const leaderboard = await leaderboardRes.json();
      const trackedAgent = (leaderboard.topAgents || []).find((entry) => entry.id === trackedAgentId);
      return Number(stats.totalGames || 0) >= 1 && trackedAgent
        ? { stats, leaderboard, trackedAgent }
        : null;
    }, 4000, 50);
    assert.ok(firstSnapshot, 'expected the first completed match to persist');

    if (firstSnapshot.stats.source !== 'database' || firstSnapshot.leaderboard.source !== 'database') {
      t.skip('public read cache only applies to database-backed leaderboard and stats responses');
      return;
    }

    const firstStatsRes = await fetch(`${url}/api/stats`);
    const firstStats = await firstStatsRes.json();
    const firstLeaderboardRes = await fetch(`${url}/api/leaderboard?window=12h&limit=25`);
    const firstLeaderboard = await firstLeaderboardRes.json();
    const firstTrackedAgent = (firstLeaderboard.topAgents || []).find((entry) => entry.id === trackedAgentId);
    assert.ok(firstTrackedAgent);
    assert.equal(Number(firstStats.totalGames || 0), Number(firstSnapshot.stats.totalGames || 0));
    assert.equal(Number(firstTrackedAgent.gamesPlayed || 0), Number(firstSnapshot.trackedAgent.gamesPlayed || 0));

    const secondRoom = createPublicArenaMafiaRoom(agents);
    assert.ok(secondRoom, 'expected to create a second public arena room');
    secondRoom.status = 'finished';
    secondRoom.phase = 'finished';
    secondRoom.winner = 'mafia';
    secondRoom.finishedAt = Math.max(Date.now(), Number(secondRoom.startedAt || 0) + 1000);
    secondRoom._phaseScheduleKey = null;
    secondRoom._discussionTurnKey = null;
    secondRoom.phaseEndsAt = null;
    secondRoom.liveAgentPromptKey = null;
    recordFirstMatchCompletion('mafia', secondRoom.id);

    const secondSnapshot = await waitFor(async () => {
      const statsRes = await fetch(`${url}/api/stats`);
      const stats = await statsRes.json();
      const leaderboardRes = await fetch(`${url}/api/leaderboard?window=12h&limit=25`);
      const leaderboard = await leaderboardRes.json();
      const trackedAgent = (leaderboard.topAgents || []).find((entry) => entry.id === trackedAgentId);
      return Number(stats.totalGames || 0) >= Number(firstStats.totalGames || 0) + 1
        && Number(trackedAgent?.gamesPlayed || 0) >= Number(firstTrackedAgent.gamesPlayed || 0) + 1
        ? { stats, leaderboard, trackedAgent }
        : null;
    }, 4000, 50);
    assert.ok(secondSnapshot, 'expected cache invalidation to expose the newly recorded match');
    assert.equal(Number(secondSnapshot.stats.totalGames || 0), Number(firstStats.totalGames || 0) + 1);
    assert.equal(Number(secondSnapshot.trackedAgent.gamesPlayed || 0), Number(firstTrackedAgent.gamesPlayed || 0) + 1);
  });
});

test('six runtime-connected agents auto-seat into a live Mafia match and finish it', async () => {
  await withServer(async (url) => {
    const agents = [];
    try {
      const authRes = await fetch(`${url}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const authData = await authRes.json();
      assert.equal(authData.ok, true);
      const sessionToken = authData.session.token;
      assert.ok(sessionToken);

      const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
      for (const name of names) {
        agents.push(await createRuntimeAgent(url, name, {
          sessionToken,
        }));
      }

      const seatedRoomId = await waitFor(async () => {
        const roomIds = agents.map((agent) => agent.getAssignedRoomId()).filter(Boolean);
        return roomIds.length >= 6 ? roomIds[0] : null;
      }, 4000, 25);
      assert.ok(seatedRoomId, 'expected all six agents to receive a room assignment');

      const watchRes = await fetch(`${url}/api/play/watch`);
      assert.equal(watchRes.status, 410);
      const watchData = await watchRes.json();
      assert.equal(watchData.ok, false);

      const liveHealthRes = await fetch(`${url}/health`);
      const liveHealth = await liveHealthRes.json();
      assert.equal(liveHealth.ok, true);
      assert.equal('publicArena' in liveHealth, false);

      const baseline = await waitFor(async () => {
        const data = await buildMatchBaseline('mafia');
        return Number(data?.sampleSize || 0) >= 1 ? data : null;
      }, 6000, 75);
      assert.ok(baseline, 'expected at least one completed Mafia match');

      const agentStatusRes = await fetch(`${url}/api/agents/${agents[0].agentId}`);
      assert.equal(agentStatusRes.status, 410);
      const agentStatusData = await agentStatusRes.json();
      assert.equal(agentStatusData.ok, false);
      assert.match(agentStatusData.error || '', /agent profile APIs are not part of the current MVP/i);

      assert.equal(baseline.mode, 'mafia');
      assert.equal(baseline.sampleSize >= 1, true);
      assert.equal(Number(baseline.avgDurationMs || 0) > 0, true);
      assert.equal(Number(baseline.estimatedGamesPerHour || 0) > 0, true);

      mafiaRooms.clear();
      const durableBaseline = await buildMatchBaseline('mafia');
      assert.equal(durableBaseline.sampleSize >= 1, true);
      assert.equal(Number(durableBaseline.avgDurationMs || 0) > 0, true);

      const leaderboardRes = await fetch(`${url}/api/leaderboard?window=12h`);
      const leaderboardData = await leaderboardRes.json();
      assert.equal(leaderboardData.ok, true);
      assert.equal(leaderboardData.window, '12h');
      assert.equal(Array.isArray(leaderboardData.topAgents), true);
      assert.equal(leaderboardData.topAgents.length >= 1, true);
      assert.equal(Number(leaderboardData.topAgents[0].gamesPlayed || 0) >= 1, true);
      assert.equal(Number(leaderboardData.topAgents[0].mmr || 0) >= 0, true);
      assert.equal(Number(leaderboardData.topAgents[0].ratedMatches || 0) >= 1, true);
      assert.equal('peakMmr' in leaderboardData.topAgents[0], true);
      assert.equal('lastRatingDelta' in leaderboardData.topAgents[0], true);
      assert.equal('isProvisional' in leaderboardData.topAgents[0], true);
      assert.equal('queueStatus' in leaderboardData.topAgents[0], true);
      assert.equal('isLive' in leaderboardData.topAgents[0], true);
      assert.equal('activeRoomId' in leaderboardData.topAgents[0], false);
      assert.equal('arenaUrl' in leaderboardData.topAgents[0], false);
      assert.equal('watchUrl' in leaderboardData.topAgents[0], false);

      const matchesRes = await fetch(`${url}/api/matches?userId=${encodeURIComponent(agents[0].agentId)}&limit=5`);
      const matchesData = await matchesRes.json();
      assert.equal(matchesData.ok, true);
      assert.equal(Array.isArray(matchesData.matches), true);
      assert.equal(matchesData.matches.length >= 1, true);
      assert.ok(['mafia', 'town'].includes(matchesData.matches[0].winner));
      assert.equal('roomId' in matchesData.matches[0], false);
      assert.equal('room_id' in matchesData.matches[0], false);
      assert.equal('replayUrl' in matchesData.matches[0], false);

      const replayRes = await fetch(`${url}/api/rooms/${encodeURIComponent(seatedRoomId)}/replay?mode=mafia`);
      assert.equal(replayRes.status, 410);
      const replayData = await replayRes.json();
      assert.equal(replayData.ok, false);
      assert.match(replayData.error || '', /replay and event timelines/i);

      const statsRes = await fetch(`${url}/api/stats`);
      const statsData = await statsRes.json();
      assert.equal(statsData.ok, true);
      assert.equal(Number(statsData.totalGames || 0) >= 1, true);
      assert.equal(Number(statsData.uniqueAgents || 0) >= 6, true);
      assert.equal(typeof statsData.mafiasCaught, 'number');

      const mineRes = await fetch(`${url}/api/agents/mine`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      const mineData = await mineRes.json();
      assert.equal(mineData.ok, true);
      assert.equal(mineData.session.agentId, agents[5].agentId);
      assert.equal(mineData.session.primaryAgentId, agents[5].agentId);
      assert.equal(Array.isArray(mineData.agents), true);
      assert.equal(mineData.agents.length, 6);
      assert.equal(mineData.selectedAgentId, agents[5].agentId);
      assert.equal(mineData.agent.id, agents[5].agentId);
      assert.match(mineData.agent.arenaUrl, /\/connect\.html\?agentId=/);
      assert.equal(mineData.agent.watchUrl, null);
      assert.equal(Number(mineData.agent.mmr || 0) >= 0, true);
      assert.equal(Number(mineData.stats.gamesPlayed || 0) >= 1, true);
      assert.equal(Number(mineData.stats.ratedMatches || 0) >= 1, true);
      assert.equal('peakMmr' in mineData.stats, true);
      assert.equal('isProvisional' in mineData.stats, true);
      assert.equal(typeof mineData.stats.nightKillCredits, 'number');

      const mineMatchesRes = await fetch(`${url}/api/matches/mine?limit=5`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      const mineMatchesData = await mineMatchesRes.json();
      assert.equal(mineMatchesData.ok, true);
      assert.equal(mineMatchesData.agentId, agents[5].agentId);
      assert.equal(mineMatchesData.primaryAgentId, agents[5].agentId);
      assert.equal(Array.isArray(mineMatchesData.matches), true);
      assert.equal(mineMatchesData.matches.length >= 1, true);
      assert.equal('nightKillCredits' in mineMatchesData.matches[0], true);
      assert.equal('roomId' in mineMatchesData.matches[0], false);
      assert.equal('room_id' in mineMatchesData.matches[0], false);
      assert.equal('replayUrl' in mineMatchesData.matches[0], false);
    } finally {
      agents.forEach(({ socket }) => socket.disconnect());
    }
  });
});

test('public arena room creation rolls back cleanly when a reserved batch becomes invalid', async () => {
  await withServer(async (url) => {
    void url;

    const agents = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].map((name, idx) => {
      const id = `agent-${idx + 1}`;
      const agent = { id, name, deployed: true, owner: `owner-${idx + 1}` };
      agentProfiles.set(id, agent);
      liveAgentRuntimes.set(id, {
        agentId: id,
        connected: idx !== 5,
        status: 'reserved',
        socketId: idx !== 5 ? `sock-${idx + 1}` : null,
        currentRoomId: null,
        currentPlayerId: null,
      });
      return agent;
    });

    const created = createPublicArenaMafiaRoom(agents);

    assert.equal(created, null);
    assert.equal(mafiaRooms.size, 0);

    for (const agent of agents.slice(0, 5)) {
      const runtime = liveAgentRuntimes.get(agent.id);
      assert.equal(runtime.currentRoomId, null);
      assert.equal(runtime.currentPlayerId, null);
      assert.equal(runtime.status, 'reserved');
    }
  });
});
