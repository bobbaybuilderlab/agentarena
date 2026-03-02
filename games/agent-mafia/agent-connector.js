/**
 * Agent Mafia Connector
 *
 * Socket.IO client that connects an LLM-powered agent to an Agent Mafia game.
 * The agent joins a room, announces itself as a live agent, and responds to
 * game prompts via callbacks that the agent owner implements.
 *
 * Usage:
 *   const { createMafiaAgent } = require('./agent-connector');
 *   const agent = createMafiaAgent({
 *     serverUrl: 'http://localhost:3000',
 *     agentName: 'MyAgent',
 *     onNightAction: async (prompt, ctx) => targetId,
 *     onDiscussion: async (prompt, ctx) => 'I think player X is suspicious',
 *     onVote: async (prompt, ctx) => targetId,
 *   });
 *   await agent.joinRoom('ABC123');
 *   // or: const roomId = await agent.createRoom();
 */

const { io } = require('socket.io-client');

function createMafiaAgent(options = {}) {
  const {
    serverUrl = 'http://localhost:3000',
    agentName = 'Agent',
    onNightAction,
    onDiscussion,
    onVote,
    onStateUpdate,
    onGameEnd,
    onError,
    profileMd = null,
  } = options;

  let socket = null;
  let roomId = null;
  let playerId = null;
  let connected = false;
  let pendingPrompt = null;

  function log(msg, data) {
    const ts = new Date().toISOString().slice(11, 19);
    if (data) console.log(`[${ts}] [MafiaAgent] ${msg}`, data);
    else console.log(`[${ts}] [MafiaAgent] ${msg}`);
  }

  function connect() {
    return new Promise((resolve, reject) => {
      socket = io(serverUrl, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
      });

      socket.on('connect', () => {
        connected = true;
        log(`Connected to ${serverUrl} (socket: ${socket.id})`);
        resolve(socket);
      });

      socket.on('connect_error', (err) => {
        log('Connection error:', err.message);
        if (!connected) reject(err);
        onError?.(err);
      });

      socket.on('disconnect', (reason) => {
        connected = false;
        log(`Disconnected: ${reason}`);
      });

      // Listen for game state updates
      socket.on('mafia:state', (state) => {
        onStateUpdate?.(state);
        if (state.status === 'finished') {
          log(`Game finished — winner: ${state.winner}`);
          onGameEnd?.(state);
        }
      });

      // Listen for agent-specific prompts from server
      socket.on('mafia:prompt', async (data) => {
        if (data.playerId !== playerId) return;
        log(`Received prompt: ${data.prompt.action} (phase: ${data.prompt.phase}, day: ${data.prompt.day})`);
        pendingPrompt = data.prompt;
        try {
          await handlePrompt(data);
        } catch (err) {
          log('Error handling prompt:', err.message);
          onError?.(err);
        }
      });
    });
  }

  async function handlePrompt(data) {
    const { prompt } = data;
    const ctx = { roomId, playerId, profileMd, socket };

    if (prompt.action === 'nightKill' && prompt.phase === 'night') {
      if (!onNightAction) return;
      const targetId = await onNightAction(prompt, ctx);
      if (targetId) {
        submitAction('nightKill', targetId);
      }
      return;
    }

    if (prompt.action === 'discussion' && prompt.phase === 'discussion') {
      if (onDiscussion) {
        const message = await onDiscussion(prompt, ctx);
        if (message) {
          // Discussion messages are emitted as chat events (if server supports)
          // For now, the agent submits 'ready' after generating its message
          log(`Discussion message: "${message}"`);
        }
      }
      // Always mark ready after discussion callback
      submitAction('ready', null);
      return;
    }

    if (prompt.action === 'vote' && prompt.phase === 'voting') {
      if (!onVote) return;
      const targetId = await onVote(prompt, ctx);
      if (targetId) {
        submitAction('vote', targetId);
      }
      return;
    }
  }

  function submitAction(type, targetId) {
    if (!socket || !roomId || !playerId) return;
    log(`Submitting action: ${type}${targetId ? ` → ${targetId}` : ''}`);
    socket.emit('mafia:action', { roomId, playerId, type, targetId }, (res) => {
      if (!res?.ok) {
        log(`Action failed: ${res?.error?.message || 'unknown error'}`);
        onError?.(new Error(res?.error?.message || 'Action failed'));
      }
    });
  }

  function emitWithCallback(event, data) {
    return new Promise((resolve, reject) => {
      socket.emit(event, data, (res) => {
        if (res?.ok) resolve(res);
        else reject(new Error(res?.error?.message || `${event} failed`));
      });
    });
  }

  async function createRoom() {
    if (!socket || !connected) await connect();
    log(`Creating room as "${agentName}"`);
    const res = await emitWithCallback('mafia:room:create', { name: agentName });
    roomId = res.roomId;
    playerId = res.playerId;
    log(`Room created: ${roomId} (playerId: ${playerId})`);

    // Mark self as live agent
    await emitWithCallback('mafia:agent:join', { roomId, playerId });
    log('Registered as live agent');

    return roomId;
  }

  async function joinRoom(targetRoomId) {
    if (!socket || !connected) await connect();
    log(`Joining room ${targetRoomId} as "${agentName}"`);
    const res = await emitWithCallback('mafia:room:join', { roomId: targetRoomId, name: agentName });
    roomId = res.roomId;
    playerId = res.playerId;
    log(`Joined room: ${roomId} (playerId: ${playerId})`);

    // Mark self as live agent
    await emitWithCallback('mafia:agent:join', { roomId, playerId });
    log('Registered as live agent');

    return { roomId, playerId };
  }

  async function autofill(minPlayers = 4) {
    if (!roomId || !playerId) throw new Error('Must join a room first');
    log(`Autofilling to ${minPlayers} players`);
    const res = await emitWithCallback('mafia:autofill', { roomId, playerId, minPlayers });
    log(`Added ${res.addedBots} bots`);
    return res;
  }

  async function startGame() {
    if (!roomId || !playerId) throw new Error('Must join a room first');
    log('Starting game');
    const res = await emitWithCallback('mafia:start', { roomId, playerId });
    log(`Game started — phase: ${res.state?.phase}`);
    return res;
  }

  function disconnect() {
    if (socket) {
      socket.disconnect();
      socket = null;
      connected = false;
      roomId = null;
      playerId = null;
      log('Disconnected');
    }
  }

  return {
    connect,
    createRoom,
    joinRoom,
    autofill,
    startGame,
    disconnect,
    get roomId() { return roomId; },
    get playerId() { return playerId; },
    get connected() { return connected; },
    get socket() { return socket; },
  };
}

module.exports = { createMafiaAgent };
