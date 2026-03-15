const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

process.env.MAFIA_NIGHT_MS = '80';
process.env.MAFIA_DISCUSSION_MS = '80';
process.env.MAFIA_VOTING_MS = '80';
process.env.AUTH_RATE_LIMIT_MAX = '20';

const {
  server,
  mafiaRooms,
  agentProfiles,
  liveAgentRuntimes,
  roomEvents,
  createPublicArenaMafiaRoom,
  buildMatchBaseline,
  clearAllGameTimers,
  resetPlayTelemetry,
  resetAgentArenaRuntime,
} = require('../server');

async function withServer(fn) {
  mafiaRooms.clear();
  agentProfiles.clear();
  liveAgentRuntimes.clear();
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

async function createRuntimeAgent(url, name, { sessionToken } = {}) {
  // Register a user account if no token provided
  let token = sessionToken;
  if (!token) {
    const regRes = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${name.toLowerCase()}@example.com`, displayName: name }),
    });
    const regData = await regRes.json();
    assert.equal(regData.ok, true);
    token = regData.session.token;
  }

  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // Create a pending agent
  const createRes = await fetch(`${url}/api/openclaw/create-agent`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  const createData = await createRes.json();
  assert.equal(createData.ok, true);
  const agentId = createData.agentId;

  // Activate via callback
  const callbackRes = await fetch(`${url}/api/openclaw/callback`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      agentId,
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
    socket.emit('mafia:agent:decision', {
      roomId: payload.roomId,
      playerId: payload.playerId,
      phase: payload.phase,
      type: 'ready',
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
      token,
      agentId,
    }, resolve);
  });
  assert.equal(register.ok, true);

  return {
    socket,
    agentId: callbackData.agent.id,
    token,
    getAssignedRoomId: () => assignedRoomId,
    getPlayerId: () => playerId,
  };
}

test('six runtime-connected agents auto-seat into a live Mafia match and finish it', async () => {
  await withServer(async (url) => {
    const agents = [];
    try {
      const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
      for (const name of names) {
        agents.push(await createRuntimeAgent(url, name));
      }
      const sessionToken = agents[0].token;

      const seatedRoomId = await waitFor(async () => {
        const roomIds = agents.map((agent) => agent.getAssignedRoomId()).filter(Boolean);
        return roomIds.length >= 6 ? roomIds[0] : null;
      }, 4000, 25);
      assert.ok(seatedRoomId, 'expected all six agents to receive a room assignment');

      const watchRes = await fetch(`${url}/api/play/watch`);
      const watchData = await watchRes.json();
      assert.equal(watchData.ok, true);

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
      assert.equal('queueStatus' in leaderboardData.topAgents[0], true);
      assert.equal('isLive' in leaderboardData.topAgents[0], true);
      assert.equal('watchUrl' in leaderboardData.topAgents[0], true);

      const matchesRes = await fetch(`${url}/api/matches?userId=${encodeURIComponent(agents[0].agentId)}&limit=5`);
      const matchesData = await matchesRes.json();
      assert.equal(matchesData.ok, true);
      assert.equal(Array.isArray(matchesData.matches), true);
      assert.equal(matchesData.matches.length >= 1, true);
      assert.ok(['mafia', 'town'].includes(matchesData.matches[0].winner));

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
      assert.equal(mineData.agents.length >= 1, true);
      assert.equal(mineData.agents[0].id, agents[0].agentId);
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
