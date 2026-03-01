// games/guess-the-agent/agent-connector.js
// Reference implementation: connect a live AI agent to a GTA room via Socket.IO
'use strict';

const { io } = require('socket.io-client');

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Connect a live AI agent to a Guess the Agent room.
 *
 * Usage:
 *   const agent = createAgentConnector({
 *     serverUrl: 'http://localhost:3000',
 *     roomId: 'ABCDEF',
 *     agentName: 'GPT-4o',
 *     onPrompt: async (prompt, ctx) => 'My response to the prompt',
 *     onVoteRequest: async (players, ctx) => players[0].id,
 *   });
 *   await agent.connect();
 *
 * @param {object} opts
 * @param {string} opts.serverUrl   - Server origin (e.g. http://localhost:3000)
 * @param {string} opts.roomId      - 6-char room code
 * @param {string} opts.agentName   - Display name for this agent (max 24 chars)
 * @param {function} opts.onPrompt  - async (prompt, ctx) => string response
 * @param {function} opts.onVoteRequest - async (alivePlayers, ctx) => targetPlayerId
 * @param {object}   [opts.socketOpts] - Extra socket.io-client options
 * @returns {{ connect, disconnect, socket, getState }}
 */
function createAgentConnector(opts) {
  const { serverUrl, roomId, agentName, onPrompt, onVoteRequest, socketOpts } = opts || {};

  if (!serverUrl) throw new Error('serverUrl is required');
  if (!roomId) throw new Error('roomId is required');
  if (!agentName) throw new Error('agentName is required');
  if (typeof onPrompt !== 'function') throw new Error('onPrompt must be a function');
  if (typeof onVoteRequest !== 'function') throw new Error('onVoteRequest must be a function');

  let playerId = null;
  let currentState = null;
  let connected = false;

  const socket = io(serverUrl, {
    transports: ['websocket', 'polling'],
    autoConnect: false,
    ...socketOpts,
  });

  function getState() { return currentState; }

  function connect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timed out'));
      }, DEFAULT_TIMEOUT_MS);

      socket.connect();

      socket.once('connect', () => {
        socket.emit('gta:room:join', { roomId, name: agentName }, (cb) => {
          clearTimeout(timeout);
          if (!cb || !cb.ok) {
            const msg = cb?.error?.message || 'Failed to join room';
            socket.disconnect();
            return reject(new Error(msg));
          }
          playerId = cb.playerId;
          connected = true;

          // Announce as live agent
          socket.emit('gta:agent:join', { roomId: cb.roomId, playerId });

          resolve({ roomId: cb.roomId, playerId, role: cb.role });
        });
      });

      socket.once('connect_error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  function disconnect() {
    connected = false;
    socket.disconnect();
  }

  // Track game state
  socket.on('gta:state', (state) => {
    currentState = state;
  });

  // Live agent prompt — server sends this during prompt phase
  socket.on('gta:prompt', async (data) => {
    if (!connected || !playerId) return;
    const { prompt, round, roomId: rid } = data;
    try {
      const ctx = { round, roomId: rid, playerId, state: currentState };
      const response = await onPrompt(prompt, ctx);
      if (typeof response === 'string' && response.trim()) {
        socket.emit('gta:action', { roomId: rid, playerId, type: 'respond', text: response.slice(0, 280) });
      }
    } catch (err) {
      console.error('[agent-connector] onPrompt error:', err.message);
    }
  });

  // Live agent vote request — server sends this during vote phase
  socket.on('gta:vote_request', async (data) => {
    if (!connected || !playerId) return;
    const { players, round, roomId: rid } = data;
    try {
      const alivePlayers = (players || []).filter(p => p.alive && p.id !== playerId);
      const ctx = { round, roomId: rid, playerId, state: currentState };
      const targetId = await onVoteRequest(alivePlayers, ctx);
      if (targetId) {
        socket.emit('gta:action', { roomId: rid, playerId, type: 'vote', targetId });
      }
    } catch (err) {
      console.error('[agent-connector] onVoteRequest error:', err.message);
    }
  });

  return { connect, disconnect, socket, getState };
}

module.exports = { createAgentConnector };
