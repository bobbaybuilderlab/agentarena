const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

process.env.MAFIA_NIGHT_MS = '80';
process.env.MAFIA_DISCUSSION_MS = '80';
process.env.MAFIA_VOTING_MS = '80';
process.env.MAFIA_DISCUSSION_TURN_MS = '30';
process.env.AUTH_RATE_LIMIT_MAX = '20';
process.env.OPS_RATE_LIMIT_MAX = '50';
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
  rememberPublicArenaMatchParticipants,
  recordFirstMatchCompletion,
  releasePublicArenaRoom,
  buildMatchBaseline,
  clearAllGameTimers,
  resetPlayTelemetry,
  resetAgentArenaRuntime,
} = require('../server');

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

function addQueuedTestAgent(id, name, connectedAt) {
  const agent = {
    id,
    name,
    deployed: true,
    owner: `owner-${id}`,
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

test('same-phase actions keep hard deadlines stable and discussion waits for its fixed deadline', async () => {
  await withServer(async (url) => {
    const names = ['Host', 'P2', 'P3', 'P4', 'P5', 'P6'];
    const sockets = [];
    try {
      for (const _name of names) {
        const socket = ioc(url, { reconnection: false, autoUnref: true });
        await once(socket, 'connect');
        sockets.push(socket);
      }

      const created = await emitAck(sockets[0], 'mafia:room:create', { name: names[0] });
      assert.equal(created.ok, true);

      const seats = new Map([[names[0], { socket: sockets[0], playerId: created.playerId }]]);
      for (let index = 1; index < names.length; index += 1) {
        const joined = await emitAck(sockets[index], 'mafia:room:join', { roomId: created.roomId, name: names[index] });
        assert.equal(joined.ok, true);
        seats.set(names[index], { socket: sockets[index], playerId: joined.playerId });
      }

      const started = await emitAck(sockets[0], 'mafia:start', { roomId: created.roomId, playerId: created.playerId });
      assert.equal(started.ok, true);

      const room = mafiaRooms.get(created.roomId);
      assert.ok(room);
      assert.equal(room.phase, 'night');

      const initialNightDeadline = room.phaseEndsAt;
      const mafiaPlayers = room.players.filter((player) => player.role === 'mafia');
      assert.equal(mafiaPlayers.length, 2);
      const nightTarget = room.players.find((player) => player.alive && player.role !== 'mafia');
      assert.ok(nightTarget);

      const firstMafiaSeat = [...seats.values()].find((seat) => seat.playerId === mafiaPlayers[0].id);
      const secondMafiaSeat = [...seats.values()].find((seat) => seat.playerId === mafiaPlayers[1].id);
      assert.ok(firstMafiaSeat);
      assert.ok(secondMafiaSeat);

      const firstNightAction = await emitAck(firstMafiaSeat.socket, 'mafia:action', {
        roomId: created.roomId,
        playerId: mafiaPlayers[0].id,
        type: 'nightKill',
        targetId: nightTarget.id,
      });
      assert.equal(firstNightAction.ok, true);
      assert.equal(room.phase, 'night');
      assert.equal(room.phaseEndsAt, initialNightDeadline);

      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(room.phaseEndsAt, initialNightDeadline);

      const secondNightAction = await emitAck(secondMafiaSeat.socket, 'mafia:action', {
        roomId: created.roomId,
        playerId: mafiaPlayers[1].id,
        type: 'nightKill',
        targetId: nightTarget.id,
      });
      assert.equal(secondNightAction.ok, true);
      assert.equal(room.phase, 'discussion');

      await waitFor(() => room.discussion?.turnId || null, 200, 5);
      const initialDiscussionDeadline = room.phaseEndsAt;
      assert.ok(initialDiscussionDeadline);

      const discussionSpeakerId = room.discussion.currentSpeakerId;
      const discussionSeat = [...seats.values()].find((seat) => seat.playerId === discussionSpeakerId);
      assert.ok(discussionSeat);

      const discussionAction = await emitAck(discussionSeat.socket, 'mafia:action', {
        roomId: created.roomId,
        playerId: discussionSpeakerId,
        type: 'discussion',
        turnId: room.discussion.turnId,
        message: 'Pressure stays on the loudest contradiction.',
      });
      assert.equal(discussionAction.ok, true);
      assert.equal(room.phase, 'discussion');
      assert.equal(room.phaseEndsAt, initialDiscussionDeadline);

      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(room.phase, 'discussion');
      assert.equal(room.phaseEndsAt, initialDiscussionDeadline);

      const votingRoom = await waitFor(() => room.phase === 'voting' ? room : null, 240, 5);
      assert.ok(votingRoom, 'expected discussion to expire into voting without early skip');
      assert.equal(room.phase, 'voting');
    } finally {
      sockets.forEach((socket) => socket.disconnect());
    }
  });
});

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

test('public arena queue avoids recent co-players when fresh opponents are available', async () => {
  await withServer(async (url) => {
    void url;

    const repeatGroup = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']
      .map((name, index) => addQueuedTestAgent(`repeat-${index + 1}`, name, index + 1));
    const freshGroup = ['Golf', 'Hotel', 'India', 'Juliet', 'Kilo']
      .map((name, index) => addQueuedTestAgent(`fresh-${index + 1}`, name, repeatGroup.length + index + 1));

    rememberPublicArenaMatchParticipants(repeatGroup.map((agent) => agent.id), 'recent-repeat-group');
    await processPublicArenaQueue();

    assert.equal(mafiaRooms.size, 1);
    const room = [...mafiaRooms.values()][0];
    const selectedAgentIds = new Set(room.players.map((player) => player.agentId));

    assert.equal(selectedAgentIds.has(repeatGroup[0].id), true, 'expected the oldest idle agent to seed the batch');
    for (const agent of repeatGroup.slice(1)) {
      assert.equal(selectedAgentIds.has(agent.id), false, `expected ${agent.name} to be avoided when fresh opponents exist`);
    }
    for (const agent of freshGroup) {
      assert.equal(selectedAgentIds.has(agent.id), true, `expected ${agent.name} to be selected as a fresh opponent`);
    }
    assert.equal(room.publicArenaMatchmaking.totalRepeatPenaltyScore, 0);
    assert.equal(room.publicArenaMatchmaking.repeatsUnavoidable, false);
  });
});

test('public arena queue still forms a room when recent repeats are unavoidable', async () => {
  await withServer(async (url) => {
    void url;

    const agents = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']
      .map((name, index) => addQueuedTestAgent(`fallback-${index + 1}`, name, index + 1));

    rememberPublicArenaMatchParticipants(agents.map((agent) => agent.id), 'recent-fallback-group');
    await processPublicArenaQueue();

    assert.equal(mafiaRooms.size, 1);
    const room = [...mafiaRooms.values()][0];
    assert.equal(room.players.length, 6);
    assert.equal(room.publicArenaMatchmaking.totalRepeatPenaltyScore > 0, true);
    assert.equal(room.publicArenaMatchmaking.repeatsUnavoidable, true);
  });
});

test('public arena match completion updates recency and changes the next batch', async () => {
  await withServer(async (url) => {
    void url;

    const repeatGroup = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']
      .map((name, index) => addQueuedTestAgent(`history-${index + 1}`, name, index + 1));
    const freshGroup = ['Golf', 'Hotel', 'India', 'Juliet', 'Kilo']
      .map((name, index) => addQueuedTestAgent(`history-fresh-${index + 1}`, name, repeatGroup.length + index + 1));

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

    const agents = Array.from({ length: 12 }, (_unused, index) => (
      addQueuedTestAgent(`pool-${index + 1}`, `Agent ${index + 1}`, index + 1)
    ));
    await processPublicArenaQueue();

    const rooms = [...mafiaRooms.values()].filter((room) => room.publicArena);
    assert.equal(rooms.length, 2);

    const seatedAgentIds = rooms.flatMap((room) => room.players.map((player) => player.agentId));
    assert.equal(seatedAgentIds.length, agents.length);
    assert.equal(new Set(seatedAgentIds).size, agents.length);
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

      const watchData = await waitFor(async () => {
        const res = await fetch(`${url}/api/play/watch`);
        const data = await res.json();
        return data?.ok && data.liveMatchActive ? data : null;
      }, 4000, 25);
      assert.ok(watchData, 'expected the status-only live match endpoint to report an active match');
      assert.equal(watchData.watchUrl, null);
      assert.equal(Number(watchData.activeMatches || 0) >= 1, true);
      assert.equal('roomId' in watchData, false);

      const liveHealthRes = await fetch(`${url}/health`);
      const liveHealth = await liveHealthRes.json();
      assert.equal(liveHealth.ok, true);
      assert.equal('publicArena' in liveHealth, false);

      const opsHealthRes = await fetch(`${url}/api/ops/health`);
      const opsHealth = await opsHealthRes.json();
      assert.equal(opsHealth.ok, true);
      assert.equal(opsHealth.publicArena.connectedAgents, 6);
      assert.equal(opsHealth.publicArena.idleAgents, 0);
      assert.equal(opsHealth.publicArena.inMatchAgents, 6);
      assert.equal(Number(opsHealth.publicArena.activeMatches || 0) >= 1, true);
      assert.equal(typeof opsHealth.publicArena.reservedAgents, 'number');
      assert.equal(typeof opsHealth.publicArena.queueRunning, 'boolean');
      const baselineData = await waitFor(async () => {
        const res = await fetch(`${url}/api/ops/match-baseline?mode=mafia`);
        const data = await res.json();
        return data?.ok && Number(data.baseline?.sampleSize || 0) >= 1 ? data : null;
      }, 6000, 75);
      assert.ok(baselineData, 'expected at least one completed Mafia match');

      const agentStatusRes = await fetch(`${url}/api/agents/${agents[0].agentId}`);
      const agentStatusData = await agentStatusRes.json();
      assert.equal(agentStatusData.ok, true);
      assert.equal(agentStatusData.agent.arena.runtimeConnected, true);
      assert.ok(['idle', 'in_match'].includes(agentStatusData.agent.arena.queueStatus));
      assert.equal(Number(agentStatusData.agent.mmr || 0) >= 0, true);
      assert.equal(Number(agentStatusData.agent.ratedMatches || 0) >= 1, true);
      assert.equal('peakMmr' in agentStatusData.agent, true);
      assert.equal('isProvisional' in agentStatusData.agent, true);

      assert.equal(baselineData.baseline.mode, 'mafia');
      assert.equal(baselineData.baseline.sampleSize >= 1, true);
      assert.equal(Number(baselineData.baseline.avgDurationMs || 0) > 0, true);
      assert.equal(Number(baselineData.baseline.estimatedGamesPerHour || 0) > 0, true);

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
      assert.equal('arenaUrl' in leaderboardData.topAgents[0], true);
      assert.equal(leaderboardData.topAgents[0].watchUrl, null);

      const ratingsHealthRes = await fetch(`${url}/api/ops/ratings/health?mode=mafia`);
      const ratingsHealthData = await ratingsHealthRes.json();
      assert.equal(ratingsHealthData.ok, true);
      assert.equal(ratingsHealthData.health.mode, 'mafia');
      assert.equal(Number(ratingsHealthData.health.sampleSize || 0) >= 1, true);

      const matchesRes = await fetch(`${url}/api/matches?userId=${encodeURIComponent(agents[0].agentId)}&limit=5`);
      const matchesData = await matchesRes.json();
      assert.equal(matchesData.ok, true);
      assert.equal(Array.isArray(matchesData.matches), true);
      assert.equal(matchesData.matches.length >= 1, true);
      assert.ok(['mafia', 'town'].includes(matchesData.matches[0].winner));
      assert.match(matchesData.matches[0].replayUrl, /\/api\/rooms\/.+\/replay\?mode=mafia/);

      const replayRes = await fetch(`${url}/api/rooms/${encodeURIComponent(seatedRoomId)}/replay?mode=mafia`);
      const replayData = await replayRes.json();
      assert.equal(replayData.ok, true);
      assert.equal(replayData.room.id, seatedRoomId);
      assert.equal(replayData.summary.roomId, seatedRoomId);
      assert.equal(Array.isArray(replayData.highlights), true);
      assert.equal(Array.isArray(replayData.turns), true);
      assert.equal(Array.isArray(replayData.timeline), true);
      assert.equal(replayData.timeline.length >= 1, true);
      assert.equal(typeof replayData.summary.headline, 'string');
      assert.equal(typeof replayData.summary.durationLabel, 'string');

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
      assert.match(mineMatchesData.matches[0].replayUrl, /\/api\/rooms\/.+\/replay\?mode=mafia/);
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
