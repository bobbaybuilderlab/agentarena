// public/guess-the-agent.js
'use strict';

const API = (window.__RUNTIME_CONFIG__ || {}).API_URL || window.location.origin;
const SOCKET_URL = (window.__RUNTIME_CONFIG__ || {}).SOCKET_URL || window.location.origin;

const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });

let myPlayerId = null;
let myRoomId = null;
let myRole = null;
let myName = '';
let currentState = null;
let timerInterval = null;
let reconnectInterval = null;
let hasVoted = false;
let hasVotedRound = null;

const $ = (id) => document.getElementById(id);

// ─── URL params ─────────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const urlRoom = params.get('room');
const urlName = params.get('name');

if (urlRoom) $('joinRoom').value = urlRoom;
if (urlName) $('joinName').value = urlName;

// ─── Socket connection ──────────────────────────────────────────────────────
socket.on('connect', () => {
  hideReconnectBanner();
  const saved = sessionStorage.getItem('gta-player');
  if (saved) {
    const data = JSON.parse(saved);
    if (data.roomId) {
      socket.emit('gta:room:join', { roomId: data.roomId, name: data.name }, (cb) => {
        if (cb && cb.ok) {
          myPlayerId = cb.playerId;
          myRoomId = cb.roomId;
          myRole = cb.role;
        }
      });
    }
  }
});

socket.on('disconnect', () => {
  showReconnectBanner();
});

socket.on('gta:state', (state) => {
  currentState = state;
  render(state);
  if (state.roundEndsAt) startTimer(state.roundEndsAt);
});

socket.on('gta:state:self', (state) => {
  const me = state.players.find(p => p.id === myPlayerId);
  if (me?.role) myRole = me.role;
  currentState = state;
  render(state);
});

// ─── Join / Create ──────────────────────────────────────────────────────────
window.handleJoinOrCreate = function () {
  const name = $('joinName').value.trim();
  const roomCode = $('joinRoom').value.trim().toUpperCase();
  if (!name) return showJoinError('Please enter your name.');
  myName = name;

  $('joinBtn').disabled = true;
  $('joinBtn').textContent = 'Connecting...';

  if (roomCode) {
    socket.emit('gta:room:join', { roomId: roomCode, name }, (cb) => {
      $('joinBtn').disabled = false;
      $('joinBtn').textContent = 'Join / Create Room';
      if (!cb || !cb.ok) return showJoinError(cb?.error?.message || 'Failed to join room.');
      onJoined(cb);
    });
  } else {
    socket.emit('gta:room:create', { name }, (cb) => {
      $('joinBtn').disabled = false;
      $('joinBtn').textContent = 'Join / Create Room';
      if (!cb || !cb.ok) return showJoinError(cb?.error?.message || 'Failed to create room.');
      onJoined(cb);
    });
  }
};

function onJoined(cb) {
  myPlayerId = cb.playerId;
  myRoomId = cb.roomId;
  myRole = cb.role;
  sessionStorage.setItem('gta-player', JSON.stringify({ roomId: myRoomId, name: myName }));
  showJoinError('');
  if (myRole) showRoleReveal(myRole);
}

function showJoinError(msg) {
  const el = $('joinError');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

// ─── Role Reveal ────────────────────────────────────────────────────────────
function showRoleReveal(role) {
  const modal = $('roleModal');
  modal.innerHTML = role === 'human'
    ? '<div class="role-card role-human"><div style="font-size:3rem;">&#129323;</div><h2>You are the Human</h2><p>Blend in. Write like an AI. Don\'t get voted out.</p><button class="btn btn-primary" onclick="dismissRoleModal()">I Understand</button></div>'
    : '<div class="role-card role-agent"><div style="font-size:3rem;">&#129302;</div><h2>You are an Agent</h2><p>Find the human. One player is not like the others. Vote them out.</p><button class="btn btn-primary" onclick="dismissRoleModal()">I Understand</button></div>';
  modal.hidden = false;
}

window.dismissRoleModal = function () {
  $('roleModal').hidden = true;
};

// ─── Reconnect ──────────────────────────────────────────────────────────────
function showReconnectBanner() {
  $('reconnectBanner').hidden = false;
  let remaining = 30;
  $('reconnectCountdown').textContent = remaining;
  if (reconnectInterval) clearInterval(reconnectInterval);
  reconnectInterval = setInterval(() => {
    remaining--;
    $('reconnectCountdown').textContent = remaining;
    if (remaining <= 0) {
      clearInterval(reconnectInterval);
      $('reconnectBanner').innerHTML = '<p>Connection lost. Agents may have won.</p>';
    }
  }, 1000);
}

function hideReconnectBanner() {
  $('reconnectBanner').hidden = true;
  if (reconnectInterval) clearInterval(reconnectInterval);
}

// ─── Lobby Actions ──────────────────────────────────────────────────────────
window.doAutofill = function () {
  socket.emit('gta:autofill', { roomId: myRoomId, playerId: myPlayerId, minPlayers: 6 }, (cb) => {
    if (!cb?.ok) console.warn('Autofill failed:', cb?.error);
  });
};

window.doStart = function () {
  socket.emit('gta:start', { roomId: myRoomId, playerId: myPlayerId }, (cb) => {
    if (!cb?.ok) console.warn('Start failed:', cb?.error);
  });
};

window.copyRoomLink = function () {
  const url = `${window.location.origin}/guess-the-agent.html?room=${myRoomId}`;
  navigator.clipboard.writeText(url).catch(() => {});
  const btn = event.target;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy Link'; }, 1500);
};

// ─── Submit Response ────────────────────────────────────────────────────────
window.submitResponse = function () {
  const text = $('responseInput').value.trim();
  if (!text) return;
  $('submitResponseBtn').disabled = true;
  $('submitResponseBtn').textContent = 'Submitted ✓';
  socket.emit('gta:action', { roomId: myRoomId, playerId: myPlayerId, type: 'respond', text }, (cb) => {
    if (!cb?.ok) {
      $('submitResponseBtn').disabled = false;
      $('submitResponseBtn').textContent = 'Submit Response';
    }
  });
};

// Char counter
$('responseInput').addEventListener('input', () => {
  const len = $('responseInput').value.length;
  $('charCount').textContent = len;
  $('charCount').parentElement.className = len > 280 ? 'char-count over' : 'char-count';
});

// ─── Vote ───────────────────────────────────────────────────────────────────
window.castVote = function castVote(targetId) {
  if (hasVoted) return;
  hasVoted = true;
  socket.emit('gta:action', { roomId: myRoomId, playerId: myPlayerId, type: 'vote', targetId }, (cb) => {
    if (!cb?.ok) hasVoted = false;
  });
};

// ─── Rematch ────────────────────────────────────────────────────────────────
window.doRematch = function () {
  socket.emit('gta:rematch', { roomId: myRoomId, playerId: myPlayerId }, (cb) => {
    if (cb?.ok) hasVoted = false;
  });
};

window.goHome = function () {
  sessionStorage.removeItem('gta-player');
  window.location.href = '/';
};

// ─── Timer ──────────────────────────────────────────────────────────────────
function startTimer(endsAt) {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const now = Date.now();
    const remaining = Math.max(0, endsAt - now);
    const total = getTotalPhaseMs();
    const pct = total > 0 ? (remaining / total) * 100 : 0;
    const secs = Math.ceil(remaining / 1000);
    const label = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const isUrgent = secs <= 10;

    if (currentState) {
      const phase = currentState.phase;
      const barId = phase === 'prompt' ? 'promptTimerBar' : phase === 'reveal' ? 'revealTimerBar' : phase === 'vote' ? 'voteTimerBar' : null;
      const textId = phase === 'prompt' ? 'promptTimerText' : phase === 'reveal' ? 'revealTimerText' : phase === 'vote' ? 'voteTimerText' : null;
      if (barId) {
        const bar = $(barId);
        bar.style.width = pct + '%';
        bar.className = isUrgent ? 'gta-timer-bar urgent' : 'gta-timer-bar';
      }
      if (textId) $(textId).textContent = label;
    }

    if (remaining <= 0) clearInterval(timerInterval);
  }, 250);
}

function getTotalPhaseMs() {
  if (!currentState) return 45000;
  switch (currentState.phase) {
    case 'prompt': return 45000;
    case 'reveal': return 15000;
    case 'vote': return 20000;
    default: return 45000;
  }
}

// ─── Render ─────────────────────────────────────────────────────────────────
function render(state) {
  if (!state) return;

  // Show correct phase
  document.querySelectorAll('.phase').forEach(el => el.classList.remove('active'));

  const phase = state.phase;

  if (phase === 'lobby') {
    $('phase-lobby').classList.add('active');
    renderLobby(state);
  } else if (phase === 'prompt') {
    $('phase-prompt').classList.add('active');
    renderPrompt(state);
  } else if (phase === 'reveal') {
    $('phase-reveal').classList.add('active');
    renderReveal(state);
  } else if (phase === 'vote') {
    $('phase-vote').classList.add('active');
    renderVote(state);
  } else if (phase === 'result') {
    $('phase-result').classList.add('active');
    renderResult(state);
  } else if (phase === 'finished') {
    $('phase-finished').classList.add('active');
    renderFinished(state);
  } else {
    $('phase-join').classList.add('active');
  }
}

function renderLobby(state) {
  $('lobbyRoomId').textContent = state.id;
  $('lobbyPlayerCount').textContent = `Players (${state.players.length}/6)`;

  const isHost = state.hostPlayerId === myPlayerId;
  $('lobbyActions').style.display = isHost ? 'flex' : 'none';
  $('lobbyWaiting').style.display = isHost ? 'none' : 'block';

  $('lobbyPlayerList').innerHTML = state.players.map(p => {
    const isMe = p.id === myPlayerId;
    const icon = isMe ? (myRole === 'human' ? '&#129323;' : '&#129302;') : '&#128101;';
    return `<div class="gta-player">
      <span>${icon}</span>
      <span class="gta-player-name">${esc(p.name)}</span>
      ${isMe ? '<span class="badge-you">You</span>' : ''}
      <span class="gta-dot ${p.isConnected ? 'online' : 'offline'}"></span>
    </div>`;
  }).join('') + (state.players.length < 6 ? '<div class="gta-player" style="opacity:0.3;"><span>—</span><span>Empty slot</span></div>'.repeat(6 - state.players.length) : '');
}

function renderPrompt(state) {
  $('promptRoundLabel').textContent = `Round ${state.round} of ${state.maxRounds}`;
  $('promptText').textContent = state.currentPrompt || '';

  // Show hint for human
  $('humanHint').hidden = myRole !== 'human';

  // Clear textarea for new round
  $('responseInput').value = '';
  $('charCount').textContent = '0';

  // Reset submit button if new round
  const responses = state.responsesByRound?.[state.round];
  const hasResponded = responses && myPlayerId && responses[myPlayerId];
  if (!hasResponded) {
    $('submitResponseBtn').disabled = false;
    $('submitResponseBtn').textContent = 'Submit Response';
  } else {
    $('submitResponseBtn').disabled = true;
    $('submitResponseBtn').textContent = 'Submitted ✓';
  }

  // Submit status dots
  const alive = state.players.filter(p => p.alive);
  const submitted = responses ? Object.keys(responses).length : 0;
  $('submitStatus').innerHTML = alive.map((_, i) =>
    `<span class="submit-dot ${i < submitted ? 'filled' : ''}"></span>`
  ).join('');
}

function renderReveal(state) {
  $('revealRoundLabel').textContent = `Round ${state.round} of ${state.maxRounds} — Responses`;
  const responses = state.responsesByRound?.[state.round];
  if (!responses) {
    $('revealResponses').innerHTML = '<p class="text-muted">Waiting for responses...</p>';
    return;
  }
  const labels = Object.keys(responses).sort();
  $('revealResponses').innerHTML = labels.map((label, i) => `
    <div class="gta-response-card" style="animation-delay:${i * 100}ms">
      <div class="gta-response-header">
        <span class="gta-response-label">Response ${label}</span>
      </div>
      <p class="gta-response-text">"${esc(responses[label])}"</p>
    </div>
  `).join('');
}

function renderVote(state) {
  $('voteRoundLabel').textContent = `Round ${state.round} of ${state.maxRounds} — Who is the Human?`;
  if (hasVotedRound !== state.round) {
    hasVoted = false;
    hasVotedRound = state.round;
  }

  const responses = state.responsesByRound?.[state.round] || {};
  const alivePlayers = state.players.filter(p => p.alive);

  // Count visible votes (tally from agent votes)
  const votes = state.votesByRound?.[state.round] || {};
  const tally = {};
  for (const [voterId, targetId] of Object.entries(votes || {})) {
    if (typeof targetId === 'string') {
      tally[targetId] = (tally[targetId] || 0) + 1;
    }
  }

  $('voteCards').innerHTML = alivePlayers.map(p => {
    const isMe = p.id === myPlayerId;
    const response = responses[p.id] || '';
    const voteCount = tally[p.id] || 0;
    const canVote = !isMe && myRole === 'agent';
    // Human can see vote buttons but they're cosmetic (server blocks)
    const showVoteBtn = !isMe;
    return `
    <div class="gta-response-card" data-player-id="${p.id}">
      <div class="gta-response-header">
        <span class="gta-response-name">${esc(p.name)}${isMe ? ' <span class="badge-you">You</span>' : ''}</span>
        <span class="gta-vote-count">${voteCount > 0 ? voteCount + ' vote' + (voteCount > 1 ? 's' : '') : ''}</span>
      </div>
      <p class="gta-response-text">"${esc(response)}"</p>
      ${showVoteBtn ? `<button class="gta-vote-btn" data-vote-target="${esc(p.id)}">Vote</button>` : ''}
    </div>`;
  }).join('');

  // Delegated click handler for vote buttons
  $('voteCards').querySelectorAll('.gta-vote-btn[data-vote-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-vote-target');
      if (targetId) window.castVote(targetId);
    });
  });

  const totalAgents = alivePlayers.filter(p => p.id !== myPlayerId || myRole !== 'human').length;
  const totalVotes = Object.values(tally).reduce((a, b) => a + b, 0);
  $('voteTally').textContent = `Votes cast: ${totalVotes}`;
}

function renderResult(state) {
  const eliminated = state.eliminatedByRound?.[state.round];
  const eliminatedPlayer = eliminated ? state.players.find(p => p.id === eliminated) : null;

  // Build vote tally for display
  const votes = state.votesByRound?.[state.round] || {};
  const tally = {};
  for (const [voterId, targetId] of Object.entries(votes)) {
    if (typeof targetId === 'string') {
      tally[targetId] = (tally[targetId] || 0) + 1;
    }
  }

  const sortedTally = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const maxVotes = sortedTally[0]?.[1] || 1;

  let html = '<div class="result-card">';
  if (eliminatedPlayer) {
    html += `<h3>&#10060; ${esc(eliminatedPlayer.name)} eliminated</h3>`;
    html += `<p style="color:var(--muted);font-size:13px;">${esc(eliminatedPlayer.name)} was an AI.</p>`;
  } else {
    html += '<h3>No majority. No one eliminated.</h3>';
  }

  html += '<div style="margin-top:1rem;">';
  for (const [targetId, count] of sortedTally) {
    const p = state.players.find(px => px.id === targetId);
    const pct = (count / maxVotes) * 100;
    html += `<div class="vote-bar"><span style="min-width:80px;">${esc(p?.name || '?')}</span><div class="vote-bar-fill" style="width:${pct}%;min-width:8px;"></div><span>${count}</span></div>`;
  }
  html += '</div>';

  if (state.status !== 'finished') {
    html += '<p style="color:var(--muted);font-size:13px;margin-top:1rem;">Next round starting...</p>';
  }
  html += '</div>';

  $('resultContent').innerHTML = html;
}

function renderFinished(state) {
  const isHumanWin = state.winner === 'human';
  const humanPlayer = state.players.find(p => p.id === state.humanPlayerId);
  const humanName = humanPlayer ? humanPlayer.name : 'Unknown';

  // Show dramatic overlay
  const overlay = $('revealOverlay');
  overlay.hidden = false;

  if (isHumanWin) {
    overlay.innerHTML = `
      <div style="animation:fadeIn 0.6s ease;">
        <h1 style="color:var(--gta-human);">&#129323; HUMAN WINS &#129323;</h1>
        <p style="color:var(--muted);margin-bottom:2rem;">${esc(humanName)} fooled ${state.players.filter(p => p.role === 'agent').length} AIs.</p>
        <div class="reveal-card">
          <div style="font-size:2rem;">&#127942;</div>
          <h2>${esc(humanName)}</h2>
          <p style="color:var(--muted);">Survived ${state.maxRounds} rounds</p>
        </div>
        <div style="margin-top:2rem;display:flex;gap:0.5rem;justify-content:center;">
          <button class="btn btn-primary" onclick="doRematch()">Play Again</button>
          <button class="btn btn-ghost" onclick="goHome()">Home</button>
        </div>
      </div>
    `;
  } else {
    overlay.innerHTML = `
      <div style="animation:fadeIn 0.6s ease;">
        <h1 style="color:var(--gta-agent);">&#129302; AGENTS WIN &#129302;</h1>
        <p style="color:var(--muted);margin-bottom:1rem;">The human was:</p>
        <div class="reveal-card">
          <div style="font-size:2rem;">&#129323;</div>
          <h2>${esc(humanName)}</h2>
        </div>
        <div style="margin-top:2rem;display:flex;gap:0.5rem;justify-content:center;">
          <button class="btn btn-primary" onclick="doRematch()">Play Again</button>
          <button class="btn btn-ghost" onclick="goHome()">Home</button>
        </div>
      </div>
    `;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
