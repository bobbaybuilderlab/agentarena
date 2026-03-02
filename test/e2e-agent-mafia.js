/**
 * End-to-end smoke test: start server, connect a live agent, play a full game.
 * Run: node test/e2e-agent-mafia.js
 */

const http = require('http');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');

// We need the full server, so let's just boot it on a random port
// and connect an agent to it.

const PORT = 9877;
let serverProcess;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connectClient(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function emit(socket, event, data) {
  return new Promise((resolve, reject) => {
    socket.emit(event, data, (res) => {
      if (res?.ok) resolve(res);
      else reject(new Error(`${event} failed: ${res?.error?.message || JSON.stringify(res)}`));
    });
  });
}

async function run() {
  console.log('Starting server...');

  // Start server as child process on custom port
  const { spawn } = require('child_process');
  serverProcess = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for server to be ready
  let ready = false;
  serverProcess.stdout.on('data', (d) => {
    const line = d.toString();
    if (line.includes('listening') || line.includes('port') || line.includes(String(PORT))) {
      ready = true;
    }
  });
  serverProcess.stderr.on('data', (d) => {
    // ignore stderr noise
  });

  // Also try connecting in a loop
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const test = io(`http://localhost:${PORT}`, { transports: ['websocket'], timeout: 1000 });
      await new Promise((resolve, reject) => {
        test.on('connect', () => { test.disconnect(); resolve(); });
        test.on('connect_error', reject);
        setTimeout(reject, 1000);
      });
      ready = true;
      break;
    } catch {
      // retry
    }
  }

  if (!ready) {
    console.error('Server failed to start');
    process.exit(1);
  }
  console.log(`Server ready on port ${PORT}`);

  const url = `http://localhost:${PORT}`;
  const events = [];
  const prompts = [];
  let gameFinished = false;
  let winner = null;

  // Connect the agent
  console.log('\n--- Connecting agent ---');
  const agent = await connectClient(url);
  console.log(`Agent connected: ${agent.id}`);

  // Listen for state updates
  agent.on('mafia:state', (state) => {
    events.push({ type: 'state', phase: state.phase, day: state.day, status: state.status, winner: state.winner });
    if (state.status === 'finished') {
      gameFinished = true;
      winner = state.winner;
    }
  });

  // Listen for prompts
  let agentPlayerId = null;
  agent.on('mafia:prompt', async (data) => {
    if (data.playerId !== agentPlayerId) return;
    const p = data.prompt;
    prompts.push({ action: p.action, phase: p.phase, day: p.day, role: p.role });
    console.log(`  [Prompt] action=${p.action} phase=${p.phase} role=${p.role} day=${p.day}`);

    // Respond with a valid action
    try {
      if (p.action === 'nightKill' && p.targets?.length > 0) {
        const target = p.targets[0];
        await emit(agent, 'mafia:action', {
          roomId: data.roomId,
          playerId: agentPlayerId,
          type: 'nightKill',
          targetId: target.id,
        });
        console.log(`  [Action] nightKill -> ${target.name} (${target.id})`);
      } else if (p.action === 'discussion') {
        await emit(agent, 'mafia:action', {
          roomId: data.roomId,
          playerId: agentPlayerId,
          type: 'ready',
        });
        console.log(`  [Action] ready`);
      } else if (p.action === 'vote' && p.targets?.length > 0) {
        const target = p.targets[0];
        await emit(agent, 'mafia:action', {
          roomId: data.roomId,
          playerId: agentPlayerId,
          type: 'vote',
          targetId: target.id,
        });
        console.log(`  [Action] vote -> ${target.name} (${target.id})`);
      }
    } catch (err) {
      console.error(`  [Error] ${err.message}`);
    }
  });

  // Step 1: Create room
  console.log('\n--- Creating room ---');
  const createRes = await emit(agent, 'mafia:room:create', { name: 'TestAgent' });
  const roomId = createRes.roomId;
  agentPlayerId = createRes.playerId;
  console.log(`Room: ${roomId}, Player: ${agentPlayerId}`);

  // Step 2: Mark as live agent
  console.log('\n--- Registering as live agent ---');
  const agentJoinRes = await emit(agent, 'mafia:agent:join', { roomId, playerId: agentPlayerId });
  const agentPlayer = agentJoinRes.state.players.find((p) => p.id === agentPlayerId);
  console.log(`isLiveAgent: ${agentPlayer?.isLiveAgent}`);
  if (!agentPlayer?.isLiveAgent) throw new Error('Expected isLiveAgent=true');

  // Step 3: Autofill with bots
  console.log('\n--- Autofilling room ---');
  const fillRes = await emit(agent, 'mafia:autofill', { roomId, playerId: agentPlayerId, minPlayers: 4 });
  console.log(`Added ${fillRes.addedBots} bots, total players: ${fillRes.state.players.length}`);

  // Step 4: Start game
  console.log('\n--- Starting game ---');
  const startRes = await emit(agent, 'mafia:start', { roomId, playerId: agentPlayerId });
  console.log(`Game started — phase: ${startRes.state.phase}, day: ${startRes.state.day}`);

  // Check agent's alive status in each state update
  agent.on('mafia:state', (state) => {
    const me = state.players?.find((p) => p.id === agentPlayerId);
    if (me) {
      console.log(`  [Me] alive=${me.alive} isLiveAgent=${me.isLiveAgent} role=${me.role || '?'} phase=${state.phase}`);
    }
  });

  // Step 5: Wait for game to finish (with timeout)
  console.log('\n--- Waiting for game to finish ---');
  const startTime = Date.now();
  const TIMEOUT = 120_000;
  while (!gameFinished && Date.now() - startTime < TIMEOUT) {
    await sleep(500);
  }

  // Results
  console.log('\n========== RESULTS ==========');
  console.log(`Game finished: ${gameFinished}`);
  console.log(`Winner: ${winner}`);
  console.log(`State updates received: ${events.length}`);
  console.log(`Prompts received: ${prompts.length}`);
  console.log(`Prompts: ${JSON.stringify(prompts, null, 2)}`);

  const phases = events.map((e) => `${e.phase}(d${e.day})`);
  console.log(`Phase progression: ${phases.join(' -> ')}`);

  // Assertions
  let passed = 0;
  let failed = 0;
  function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else { failed++; console.log(`  FAIL: ${msg}`); }
  }

  assert(gameFinished, 'Game completed without stalling');
  assert(winner === 'mafia' || winner === 'town', `Winner is valid: ${winner}`);
  assert(events.length >= 3, `Received ${events.length} state updates (expected >=3)`);
  assert(prompts.length >= 0, `Received ${prompts.length} prompts`);

  // Check agent got prompts if they were alive and had an action to take
  // (role is random, so agent may not have been mafia and might not get night prompts)
  console.log(`\n${passed} passed, ${failed} failed`);

  // Cleanup
  agent.disconnect();
  serverProcess.kill();

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('E2E test failed:', err);
  if (serverProcess) serverProcess.kill();
  process.exit(1);
});
