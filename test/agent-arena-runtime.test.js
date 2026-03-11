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
  amongUsRooms,
  villaRooms,
  gtaRooms,
  agentProfiles,
  connectSessions,
  liveAgentRuntimes,
  roomEvents,
  clearAllGameTimers,
  resetPlayTelemetry,
  resetAgentArenaRuntime,
} = require('../server');

async function withServer(fn) {
  mafiaRooms.clear();
  amongUsRooms.clear();
  villaRooms.clear();
  gtaRooms.clear();
  agentProfiles.clear();
  connectSessions.clear();
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

async function createRuntimeAgent(url, name) {
  const connectSessionRes = await fetch(`${url}/api/openclaw/connect-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name.toLowerCase()}@example.com` }),
  });
  const connectSessionData = await connectSessionRes.json();
  assert.equal(connectSessionData.ok, true);

  const connect = connectSessionData.connect;
  const proofMatch = String(connect.command || '').match(/--proof\s+([^\s]+)/);
  const callbackProof = proofMatch?.[1] || '';
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
      token: connect.id,
      proof: callbackProof,
    }, resolve);
  });
  assert.equal(register.ok, true);

  return {
    socket,
    agentId: callbackData.agent.id,
    getAssignedRoomId: () => assignedRoomId,
    getPlayerId: () => playerId,
  };
}

test('six runtime-connected agents auto-seat into a live Mafia match and finish it', async () => {
  await withServer(async (url) => {
    const agents = [];
    try {
      for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']) {
        agents.push(await createRuntimeAgent(url, name));
      }

      let finishedState = null;
      await Promise.race(agents.map(({ socket }) => once(socket, 'mafia:state', 5000).then((state) => {
        if (state.status === 'finished') finishedState = state;
      }).catch(() => null)));

      const deadline = Date.now() + 5000;
      while (!finishedState && Date.now() < deadline) {
        for (const { socket } of agents) {
          try {
            const state = await once(socket, 'mafia:state', 800);
            if (state.status === 'finished') {
              finishedState = state;
              break;
            }
          } catch (_err) {
            // continue polling events
          }
        }
      }

      assert.ok(finishedState, 'expected a finished Mafia state');
      assert.equal(finishedState.players.length, 6);
      assert.ok(['mafia', 'town'].includes(finishedState.winner));

      const watchRes = await fetch(`${url}/api/play/watch`);
      const watchData = await watchRes.json();
      assert.equal(watchData.ok, true);

      const agentStatusRes = await fetch(`${url}/api/agents/${agents[0].agentId}`);
      const agentStatusData = await agentStatusRes.json();
      assert.equal(agentStatusData.ok, true);
      assert.equal(agentStatusData.agent.arena.runtimeConnected, true);
      assert.ok(['idle', 'in_match'].includes(agentStatusData.agent.arena.queueStatus));

      const baselineRes = await fetch(`${url}/api/ops/match-baseline?mode=mafia`);
      const baselineData = await baselineRes.json();
      assert.equal(baselineData.ok, true);
      assert.equal(baselineData.baseline.mode, 'mafia');
      assert.equal(baselineData.baseline.sampleSize >= 1, true);
      assert.equal(Number(baselineData.baseline.avgDurationMs || 0) > 0, true);
      assert.equal(Number(baselineData.baseline.estimatedGamesPerHour || 0) > 0, true);
    } finally {
      agents.forEach(({ socket }) => socket.disconnect());
    }
  });
});
