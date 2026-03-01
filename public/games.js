const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? ''
  : 'https://agent-arena-production-2d75.up.railway.app';
const socket = io(BACKEND_URL);

const gameMode = document.getElementById('gameMode');
const playerName = document.getElementById('playerName');
const roomIdInput = document.getElementById('roomId');
const playStatus = document.getElementById('playStatus');
const playersView = document.getElementById('playersView');
const actionsView = document.getElementById('actionsView');
const stateJson = document.getElementById('stateJson');
const eventQueueStatus = document.getElementById('eventQueueStatus');
const canaryStatus = document.getElementById('canaryStatus');
const flushEventsBtn = document.getElementById('flushEventsBtn');

const hostBtn = document.getElementById('hostBtn');
const joinBtn = document.getElementById('joinBtn');
const startBtn = document.getElementById('startBtn');
const rematchBtn = document.getElementById('rematchBtn');
const autofillBtn = document.getElementById('autofillBtn');
const advanceBtn = document.getElementById('advanceBtn');
const quickMatchBtn = document.getElementById('quickMatchBtn');
const loadClaimsBtn = document.getElementById('loadClaimsBtn');
const runEvalsBtn = document.getElementById('runEvalsBtn');
const runCiGateBtn = document.getElementById('runCiGateBtn');
const evalStatus = document.getElementById('evalStatus');
const claimSeatsView = document.getElementById('claimSeatsView');
const ownerDigestCard = document.getElementById('ownerDigestCard');
const ownerDigestTitle = document.getElementById('ownerDigestTitle');
const ownerDigestSummary = document.getElementById('ownerDigestSummary');
const ownerDigestResult = document.getElementById('ownerDigestResult');
const ownerDigestAction = document.getElementById('ownerDigestAction');
const recoveryHint = document.getElementById('recoveryHint');
const lobbyUrgencyCard = document.getElementById('lobbyUrgencyCard');
const lobbyUrgencyTitle = document.getElementById('lobbyUrgencyTitle');
const lobbyUrgencyMeta = document.getElementById('lobbyUrgencyMeta');
const urgencyStepJoin = document.getElementById('urgencyStepJoin');
const urgencyStepHost = document.getElementById('urgencyStepHost');
const urgencyStepFill = document.getElementById('urgencyStepFill');
const urgencyStepStart = document.getElementById('urgencyStepStart');
const matchStatusLine = document.getElementById('matchStatusLine');
const matchRoom = document.getElementById('matchRoom');
const matchMode = document.getElementById('matchMode');
const matchPhase = document.getElementById('matchPhase');
const matchRound = document.getElementById('matchRound');
const matchAlive = document.getElementById('matchAlive');
const matchRoster = document.getElementById('matchRoster');
const gamePicker = document.getElementById('gamePicker');
const watchRandomBtn = document.getElementById('watchRandomBtn');

let me = { roomId: '', playerId: '', game: 'mafia' };
let currentState = null;
let attemptedAutoJoin = false;
let suggestedReclaim = null;
let attemptedSuggestedReclaim = false;
let pendingUiAction = false;
let rematchCountdownTimer = null;
let rematchCountdownSeconds = 0;

// ── Waiting overlay controller ──
const waitingTips = {
  mafia: [
    'The mafia knows each other — town must figure out who to trust.',
    'Pay attention to voting patterns. Consistent allies may be covering for each other.',
    'As mafia, blend in. Accuse others early to deflect suspicion.',
    'The doctor can save one player per night. Protect the most vocal town member.',
    'A quiet player isn\'t always innocent — silence can be a strategy.',
    'Discussion phase is your best weapon. Use it wisely.',
    'Watch who defends eliminated players — they may share allegiance.',
  ],
  amongus: [
    'Complete your tasks to win as crew — but watch your back.',
    'Impostors can sabotage. Fix critical systems before time runs out.',
    'Report suspicious behavior in meetings. Details matter.',
    'Stick with a buddy to create alibis, but trust no one completely.',
    'If you see someone vent, call a meeting immediately.',
    'Task completion progress is visible to everyone — fake-tasking is risky.',
    'Emergency meetings are limited. Save them for when you have real evidence.',
  ],
  villa: [
    'Pair strategically — your partner affects your survival chances.',
    'Twists can change everything. Stay adaptable.',
    'Public opinion matters. Build alliances before elimination rounds.',
    'Challenge performance can save you from the bottom.',
    'Recoupling is your chance to shift power dynamics.',
    'Don\'t reveal your full strategy too early — others are watching.',
    'The island rewards social players. Stay connected with everyone.',
  ],
};
let waitingTipTimer = null;
let waitingTipIndex = 0;
let waitingStartTime = 0;
let waitingPrevPlayerCount = 0;

function showWaitingOverlay(mode, playerCount, maxPlayers) {
  const overlay = document.getElementById('waitingOverlay');
  if (!overlay) return;
  overlay.style.display = '';
  overlay.classList.remove('waiting-exit');
  waitingStartTime = waitingStartTime || Date.now();
  updateWaitingPlayerCount(playerCount || 0, maxPlayers || 4);
  startWaitingTips(mode || me.game || 'mafia');
}

function hideWaitingOverlay() {
  const overlay = document.getElementById('waitingOverlay');
  if (!overlay || overlay.style.display === 'none') return;
  overlay.classList.add('waiting-exit');
  setTimeout(() => {
    overlay.style.display = 'none';
    overlay.classList.remove('waiting-exit');
  }, 500);
  stopWaitingTips();
  waitingStartTime = 0;
  waitingPrevPlayerCount = 0;
}

function updateWaitingPlayerCount(count, max) {
  const el = document.getElementById('waitingPlayerCount');
  if (!el) return;
  const text = count > 0 ? `${count} / ${max} players found` : 'Searching for players...';
  el.textContent = text;

  // Animate orbs based on found players
  for (let i = 1; i <= 4; i++) {
    const orb = document.querySelector(`.waiting-orb-${i}`);
    if (orb) {
      if (i <= count) orb.classList.add('orb-found');
      else orb.classList.remove('orb-found');
    }
  }

  if (count > waitingPrevPlayerCount && waitingPrevPlayerCount > 0) {
    el.classList.remove('count-updated');
    void el.offsetWidth; // force reflow
    el.classList.add('count-updated');
  }
  waitingPrevPlayerCount = count;

  // Update ETA
  const eta = document.getElementById('waitingEta');
  if (eta) {
    const elapsed = Math.floor((Date.now() - waitingStartTime) / 1000);
    if (count >= max) {
      eta.textContent = 'Match found — starting game...';
    } else if (elapsed < 10) {
      eta.textContent = 'Usually under 30 seconds';
    } else {
      const remaining = Math.max(5, 30 - elapsed);
      eta.textContent = `Estimated ~${remaining}s remaining`;
    }
  }
}

function startWaitingTips(mode) {
  stopWaitingTips();
  const tips = waitingTips[mode] || waitingTips.mafia;
  waitingTipIndex = Math.floor(Math.random() * tips.length);
  const tipEl = document.getElementById('waitingTipText');
  if (tipEl) tipEl.textContent = tips[waitingTipIndex];

  waitingTipTimer = setInterval(() => {
    if (!tipEl) return;
    tipEl.classList.add('tip-fading');
    setTimeout(() => {
      waitingTipIndex = (waitingTipIndex + 1) % tips.length;
      tipEl.textContent = tips[waitingTipIndex];
      tipEl.classList.remove('tip-fading');
    }, 300);
  }, 6000);
}

function stopWaitingTips() {
  if (waitingTipTimer) {
    clearInterval(waitingTipTimer);
    waitingTipTimer = null;
  }
}

function clearRematchCountdown() {
  if (rematchCountdownTimer) {
    clearInterval(rematchCountdownTimer);
    rematchCountdownTimer = null;
  }
  rematchCountdownSeconds = 0;
  const el = document.getElementById('rematchCountdown');
  if (el) el.remove();
}

function startRematchCountdown() {
  clearRematchCountdown();
  const mePlayer = currentState && meInState(currentState);
  if (!mePlayer) return;
  if (isSpectating()) return;

  rematchCountdownSeconds = 10;
  const container = document.getElementById('rematchCountdownContainer');
  if (!container) return;

  container.innerHTML = `<span id="rematchCountdown" class="rematch-countdown">Auto-rematch in <strong id="rematchCountdownNum">${rematchCountdownSeconds}s</strong> <button class="btn btn-ghost btn-sm rematch-cancel-btn" id="cancelRematchCountdown" type="button">Cancel</button></span>`;

  const cancelBtn = document.getElementById('cancelRematchCountdown');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      clearRematchCountdown();
    });
  }

  rematchCountdownTimer = setInterval(() => {
    rematchCountdownSeconds--;
    const numEl = document.getElementById('rematchCountdownNum');
    if (numEl) numEl.textContent = `${rematchCountdownSeconds}s`;
    if (rematchCountdownSeconds <= 0) {
      clearRematchCountdown();
      document.getElementById('rematchBtn')?.click();
    }
  }, 1000);
}

function selectedMode() {
  const value = String(gameMode?.value || me.game || 'mafia').toLowerCase();
  if (value === 'amongus' || value === 'villa') return value;
  return 'mafia';
}

function parseQueryConfig() {
  const params = new URLSearchParams(window.location.search || '');
  const queryGame = params.get('game') || params.get('mode');
  const queryRoom = params.get('room');
  const queryName = params.get('name');
  const reclaimName = params.get('reclaimName');
  const claimToken = params.get('claimToken');
  const quickJoinReason = params.get('qjReason');
  const reclaimHost = params.get('reclaimHost') === '1';
  const autojoin = params.get('autojoin') === '1';

  const normalizedQueryName = queryName ? String(queryName).trim().slice(0, 24) : '';
  const normalizedReclaimName = reclaimName ? String(reclaimName).trim().slice(0, 24) : '';

  if (queryGame === 'mafia' || queryGame === 'amongus' || queryGame === 'villa') {
    me.game = queryGame;
    if (gameMode) gameMode.value = queryGame;
  }

  if (queryRoom && roomIdInput) roomIdInput.value = String(queryRoom).trim().toUpperCase();
  if (normalizedReclaimName && playerName) {
    playerName.value = normalizedReclaimName;
  } else if (normalizedQueryName && playerName) {
    playerName.value = normalizedQueryName;
  }

  return {
    autojoin,
    queryName: normalizedQueryName,
    reclaimName: normalizedReclaimName,
    quickJoinReason: quickJoinReason ? String(quickJoinReason).trim().slice(0, 180) : '',
    reclaimHost,
    claimToken: claimToken ? String(claimToken).trim() : '',
  };
}

function emitAck(event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function setStatus(text, tone = 'info') {
  if (playStatus) playStatus.style.display = 'block';
  playStatus.textContent = text;
  playStatus.classList.remove('status-info', 'status-warn', 'status-error');
  if (tone === 'warn') playStatus.classList.add('status-warn');
  else if (tone === 'error') playStatus.classList.add('status-error');
  else playStatus.classList.add('status-info');
}

function withPendingUiAction(run) {
  if (pendingUiAction) return Promise.resolve(null);
  pendingUiAction = true;
  updateControlState(currentState);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      pendingUiAction = false;
      updateControlState(currentState);
    });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showRecoveryHint(html) {
  if (!recoveryHint) return;
  recoveryHint.innerHTML = html;
}

function defaultRecoveryHint() {
  showRecoveryHint('Recovery tip: if reconnect fails, keep the same room ID and click <strong>Find Reconnect Seats</strong> to reclaim your old name.');
}

function formatError(res, fallback) {
  if (!res) return fallback;
  const err = res.error || res;
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return fallback;
  const code = err.code ? `[${err.code}] ` : '';
  const msg = err.message || fallback;
  const details = err.details ? ` ${JSON.stringify(err.details)}` : '';
  return `${code}${msg}${details}`;
}

function activeEvent(name) {
  return `${me.game || 'mafia'}:${name}`;
}

function renderClaimSeats(data) {
  if (!claimSeatsView) return;
  const seats = data?.claimable || [];

  const suggestedButton = suggestedReclaim?.name
    ? `<button class="btn btn-primary" type="button" data-claim-name="${escapeHtml(suggestedReclaim.name)}" data-claim-suggested="1">Reclaim suggested seat: ${escapeHtml(suggestedReclaim.name)}${suggestedReclaim.hostSeat ? ' (host)' : ''}</button>`
    : '';

  if (!seats.length) {
    claimSeatsView.innerHTML = [
      suggestedButton || '<strong>No reclaimable seats in this room yet.</strong>',
      '<span>Try again in a few seconds, or quick-match into the fastest available room.</span>',
      '<button class="btn btn-soft" type="button" data-quick-recover="1">Quick match me now</button>',
    ].filter(Boolean).join(' ');
    return;
  }

  claimSeatsView.innerHTML = [
    '<strong>Reconnect seats found — claim your old identity:</strong>',
    suggestedButton,
    ...seats.map((seat) => `
      <button class="btn btn-soft" type="button" data-claim-name="${escapeHtml(seat.name)}">
        Claim ${escapeHtml(seat.name)}${seat.hostSeat ? ' (host)' : ''}
      </button>
    `),
  ].filter(Boolean).join(' ');
}

async function loadClaimableSeats() {
  const mode = selectedMode();
  const roomId = roomIdInput?.value?.trim().toUpperCase();
  if (!roomId) {
    setStatus('Enter room ID first');
    return;
  }

  try {
    const res = await fetch(`/api/play/lobby/claims?mode=${mode}&roomId=${encodeURIComponent(roomId)}`);
    const data = await res.json();
    if (!data?.ok) {
      claimSeatsView.textContent = formatError(data, 'Could not load reconnect seats');
      showRecoveryHint('Recovery tip: seat lookup failed. Confirm game + room ID, then retry.');
      return;
    }
    renderClaimSeats(data);
    showRecoveryHint('Recovery tip: reclaim your previous name to recover host rights, streaks, and continuity.');
  } catch (_err) {
    claimSeatsView.textContent = 'Could not load reconnect seats';
    showRecoveryHint('Recovery tip: temporary network issue. Retry in a few seconds.');
  }
}

async function sendReconnectTelemetry(outcome, event) {
  const mode = selectedMode();
  const roomId = (me.roomId || roomIdInput?.value || '').toString().trim().toUpperCase();
  if (!roomId) return;
  const payload = { mode, roomId };
  if (outcome) payload.outcome = outcome;
  if (event) payload.event = event;
  if (!payload.outcome && !payload.event) return;
  try {
    await fetch('/api/play/reconnect-telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (_err) {
    // best-effort telemetry only
  }
}

async function attemptSuggestedReclaimAuto() {
  if (attemptedSuggestedReclaim) return false;
  if (!suggestedReclaim?.name || !me.roomId) return false;
  attemptedSuggestedReclaim = true;

  const targetName = String(suggestedReclaim.name).trim();
  if (!targetName) return false;

  await sendReconnectTelemetry('attempt');

  const res = await emitAck(activeEvent('room:join'), {
    roomId: me.roomId,
    name: targetName,
  });

  if (!res?.ok) {
    await sendReconnectTelemetry('failure');
    setStatus(`Reconnect token expired/used. Auto-reclaim for ${targetName} failed; tap "Reclaim suggested seat" to retry.`);
    return false;
  }

  await sendReconnectTelemetry('success');
  me.roomId = res.roomId;
  me.playerId = res.playerId;
  suggestedReclaim = null;
  setStatus(`Auto-reclaimed suggested seat: ${targetName}${res.playerId === res.state?.hostPlayerId ? ' (host)' : ''}`);
  renderState(res.state);
  return true;
}

async function refreshOpsStatus() {
  if (eventQueueStatus) {
    try {
      const res = await fetch('/api/ops/events');
      const data = await res.json();
      if (data?.ok) eventQueueStatus.textContent = `Event queue: ${data.pending}`;
    } catch (_err) {
      eventQueueStatus.textContent = 'Event queue: unavailable';
    }
  }

  if (canaryStatus) {
    try {
      const res = await fetch('/api/ops/canary');
      const data = await res.json();
      if (data?.ok) {
        const cfg = data.config || {};
        const stats = data.stats || {};
        canaryStatus.textContent = `Canary policy: ${cfg.enabled ? 'on' : 'off'} @ ${cfg.percent || 0}% · decisions c=${stats.control?.decisions || 0} k=${stats.canary?.decisions || 0}`;
      }
    } catch (_err) {
      canaryStatus.textContent = 'Canary policy: unavailable';
    }
  }
}

function markUrgencyStep(el, done, label) {
  if (!el) return;
  el.textContent = `${done ? '✅' : '⏳'} ${label}`;
}

function updateLobbyUrgency(state, isHost) {
  if (!lobbyUrgencyCard || !state) return;
  const inLobby = state.status === 'lobby';
  lobbyUrgencyCard.style.display = inLobby ? 'block' : 'none';
  if (!inLobby) return;

  const players = state.players || [];
  const joined = Boolean(me.playerId);
  const hostOnline = players.some((p) => p.id === state.hostPlayerId && p.isConnected);
  const full = players.length >= 4;
  const createdAt = Number(state.createdAt || Date.now());
  const ageSec = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  const etaSec = full ? 0 : Math.max(0, (4 - players.length) * 45 - Math.min(ageSec, 120));

  markUrgencyStep(urgencyStepJoin, joined, 'Join room');
  markUrgencyStep(urgencyStepHost, hostOnline, 'Host online');
  markUrgencyStep(urgencyStepFill, full, '4 players ready');
  markUrgencyStep(urgencyStepStart, isHost && full && hostOnline, 'Start-ready now');

  if (lobbyUrgencyTitle) {
    lobbyUrgencyTitle.textContent = full ? 'Lobby can launch now' : `Need ${Math.max(0, 4 - players.length)} more to start`;
  }
  if (lobbyUrgencyMeta) {
    lobbyUrgencyMeta.textContent = full
      ? (isHost ? 'You can launch immediately with Start Ready.' : 'Waiting for host to launch…')
      : `Join urgency: ${etaSec}s est. to ready at current fill pace.`;
  }
}

function meInState(state) {
  if (!state || !me.playerId) return null;
  return (state.players || []).find((p) => p.id === me.playerId) || null;
}

function isSpectating() {
  const params = new URLSearchParams(window.location.search || '');
  return params.get('spectate') === '1';
}

function getAdvanceConfig(state) {
  if (!state || state.status !== 'in_progress') {
    return { enabled: false, label: 'Advance', title: 'Available during live matches only' };
  }
  if (!me.roomId || !me.playerId) {
    return { enabled: false, label: 'Advance', title: 'Join a room first' };
  }
  const mePlayer = meInState(state);
  if (!mePlayer) {
    return { enabled: false, label: 'Advance', title: 'You are spectating this state update' };
  }
  if (mePlayer.alive === false) {
    return { enabled: false, label: 'Spectating', title: 'Eliminated players cannot submit actions' };
  }

  if (me.game === 'mafia' && state.phase === 'discussion') {
    return {
      enabled: true,
      label: 'Ready up',
      title: 'Mark ready to move discussion into voting',
      event: 'mafia:action',
      payload: { roomId: me.roomId, playerId: me.playerId, type: 'ready' },
    };
  }

  if (me.game === 'amongus' && state.phase === 'tasks') {
    return {
      enabled: true,
      label: 'Call meeting',
      title: 'Force a meeting from the task phase',
      event: 'amongus:action',
      payload: { roomId: me.roomId, playerId: me.playerId, type: 'callMeeting' },
    };
  }

  return { enabled: false, label: 'Advance', title: 'No manual phase action needed right now' };
}

function updateControlState(state) {
  const players = state?.players || [];
  const spectating = isSpectating() || (me.roomId && state && !meInState(state));
  const isHost = !spectating && !!(state?.hostPlayerId && me.playerId && state.hostPlayerId === me.playerId);
  const inLobby = state?.status === 'lobby';
  const finished = state?.status === 'finished';
  const inProgress = state?.status === 'in_progress';
  const minPlayersReady = players.length >= 4;
  const disconnectedHumans = players.filter((p) => !p.isBot && !p.isConnected);
  const mePlayer = meInState(state);

  if (spectating) {
    if (startBtn) { startBtn.disabled = true; startBtn.title = 'Spectating'; }
    if (autofillBtn) { autofillBtn.disabled = true; }
    if (rematchBtn) { rematchBtn.disabled = true; }
    if (advanceBtn) { advanceBtn.disabled = true; advanceBtn.textContent = 'Spectating'; }
    if (hostBtn) { hostBtn.disabled = true; }
    if (joinBtn) { joinBtn.disabled = true; }
    setStatus(`Spectating — watching this game live. ${players.length} player(s)`, 'info');
    return;
  }
  const advance = getAdvanceConfig(state);

  if (gameMode) {
    const lockMode = Boolean(state && me.roomId);
    gameMode.disabled = lockMode;
    gameMode.title = lockMode ? 'Mode is locked to your current room session' : '';
  }

  if (hostBtn) {
    hostBtn.disabled = pendingUiAction;
  }

  if (joinBtn) {
    joinBtn.disabled = pendingUiAction;
  }

  if (quickMatchBtn) {
    quickMatchBtn.disabled = pendingUiAction;
  }

  if (startBtn) {
    startBtn.disabled = pendingUiAction || !isHost || !inLobby;
    startBtn.title = !isHost ? 'Host only' : !inLobby ? 'Game already started' : 'Auto-fills bots + replaces disconnected lobby players';
    startBtn.textContent = inLobby ? 'Start Ready' : 'Start';
  }

  if (autofillBtn) {
    autofillBtn.disabled = pendingUiAction || !isHost || !inLobby;
    autofillBtn.title = !isHost ? 'Host only' : !inLobby ? 'Only available in lobby' : '';
  }

  if (rematchBtn) {
    rematchBtn.disabled = pendingUiAction || !isHost || !finished;
    rematchBtn.title = !isHost ? 'Host only' : !finished ? 'Available after game ends' : '';
  }

  if (advanceBtn) {
    advanceBtn.disabled = pendingUiAction || !advance.enabled;
    advanceBtn.title = advance.title || '';
    advanceBtn.textContent = advance.label;
  }

  updateLobbyUrgency(state, isHost);

  if (!isHost && inLobby) {
    setStatus(`Waiting for host to start · players ${players.length}/4`, 'warn');
  } else if (isHost && inLobby) {
    const reasons = [];
    if (!minPlayersReady) reasons.push(`needs ${Math.max(0, 4 - players.length)} more player(s)`);
    if (disconnectedHumans.length > 0) reasons.push(`${disconnectedHumans.length} disconnected player(s) will be replaced`);
    if (reasons.length > 0) {
      setStatus(`Start Ready check: ${reasons.join(' · ')}`, 'warn');
    } else {
      setStatus('Lobby ready. Start Ready launches immediately.', 'info');
    }
  } else if (inProgress && mePlayer?.alive === false) {
    setStatus('You are eliminated and now spectating. Watch the match finish, then run rematch.', 'warn');
  }
}

let prevStateForSfx = null;

function renderState(state) {
  // Sound effects based on state transitions
  if (prevStateForSfx && state) {
    const prevPhase = prevStateForSfx.phase || prevStateForSfx.status;
    const newPhase = state.phase || state.status;
    const prevStatus = prevStateForSfx.status;
    const newStatus = state.status;

    if (prevStatus === 'lobby' && newStatus === 'in_progress') sfxGameStart();
    else if (newStatus === 'finished' && prevStatus !== 'finished') sfxWin();
    else if (prevPhase !== newPhase && newStatus === 'in_progress') sfxPhaseChange();

    // Detect elimination: player went from alive to not alive
    const prevAlive = new Set((prevStateForSfx.players || []).filter(p => p.alive !== false).map(p => p.id));
    const newDead = (state.players || []).filter(p => p.alive === false && prevAlive.has(p.id));
    if (newDead.length > 0) sfxElimination();
  }
  prevStateForSfx = state ? { ...state } : null;

  currentState = state;
  if (gamePicker) gamePicker.style.display = 'none';
  const matchHudSection = document.getElementById('matchHudSection');
  const gameContentSection = document.getElementById('gameContentSection');
  if (matchHudSection) matchHudSection.style.display = '';
  if (gameContentSection) gameContentSection.style.display = '';

  // Waiting overlay: show during lobby, hide on game start/finish
  const playerCount = (state.players || []).length;
  const maxPlayers = 4;
  if (state.status === 'lobby') {
    showWaitingOverlay(me.game, playerCount, maxPlayers);
  } else {
    hideWaitingOverlay();
  }
  stateJson.textContent = JSON.stringify(state, null, 2);
  if (state.botAutoplay) {
    const pending = Number(state.autoplay?.pendingActions || 0);
    const aliveBots = Number(state.autoplay?.aliveBots || 0);
    const hint = state.autoplay?.hint || `Bot autopilot active · ${state.phase || state.status}`;
    setStatus(`🤖 ${hint} · pending ${pending} · alive bots ${aliveBots}`, 'info');
  }
  updateControlState(state);
  updateMatchHud(state);
  renderPhaseTimeline(state);

  playersView.innerHTML = (state.players || []).map((p) => {
    const voteCount = state.votesByRound?.[state.round]?.[p.id] || state.votes?.[p.id] || 0;
    const hasVoted = state.actions?.vote?.[p.id] || state.actions?.meeting?.[p.id];
    return `
    <article class="player-card ${p.id === state.hostPlayerId ? 'is-host' : ''} ${p.id === me.playerId ? 'is-me' : ''} ${p.alive === false ? 'is-dead' : ''}" ${p.alive === false ? 'style="opacity:0.5"' : ''}>
      <div class="player-head">
        <h3>${escapeHtml(p.name)}${p.id === me.playerId ? ' (you)' : ''}</h3>
        <span class="player-pill ${p.isBot ? 'pill-bot' : 'pill-human'}">${p.isBot ? 'bot' : 'human'}</span>
      </div>
      <div class="player-meta-row">
        <span class="player-state ${p.alive === false ? 'state-dead' : 'state-alive'}">${p.alive === false ? 'eliminated' : 'alive'}</span>
        <span class="player-state ${p.isConnected ? 'state-online' : 'state-offline'}">${p.isConnected ? 'online' : 'offline'}</span>
        ${p.id === state.hostPlayerId ? '<span class="player-state state-host">host</span>' : ''}
        ${hasVoted ? '<span class="player-state" style="color:var(--accent);">voted</span>' : ''}
      </div>
      <p class="player-role">${p.role ? `Role: ${roleLabel(p.role)}` : 'Role hidden'}</p>
      ${voteCount > 0 ? `<p class="player-meta" style="color:var(--accent-orange);">Votes: ${voteCount}</p>` : ''}
    </article>`;
  }).join('') || '<p>No players</p>';

  renderActions(state);
  renderOwnerDigest(state);
}


function renderPhaseTimeline(state) {
  const timeline = document.getElementById('phaseTimeline');
  const steps = document.getElementById('phaseSteps');
  if (!timeline || !steps) return;

  if (!state || state.status === 'lobby') {
    timeline.style.display = 'none';
    return;
  }

  timeline.style.display = 'block';
  const phases = me.game === 'mafia'
    ? ['lobby', 'night', 'discussion', 'voting', 'finished']
    : me.game === 'amongus'
    ? ['lobby', 'tasks', 'meeting', 'finished']
    : ['lobby', 'pairing', 'challenge', 'twist', 'recouple', 'elimination', 'finished'];

  const current = state.status === 'finished' ? 'finished' : (state.phase || state.status);
  const currentIdx = phases.indexOf(current);

  steps.innerHTML = phases.map((phase, i) => {
    const isActive = phase === current;
    const isDone = i < currentIdx;
    const cls = isActive ? 'phase-step active' : isDone ? 'phase-step done' : 'phase-step';
    return `<div class="${cls}">
      <div class="phase-dot"></div>
      <span>${phase.charAt(0).toUpperCase() + phase.slice(1)}</span>
    </div>`;
  }).join('<div class="phase-line"></div>');
}

function roleLabel(role) {
  if (role === 'mafia') return 'Mafia';
  if (role === 'town') return 'Town';
  if (role === 'imposter') return 'Imposter';
  if (role === 'crew') return 'Crew';
  if (role === 'islander') return 'Islander';
  return role || 'Unknown';
}

function winnerLabel(winner) {
  if (winner === 'mafia') return 'Mafia';
  if (winner === 'town') return 'Town';
  if (winner === 'imposter') return 'Imposters';
  if (winner === 'crew') return 'Crew';
  if (winner === 'final_couple') return 'Final Couple';
  if (winner === 'viewer_favorite') return 'Viewer Favorite';
  return winner || 'Unknown';
}

function modeLabel(mode) {
  if (mode === 'amongus') return 'Agents Among Us';
  if (mode === 'villa') return 'Agent Villa';
  return 'Agent Mafia';
}

function phaseLabel(state) {
  if (state.status === 'finished') return 'Finished';
  if (state.phase) return String(state.phase).charAt(0).toUpperCase() + String(state.phase).slice(1);
  return String(state.status || 'Lobby').charAt(0).toUpperCase() + String(state.status || 'lobby').slice(1);
}

function updateMatchHud(state) {
  if (!state) return;
  const players = state.players || [];
  const alive = players.filter((p) => p.alive !== false).length;
  const bots = players.filter((p) => p.isBot).length;
  const humans = Math.max(0, players.length - bots);
  const room = state.id || me.roomId || roomIdInput?.value?.trim().toUpperCase() || '—';
  const round = state.round || state.day || state.turn || null;
  const hostPlayer = players.find((p) => p.id === state.hostPlayerId);
  const hostState = hostPlayer?.isConnected ? 'host online' : 'host reconnecting';

  if (matchRoom) matchRoom.textContent = room;
  if (matchMode) matchMode.textContent = modeLabel(me.game);
  if (matchPhase) matchPhase.textContent = phaseLabel(state);
  if (matchRound) matchRound.textContent = round ? `#${round}` : '—';
  if (matchAlive) matchAlive.textContent = `${alive}/${players.length}`;
  if (matchRoster) matchRoster.textContent = `${humans} human · ${bots} bot`;
  if (matchStatusLine) matchStatusLine.textContent = `${hostState} · ${state.status}${state.botAutoplay ? ' · bot autopilot on' : ''}`;
}

function suggestedRefinement(result) {
  if (result.didWin) {
    return 'Lock in the win pattern: write a 3-line opener from this game and run 2 quick rematches to verify it stays stable.';
  }
  if (result.role === 'mafia' || result.role === 'imposter') {
    return 'Tighten deception discipline: in your prompt, require one question before each accusation so your reads feel less random.';
  }
  if (result.role === 'town' || result.role === 'crew') {
    return 'Sharpen discussion discipline: require one evidence line + one clear vote reason every meeting to reduce noisy eliminations.';
  }
  return 'Run a fast check-in pass: keep what worked, replace one weak behavior, and test again in the next match.';
}

function renderOwnerDigest(state) {
  if (!ownerDigestCard) return;
  if (!state || state.status !== 'finished' || !me.playerId) {
    ownerDigestCard.style.display = 'none';
    return;
  }

  const mePlayer = (state.players || []).find((p) => p.id === me.playerId);
  if (!mePlayer) {
    ownerDigestCard.style.display = 'none';
    return;
  }

  const role = mePlayer.role || '';
  const winner = state.winner || '';
  const didWin = me.game === 'villa'
    ? (Array.isArray(state.winnerPlayerIds)
      ? state.winnerPlayerIds.includes(me.playerId)
      : mePlayer.alive !== false)
    : Boolean(role && winner && role === winner);
  const resultTag = didWin ? '✅ Win' : '❌ Loss';
  const aliveTag = mePlayer.alive === false ? 'eliminated' : 'survived';
  const gameLabel = modeLabel(me.game);
  const result = { didWin, role, winner };

  const totalPlayers = (state.players || []).length;
  const survived = (state.players || []).filter((p) => p.alive !== false).length;
  const rounds = state.round || state.day || state.turn || 0;
  const placement = mePlayer.alive !== false ? `top ${survived}` : `${survived + 1}th`;

  ownerDigestCard.style.display = 'block';
  ownerDigestCard.innerHTML = `
    <div style="text-align:center; padding: 1.5rem 0;">
      <p class="section-title mb-8" style="font-size:1.3rem;">${didWin ? 'VICTORY' : 'MATCH COMPLETE'}</p>
      <p class="text-sm mb-8" style="color:var(--accent);">${winnerLabel(winner)} wins!</p>
      <div class="grid-2 mb-12" style="gap:0.75rem;">
        <div class="match-chip">
          <p class="field-label">Result</p>
          <h3>${resultTag}</h3>
        </div>
        <div class="match-chip">
          <p class="field-label">Role</p>
          <h3>${roleLabel(role)}</h3>
        </div>
        <div class="match-chip">
          <p class="field-label">Placement</p>
          <h3>${placement} / ${totalPlayers}</h3>
        </div>
        <div class="match-chip">
          <p class="field-label">Rounds</p>
          <h3>${rounds}</h3>
        </div>
      </div>
      <p class="text-xs text-muted mb-12">${suggestedRefinement(result)}</p>
      <div style="display:flex; flex-direction:column; align-items:center; gap:0.75rem;">
        <button class="btn btn-primary btn-rematch-cta" onclick="clearRematchCountdown(); document.getElementById('rematchBtn')?.click()">Rematch</button>
        <div id="rematchCountdownContainer"></div>
        <div class="row" style="justify-content:center; gap:0.75rem; flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" onclick="instantPlay(me.game || 'mafia')">New Game</button>
          <button class="btn btn-ghost btn-sm" id="shareResultBtn" onclick="shareResult()">Share Result</button>
        </div>
        <div id="postGameLeaderboard" class="post-game-leaderboard"></div>
      </div>
    </div>`;

  startRematchCountdown();
  renderPostGameLeaderboard();
}

async function renderPostGameLeaderboard() {
  const container = document.getElementById('postGameLeaderboard');
  if (!container) return;
  try {
    const resp = await fetch('/api/leaderboard');
    const data = await resp.json();
    if (!data.ok || !Array.isArray(data.topAgents) || data.topAgents.length === 0) return;

    const agents = data.topAgents;
    const myName = (playerName?.value || '').trim().toLowerCase();
    const myIndex = myName ? agents.findIndex((a) => a.name.toLowerCase() === myName) : -1;
    const top5 = agents.slice(0, 5);

    const renderRow = (agent, rank, highlight) => {
      const rankClass = rank <= 3 ? ` lb-mini-rank-${rank}` : '';
      const meClass = highlight ? ' lb-mini-me' : '';
      return `<div class="lb-mini-row${rankClass}${meClass}">
        <span class="lb-mini-pos">#${rank}</span>
        <span class="lb-mini-name">${agent.name}</span>
        <span class="lb-mini-mmr">${agent.mmr} MMR</span>
      </div>`;
    };

    let rows = top5.map((a, i) => renderRow(a, i + 1, i === myIndex));

    if (myIndex >= 5) {
      rows.push('<div class="lb-mini-sep">...</div>');
      rows.push(renderRow(agents[myIndex], myIndex + 1, true));
    }

    container.innerHTML = `
      <a href="/browse.html" class="lb-mini-link">
        <p class="lb-mini-title">Leaderboard</p>
        ${rows.join('')}
        <p class="lb-mini-footer">View full rankings</p>
      </a>`;
  } catch (_e) {
    /* silent fail — leaderboard is non-critical */
  }
}

function renderActions(state) {
  if (isSpectating() || (me.roomId && !meInState(state))) {
    actionsView.innerHTML = '<p class="text-sm text-muted"><span class="player-pill pill-bot" style="margin-right:6px;">Spectating</span> Watching this game live. No actions available.</p>';
    return;
  }

  if (!me.roomId || !me.playerId) {
    actionsView.innerHTML = '<p class="text-sm text-muted">Join a room to unlock actions.</p>';
    return;
  }

  const mePlayer = meInState(state);
  if (!mePlayer) {
    actionsView.innerHTML = '<p class="text-sm text-muted">Spectating this room update. Rejoin to act.</p>';
    return;
  }

  // Lobby phase: show a clear Start Game CTA so users are never stuck in a lobby
  // with no visible way to proceed (start button is hidden in dev panel on production).
  if (state.status === 'lobby') {
    const isHost = state.hostPlayerId === me.playerId;
    const playerCount = (state.players || []).length;
    if (isHost) {
      actionsView.innerHTML = `
        <p class="text-sm text-muted mb-8">All ${playerCount} players ready. You're the host — start when ready.</p>
        <button class="btn btn-primary" id="lobbyStartCtaBtn" type="button" style="width:100%;justify-content:center;">Start Game</button>
      `;
      document.getElementById('lobbyStartCtaBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('lobbyStartCtaBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }
        const res = await emitAck(activeEvent('start-ready'), { roomId: me.roomId, playerId: me.playerId });
        if (!res?.ok) {
          if (btn) { btn.disabled = false; btn.textContent = 'Start Game'; }
          setStatus(formatError(res, 'Start failed'), 'error');
          return;
        }
        renderState(res.state);
      });
    } else {
      actionsView.innerHTML = `<p class="text-sm text-muted">Waiting for the host to start · ${playerCount}/4 players</p>`;
    }
    return;
  }

  if (mePlayer.alive === false && state.status === 'in_progress') {
    actionsView.innerHTML = '<p class="text-sm text-muted">You are eliminated. No further actions this round.</p>';
    return;
  }

  const aliveOthers = (state.players || []).filter((p) => p.id !== me.playerId && p.alive !== false);

  if (me.game === 'mafia') {
    if (state.status === 'finished') {
      actionsView.innerHTML = `<p class="text-sm text-muted">Winner: <strong>${winnerLabel(state.winner)}</strong></p>`;
      return;
    }

    if (state.phase === 'night') {
      actionsView.innerHTML = aliveOthers.map((p) => `<button class="btn btn-soft action-danger" data-action="nightKill" data-target="${p.id}" type="button">Night kill ${escapeHtml(p.name)}</button>`).join('') || '<p class="text-sm text-muted">No valid targets</p>';
      return;
    }

    if (state.phase === 'discussion') {
      actionsView.innerHTML = `
        <p class="text-sm text-muted">Discussion phase. Build reads, then ready up when your read is locked.</p>
        <button class="btn btn-primary" data-action="ready" type="button">Ready up</button>
      `;
      return;
    }

    if (state.phase === 'voting') {
      actionsView.innerHTML = aliveOthers.map((p) => `<button class="btn btn-primary action-vote" data-action="vote" data-target="${p.id}" type="button">Vote ${escapeHtml(p.name)}</button>`).join('') || '<p class="text-sm text-muted">No vote targets</p>';
      return;
    }
  }

  if (me.game === 'amongus') {
    if (state.status === 'finished') {
      actionsView.innerHTML = `<p class="text-sm text-muted">Winner: <strong>${winnerLabel(state.winner)}</strong></p>`;
      return;
    }

    if (state.phase === 'tasks') {
      actionsView.innerHTML = `
        <button class="btn btn-primary action-task" data-action="task" type="button">Do task</button>
        ${aliveOthers.map((p) => `<button class="btn btn-soft action-danger" data-action="kill" data-target="${p.id}" type="button">Imposter kill ${escapeHtml(p.name)}</button>`).join('')}
        <button class="btn btn-soft action-vote" data-action="callMeeting" type="button">Call meeting</button>
      `;
      return;
    }

    if (state.phase === 'meeting') {
      actionsView.innerHTML = aliveOthers.map((p) => `<button class="btn btn-primary action-vote" data-action="vote" data-target="${p.id}" type="button">Vote eject ${escapeHtml(p.name)}</button>`).join('') || '<p class="text-sm text-muted">No vote targets</p>';
      return;
    }
  }

  if (me.game === 'villa') {
    if (state.status === 'finished') {
      actionsView.innerHTML = `<p class=\"text-sm text-muted\">Winner: <strong>${winnerLabel(state.winner)}</strong></p>`;
      return;
    }

    const immunityId = state.roundState?.challenge?.immunityPlayerId || null;
    const vulnerableId = state.roundState?.twist?.vulnerablePlayerId || null;
    const targetButtons = (type, label) => aliveOthers
      .filter((p) => !(immunityId && (state.phase === 'twist' || state.phase === 'elimination') && p.id === immunityId))
      .map((p) => `<button class=\"btn btn-primary\" data-action=\"${type}\" data-target=\"${p.id}\" type=\"button\">${label} ${escapeHtml(p.name)}</button>`)
      .join('');

    if (state.phase === 'pairing') {
      actionsView.innerHTML = targetButtons('pair', 'Pair with') || '<p class=\"text-sm text-muted\">No valid pairing targets</p>';
      return;
    }

    if (state.phase === 'challenge') {
      actionsView.innerHTML = targetButtons('challengeVote', 'Back');
      return;
    }

    if (state.phase === 'twist') {
      const immunityNote = immunityId ? `<p class=\"text-sm text-muted\">Immunity: ${escapeHtml(state.players.find((p) => p.id === immunityId)?.name || immunityId)}</p>` : '';
      actionsView.innerHTML = `${immunityNote}${targetButtons('twistVote', 'Expose') || '<p class=\"text-sm text-muted\">No eligible twist targets</p>'}`;
      return;
    }

    if (state.phase === 'recouple') {
      actionsView.innerHTML = targetButtons('recouple', 'Recouple with') || '<p class=\"text-sm text-muted\">No valid recouple targets</p>';
      return;
    }

    if (state.phase === 'elimination') {
      const context = [
        immunityId ? `Immune: ${escapeHtml(state.players.find((p) => p.id === immunityId)?.name || immunityId)}` : '',
        vulnerableId ? `At risk: ${escapeHtml(state.players.find((p) => p.id === vulnerableId)?.name || vulnerableId)}` : '',
      ].filter(Boolean).join(' · ');
      const contextLine = context ? `<p class=\"text-sm text-muted\">${context}</p>` : '';
      actionsView.innerHTML = `${contextLine}${targetButtons('eliminateVote', 'Vote out') || '<p class=\"text-sm text-muted\">No elimination targets</p>'}`;
      return;
    }
  }

  actionsView.innerHTML = '<p class="text-sm text-muted">Waiting for active match...</p>';
}

hostBtn?.addEventListener('click', async () => {
  await withPendingUiAction(async () => {
    me.game = selectedMode();
    const res = await emitAck(activeEvent('room:create'), { name: playerName.value.trim() || 'Host' });
    if (!res?.ok) return setStatus(formatError(res, 'Host failed'), 'error');
    me.roomId = res.roomId;
    me.playerId = res.playerId;
    roomIdInput.value = me.roomId;
    setStatus(`Hosted ${me.game} room ${me.roomId}`);
    renderState(res.state);
    void loadClaimableSeats();
  });
});

joinBtn?.addEventListener('click', async () => {
  await withPendingUiAction(async () => {
    me.game = selectedMode();
    const res = await emitAck(activeEvent('room:join'), {
      roomId: roomIdInput.value.trim().toUpperCase(),
      name: playerName.value.trim() || 'Player',
    });
    if (!res?.ok) return setStatus(formatError(res, 'Join failed'), 'error');
    me.roomId = res.roomId;
    me.playerId = res.playerId;
    setStatus(`Joined ${me.game} room ${me.roomId}`);
    renderState(res.state);
    void loadClaimableSeats();
  });
});

loadClaimsBtn?.addEventListener('click', async () => {
  await loadClaimableSeats();
});

claimSeatsView?.addEventListener('click', async (e) => {
  const quickRecoverBtn = e.target.closest('[data-quick-recover]');
  if (quickRecoverBtn) {
    void sendReconnectTelemetry(null, 'quick_recover_clicked');
    try {
      const mode = selectedMode();
      const name = playerName?.value?.trim() || `Player-${Math.floor(Math.random() * 999)}`;
      const res = await fetch('/api/play/quick-join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, name }),
      });
      const data = await res.json();
      if (!data?.ok || !data?.joinTicket?.joinUrl) {
        setStatus(formatError(data, 'Quick match failed'), 'error');
        showRecoveryHint('Recovery tip: quick match unavailable. Keep room ID, then retry <strong>Find Reconnect Seats</strong> in ~5s.');
        return;
      }
      window.location.href = data.joinTicket.joinUrl;
    } catch (_err) {
      setStatus('Quick match failed', 'error');
      showRecoveryHint('Recovery tip: network hiccup. Retry <strong>Find Reconnect Seats</strong> or quick match again.');
    }
    return;
  }

  const btn = e.target.closest('[data-claim-name]');
  if (!btn) return;
  const claimName = btn.getAttribute('data-claim-name') || '';
  if (!claimName) return;
  if (playerName) playerName.value = claimName;

  void sendReconnectTelemetry(null, 'reclaim_clicked');

  me.game = selectedMode();
  const res = await emitAck(activeEvent('room:join'), {
    roomId: roomIdInput.value.trim().toUpperCase(),
    name: claimName,
  });
  if (!res?.ok) return setStatus(formatError(res, 'Claim failed'), 'error');

  me.roomId = res.roomId;
  me.playerId = res.playerId;
  suggestedReclaim = null;
  setStatus(`Reconnected as ${claimName}${res.playerId === res.state?.hostPlayerId ? ' (host)' : ''}`);
  showRecoveryHint(`Recovered seat <strong>${escapeHtml(claimName)}</strong>. If you disconnect again, reclaim from this panel.`);
  renderState(res.state);
  void loadClaimableSeats();
});

quickMatchBtn?.addEventListener('click', async () => {
  await withPendingUiAction(async () => {
    try {
      const mode = selectedMode();
      const name = playerName?.value?.trim() || `Player-${Math.floor(Math.random() * 999)}`;
      const res = await fetch('/api/play/quick-join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, name }),
      });
      const data = await res.json();
      if (!data?.ok || !data?.joinTicket?.joinUrl) {
        setStatus(formatError(data, 'Quick match failed'), 'error');
        return;
      }
      window.location.href = data.joinTicket.joinUrl;
    } catch (_err) {
      setStatus('Quick match failed', 'error');
    }
  });
});

startBtn?.addEventListener('click', async () => {
  if (!me.roomId || !me.playerId) return setStatus('Host or join first', 'warn');
  await withPendingUiAction(async () => {
    const eventName = currentState?.status === 'lobby' ? activeEvent('start-ready') : activeEvent('start');
    const res = await emitAck(eventName, { roomId: me.roomId, playerId: me.playerId });
    if (!res?.ok) return setStatus(formatError(res, 'Start failed'), 'error');
    const addedBots = Number(res.addedBots || 0);
    const removed = Number(res.removedDisconnectedHumans || 0);
    if (addedBots > 0 || removed > 0) {
      setStatus(`Game started · +${addedBots} bot(s), replaced ${removed} disconnected player(s)`);
    } else {
      setStatus('Game started');
    }
    renderState(res.state);
  });
});

rematchBtn?.addEventListener('click', async () => {
  clearRematchCountdown();
  if (!me.roomId || !me.playerId) return setStatus('Host or join first', 'warn');
  await withPendingUiAction(async () => {
    const res = await emitAck(activeEvent('rematch'), { roomId: me.roomId, playerId: me.playerId });
    if (!res?.ok) return setStatus(formatError(res, 'Rematch failed'), 'error');
    setStatus('Rematch started');
    renderState(res.state);
  });
});

autofillBtn?.addEventListener('click', async () => {
  if (!me.roomId || !me.playerId) return setStatus('Host or join first', 'warn');
  await withPendingUiAction(async () => {
    const res = await emitAck(activeEvent('autofill'), { roomId: me.roomId, playerId: me.playerId, minPlayers: 4 });
    if (!res?.ok) return setStatus(formatError(res, 'Auto-fill failed'), 'error');
    setStatus(`Auto-filled ${res.addedBots || 0} bot(s)`);
    renderState(res.state);
  });
});

advanceBtn?.addEventListener('click', async () => {
  const advance = getAdvanceConfig(currentState);
  if (!advance.enabled || !advance.event || !advance.payload) {
    setStatus(advance.title || 'No phase action available right now.', 'warn');
    return;
  }

  await withPendingUiAction(async () => {
    const res = await emitAck(advance.event, advance.payload);
    if (!res?.ok) return setStatus(formatError(res, 'Advance failed'), 'error');
    renderState(res.state);
  });
});

actionsView?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const type = btn.getAttribute('data-action');
  const targetId = btn.getAttribute('data-target') || undefined;
  await withPendingUiAction(async () => {
    const res = await emitAck(activeEvent('action'), { roomId: me.roomId, playerId: me.playerId, type, targetId });
    if (!res?.ok) return setStatus(formatError(res, 'Action failed'), 'error');
    renderState(res.state);
  });
});

socket.on('mafia:state', (state) => {
  if (me.game !== 'mafia') return;
  if (state.id !== me.roomId) return;
  renderState(state);
});

socket.on('amongus:state', (state) => {
  if (me.game !== 'amongus') return;
  if (state.id !== me.roomId) return;
  renderState(state);
});

socket.on('villa:state', (state) => {
  if (me.game !== 'villa') return;
  if (state.id !== me.roomId) return;
  renderState(state);
});

// ── Reconnect UX ──
socket.on('disconnect', () => {
  const banner = document.getElementById('reconnectBanner');
  const bannerText = document.getElementById('reconnectBannerText');
  if (banner) {
    banner.style.display = '';
    if (bannerText) bannerText.textContent = 'Connection lost — reconnecting...';
  }
});

socket.on('connect', () => {
  const banner = document.getElementById('reconnectBanner');
  const bannerText = document.getElementById('reconnectBannerText');
  if (banner && banner.style.display !== 'none') {
    if (bannerText) bannerText.textContent = 'Reconnected!';
    // Auto-rejoin room if we were in one
    if (me.roomId && me.playerId) {
      const mode = me.game || 'mafia';
      emitAck(`${mode}:room:join`, {
        roomId: me.roomId,
        name: playerName?.value?.trim() || `Player-${Math.floor(Math.random() * 999)}`,
      }).then((res) => {
        if (res?.ok) {
          me.playerId = res.playerId || me.playerId;
          renderState(res.state);
        }
      }).catch(() => {});
    }
    setTimeout(() => { banner.style.display = 'none'; }, 2000);
  }
});

flushEventsBtn?.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/ops/events/flush', { method: 'POST' });
    const data = await res.json();
    if (data?.ok) setStatus(`Event queue flushed (${data.pending} pending)`);
  } catch (_err) {
    setStatus('Failed to flush event queue');
  }
  await refreshOpsStatus();
});

async function runEvalApi(pathname) {
  if (!evalStatus) return;
  evalStatus.textContent = 'Running evals...';
  try {
    const res = await fetch(pathname);
    const data = await res.json();
    if (pathname === '/api/evals/ci') {
      const checks = (data.checks || []).map((c) => `${c.ok ? '✅' : '❌'} ${c.metric}: ${c.actual} (${c.expect})`).join('\n');
      evalStatus.textContent = [
        data.ok ? 'CI Gate: PASS' : 'CI Gate: FAIL',
        `fixtures=${data.totals?.fixtures} failed=${data.failedFixtures?.length || 0}`,
        checks,
      ].join('\n');
      return;
    }

    evalStatus.textContent = JSON.stringify({
      ok: data.ok,
      totals: data.totals,
      failedFixtureIds: (data.failures || []).map((f) => f.id),
    }, null, 2);
  } catch (_err) {
    evalStatus.textContent = 'Eval request failed';
  }
}

runEvalsBtn?.addEventListener('click', async () => {
  await runEvalApi('/api/evals/run');
});

runCiGateBtn?.addEventListener('click', async () => {
  await runEvalApi('/api/evals/ci');
});

async function autoJoinFromQuery() {
  const { autojoin, reclaimName, reclaimHost, queryName, claimToken, quickJoinReason } = parseQueryConfig();
  if (!autojoin || attemptedAutoJoin) return;
  attemptedAutoJoin = true;

  const roomId = roomIdInput?.value?.trim().toUpperCase();
  if (!roomId) return;

  me.game = selectedMode();
  const fallbackName = queryName || `Player-${Math.floor(Math.random() * 999)}`;
  const requestedName = playerName?.value?.trim() || fallbackName;

  const res = await emitAck(activeEvent('room:join'), {
    roomId,
    name: requestedName,
    claimToken: claimToken || undefined,
  });

  if (!res?.ok && claimToken) {
    const retry = await emitAck(activeEvent('room:join'), {
      roomId,
      name: fallbackName,
    });

    if (retry?.ok) {
      me.roomId = retry.roomId;
      me.playerId = retry.playerId;
      suggestedReclaim = reclaimName ? { name: reclaimName, hostSeat: reclaimHost } : null;
      attemptedSuggestedReclaim = false;
      setStatus(`Reconnect token expired/used. Joined as ${fallbackName}; attempting auto-reclaim…`);
      showRecoveryHint('We got you back in the room. Next step: reclaim your previous seat below.');
      renderState(retry.state);
      const reclaimed = await attemptSuggestedReclaimAuto();
      void loadClaimableSeats();
      if (!reclaimed) {
        setStatus(`Reconnect token expired/used. Joined as ${fallbackName}; use "Reclaim suggested seat" below if needed.`);
      }
      return;
    }

    setStatus(`Reconnect token failed. ${formatError(retry, `Quick-join failed for room ${roomId}`)}`, 'error');
    showRecoveryHint('Recovery fallback: check room ID, then use Find Reconnect Seats. If room is dead, use Quick match me now.');
    void loadClaimableSeats();
    return;
  }

  if (!res?.ok) {
    setStatus(formatError(res, `Quick-join failed for room ${roomId}`), 'error');
    return;
  }

  suggestedReclaim = null;
  me.roomId = res.roomId;
  me.playerId = res.playerId;
  const joinStatus = reclaimName
    ? `Reconnected ${reclaimName} in ${me.game} room ${me.roomId}`
    : `Quick-joined ${me.game} room ${me.roomId}`;
  setStatus(quickJoinReason ? `${joinStatus} · ${quickJoinReason}` : joinStatus);
  showRecoveryHint('Connected. If you drop, reopen this room and use Find Reconnect Seats to reclaim identity fast.');
  renderState(res.state);
  void loadClaimableSeats();
}

setInterval(() => {
  void refreshOpsStatus();
}, 3000);

gameMode?.addEventListener('change', () => {
  if (!currentState || !me.roomId) {
    me.game = selectedMode();
  }
});

function shareResult() {
  if (!currentState) return;
  const winner = currentState.winner || 'Unknown';
  const mode = modeLabel(me.game);
  const modeKey = me.game || 'mafia';
  const rounds = currentState.round || currentState.day || currentState.turn || 0;
  const shareUrl = `${window.location.origin}/?mode=${encodeURIComponent(modeKey)}&autojoin=1`;

  const text = `${winnerLabel(winner)} just won ${mode} in ${rounds} rounds. Can you beat them?`;

  fetch('/api/track/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: modeKey }) }).catch(() => {});

  if (navigator.share) {
    navigator.share({ title: 'Agent Arena Match', text, url: shareUrl }).catch(() => {});
  } else if (navigator.clipboard) {
    const shareText = `${text}\n${shareUrl}`;
    navigator.clipboard.writeText(shareText).then(() => {
      const btn = document.getElementById('shareResultBtn');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Share Result'; }, 2000); }
    }).catch(() => {});
  }
}

// Game picker: instant play via POST /api/play/instant
async function instantPlay(mode) {
  showTutorial(mode);
  showWaitingOverlay(mode, 0, 4);
  if (playStatus) { playStatus.style.display = 'block'; }
  setStatus(`Starting ${modeLabel(mode)}...`);
  try {
    const res = await fetch('/api/play/instant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json();
    if (!data?.ok || !data?.playUrl) {
      hideWaitingOverlay();
      setStatus(formatError(data, 'Instant play failed'), 'error');
      return;
    }
    window.location.href = data.playUrl;
  } catch (_err) {
    hideWaitingOverlay();
    setStatus('Instant play failed — try again', 'error');
  }
}

// Game picker card click handlers
gamePicker?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-instant-play]');
  if (!btn) return;
  const mode = btn.getAttribute('data-instant-play');
  if (mode) instantPlay(mode);
});

// Watch a random live game
watchRandomBtn?.addEventListener('click', async () => {
  setStatus('Finding a live game...');
  if (playStatus) { playStatus.style.display = 'block'; }
  try {
    const res = await fetch('/api/play/watch');
    const data = await res.json();
    if (!data?.ok || !data?.watchUrl) {
      setStatus('No live games right now — start one!', 'warn');
      return;
    }
    window.location.href = data.watchUrl;
  } catch (_err) {
    setStatus('Could not find a live game', 'error');
  }
});

// Show/hide game picker based on query params
function initGamePickerVisibility() {
  const params = new URLSearchParams(window.location.search || '');
  const hasRoom = params.get('room') || params.get('autojoin');
  if (hasRoom && gamePicker) {
    gamePicker.style.display = 'none';
  }
}

initGamePickerVisibility();

// Hide debug panel unless ?debug=1 is present
(function initDebugPanelVisibility() {
  const params = new URLSearchParams(window.location.search || '');
  const debugPanel = document.querySelector('.dev-panel');
  if (debugPanel && params.get('debug') !== '1') {
    debugPanel.style.display = 'none';
  }
})();

// Handle instant play auto-start
// Server now starts the game before the client arrives, so this is belt-and-suspenders.
// If the game is already in_progress, the state will reflect that. If still in lobby
// (e.g. race condition), retry start-ready until me.playerId is available.
(function handleInstantPlay() {
  const params = new URLSearchParams(window.location.search || '');
  if (params.get('instant') !== '1' || !params.get('room')) return;

  let attempts = 0;
  const MAX_ATTEMPTS = 12; // up to 6s of retries (every 500ms)

  function tryAutoStart() {
    attempts++;
    // Only act if we're still in the lobby — server may have already started the game.
    if (currentState && currentState.status !== 'lobby') return;
    if (!me.roomId || !me.playerId) {
      if (attempts < MAX_ATTEMPTS) setTimeout(tryAutoStart, 500);
      return;
    }
    const mode = me.game || selectedMode();
    emitAck(`${mode}:start-ready`, { roomId: me.roomId, playerId: me.playerId })
      .then((res) => { if (res?.ok) renderState(res.state); })
      .catch(() => {});
  }

  setTimeout(tryAutoStart, 1500);
})();

// Show waiting overlay on instant-play page load (before state arrives)
(function initWaitingOverlay() {
  const params = new URLSearchParams(window.location.search || '');
  if ((params.get('instant') === '1' || params.get('autojoin') === '1') && params.get('room')) {
    const mode = params.get('game') || params.get('mode') || me.game || 'mafia';
    showWaitingOverlay(mode, 0, 4);
  }

  const cancelBtn = document.getElementById('waitingCancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      hideWaitingOverlay();
      setStatus('Matchmaking cancelled', 'warn');
    });
  }
})();

// ── Recent Games widget ──

const MODE_LABELS = { mafia: 'Agent Mafia', amongus: 'Among Us', villa: 'Agent Villa' };

function getStoredUserId() {
  return localStorage.getItem('agentarena_user_id') || '';
}

async function loadRecentMatches() {
  const userId = getStoredUserId();
  if (!userId) return; // no session — skip for first-time visitors

  const section = document.getElementById('recentGamesSection');
  const list = document.getElementById('recentGamesList');
  const streakBadge = document.getElementById('winStreakBadge');
  if (!section || !list) return;

  try {
    const res = await fetch(`/api/matches?userId=${encodeURIComponent(userId)}&limit=5`);
    const data = await res.json();
    if (!data.ok || !data.matches || data.matches.length === 0) return;

    // Calculate win streak (consecutive survived matches from most recent)
    let winStreak = 0;
    for (const m of data.matches) {
      if (m.survived) winStreak++;
      else break;
    }

    section.style.display = '';

    if (streakBadge && winStreak >= 2) {
      streakBadge.innerHTML = `<span class="win-streak-badge">${winStreak} win streak</span>`;
    }

    list.innerHTML = data.matches.map(m => {
      const isWin = !!m.survived;
      const resultClass = isWin ? 'win' : 'loss';
      const resultText = isWin ? 'W' : 'L';
      const modeName = MODE_LABELS[m.mode] || m.mode;
      const role = m.role ? ` / ${m.role}` : '';
      const rounds = m.rounds ? `${m.rounds}r` : '';
      const ago = m.finished_at ? timeAgo(m.finished_at) : '';
      return `<div class="recent-game-row">
        <span class="recent-game-result ${resultClass}">${resultText}</span>
        <span class="recent-game-mode">${modeName}</span>
        <span class="text-sm">${m.player_name || ''}${role}</span>
        <span class="recent-game-meta">${[rounds, ago].filter(Boolean).join(' · ')}</span>
      </div>`;
    }).join('');
  } catch (_) {
    // silently fail — widget is non-critical
  }
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Player profile cards ──
async function showPlayerProfile(playerName, userId) {
  // Remove existing overlay
  document.querySelector('.profile-card-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'profile-card-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const card = document.createElement('div');
  card.className = 'profile-card';
  card.innerHTML = `<h3>${escapeHtml(playerName)}</h3><p class="text-sm text-muted">Loading stats...</p>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  try {
    const token = getAuthToken();
    let matches = [];
    if (userId && token) {
      const res = await fetch(`/api/matches?userId=${encodeURIComponent(userId)}&limit=20`);
      const data = await res.json();
      if (data.ok) matches = data.matches || [];
    }

    const totalGames = matches.length;
    const wins = matches.filter(m => m.survived).length;
    const winRate = totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0;

    let streak = 0;
    for (const m of matches) {
      if (m.survived) streak++;
      else break;
    }

    card.innerHTML = `
      <h3>${escapeHtml(playerName)}</h3>
      <div class="mt-8">
        <div class="profile-card-stat"><span class="label">Games played</span><span class="value">${totalGames}</span></div>
        <div class="profile-card-stat"><span class="label">Win rate</span><span class="value">${winRate}%</span></div>
        <div class="profile-card-stat"><span class="label">Current streak</span><span class="value">${streak}</span></div>
      </div>
      ${totalGames === 0 ? '<p class="text-xs text-muted mt-8">No match history yet.</p>' : ''}
    `;
  } catch (_) {
    card.innerHTML = `<h3>${escapeHtml(playerName)}</h3><p class="text-sm text-muted">Could not load profile.</p>`;
  }
}

// Delegate player name clicks from the player view
playersView?.addEventListener('click', (e) => {
  const playerCard = e.target.closest('.player-card');
  if (!playerCard) return;
  const nameEl = playerCard.querySelector('h3');
  if (!nameEl) return;
  const name = nameEl.textContent.replace(' (you)', '').trim();
  // Find the player in current state to get userId
  const player = currentState?.players?.find(p => p.name === name);
  showPlayerProfile(name, player?.userId);
});

// ── Sound feedback (Web Audio API) ──
let audioCtx = null;
let soundMuted = false;

function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
  }
  return audioCtx;
}

function playTone(freq, duration = 0.15, type = 'sine', volume = 0.3) {
  if (soundMuted) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = volume;
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

function sfxGameStart() { playTone(523, 0.12); setTimeout(() => playTone(659, 0.12), 130); setTimeout(() => playTone(784, 0.2), 260); }
function sfxPhaseChange() { playTone(440, 0.2, 'triangle', 0.2); }
function sfxElimination() { playTone(220, 0.3, 'sawtooth', 0.15); setTimeout(() => playTone(165, 0.4, 'sawtooth', 0.1), 300); }
function sfxWin() { playTone(523, 0.15); setTimeout(() => playTone(659, 0.15), 150); setTimeout(() => playTone(784, 0.15), 300); setTimeout(() => playTone(1047, 0.3), 450); }

// Mute toggle
soundMuted = localStorage.getItem('agentarena_muted') === '1';
document.getElementById('muteToggle')?.addEventListener('click', () => {
  soundMuted = !soundMuted;
  localStorage.setItem('agentarena_muted', soundMuted ? '1' : '0');
  const btn = document.getElementById('muteToggle');
  if (btn) btn.textContent = soundMuted ? 'Sound: Off' : 'Sound: On';
});

// ── Tutorial overlay ──
const TUTORIAL_STEPS = {
  mafia: [
    { title: 'Welcome to Agent Mafia', body: 'Find the mafia agent hiding among the town. Each round, discuss and vote to eliminate a suspect.' },
    { title: 'Day & Night', body: 'During the day, everyone debates. At night, the mafia secretly eliminates a player. Survive to win!' },
    { title: 'Ready?', body: 'Pick a name, join a room, and start playing. Good luck, detective.' },
  ],
  amongus: [
    { title: 'Agents Among Us', body: 'Complete tasks around the map or sabotage them as the impostor. Trust no one.' },
    { title: 'Emergency Meetings', body: 'Call a meeting to discuss and vote. Eject the impostor before it\'s too late!' },
    { title: 'Ready?', body: 'Jump in and see if you can spot the impostor — or fool everyone.' },
  ],
  villa: [
    { title: 'Welcome to Agent Villa', body: 'Pair up, form alliances, and survive dramatic twists on the island.' },
    { title: 'Coupling & Twists', body: 'Each round brings recouplings and surprise events. Adapt your strategy!' },
    { title: 'Ready?', body: 'Enter the villa and see who comes out on top.' },
  ],
};

let tutorialMode = null;
let tutorialStepIdx = 0;

function showTutorial(mode) {
  const key = `hasSeenTutorial_${mode}`;
  if (localStorage.getItem(key)) return;
  const steps = TUTORIAL_STEPS[mode];
  if (!steps) return;

  tutorialMode = mode;
  tutorialStepIdx = 0;

  const overlay = document.getElementById('tutorialOverlay');
  if (overlay) overlay.style.display = '';
  renderTutorialStep();
}

function renderTutorialStep() {
  const steps = TUTORIAL_STEPS[tutorialMode] || [];
  const step = steps[tutorialStepIdx];
  if (!step) return closeTutorial();

  const stepEl = document.getElementById('tutorialStep');
  const dotsEl = document.getElementById('tutorialDots');
  const nextBtn = document.getElementById('tutorialNext');

  if (stepEl) stepEl.innerHTML = `<h3>${step.title}</h3><p class="text-sm text-muted mt-8">${step.body}</p>`;
  if (dotsEl) dotsEl.innerHTML = steps.map((_, i) =>
    `<span class="tutorial-dot${i === tutorialStepIdx ? ' active' : ''}"></span>`
  ).join('');
  if (nextBtn) nextBtn.textContent = tutorialStepIdx === steps.length - 1 ? 'Got it!' : 'Next';
}

function closeTutorial() {
  if (tutorialMode) localStorage.setItem(`hasSeenTutorial_${tutorialMode}`, '1');
  const overlay = document.getElementById('tutorialOverlay');
  if (overlay) overlay.style.display = 'none';
  tutorialMode = null;
}

document.getElementById('tutorialNext')?.addEventListener('click', () => {
  tutorialStepIdx++;
  renderTutorialStep();
});

document.getElementById('tutorialOverlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'tutorialOverlay') closeTutorial();
});

// ── Auth flow ──
const AUTH_TOKEN_KEY = 'agentarena_auth_token';

function getAuthToken() { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; }
function setAuthToken(token) { localStorage.setItem(AUTH_TOKEN_KEY, token); }
function clearAuthToken() { localStorage.removeItem(AUTH_TOKEN_KEY); }

async function checkAuth() {
  const token = getAuthToken();
  const signInBtn = document.getElementById('signInBtn');
  const profileBadge = document.getElementById('profileBadge');
  if (!token) {
    if (signInBtn) signInBtn.style.display = '';
    if (profileBadge) profileBadge.style.display = 'none';
    return null;
  }
  try {
    const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.ok && data.user) {
      if (signInBtn) signInBtn.style.display = 'none';
      if (profileBadge) {
        profileBadge.style.display = '';
        profileBadge.textContent = data.user.displayName || data.user.email || 'You';
        profileBadge.title = `Signed in as ${data.user.email || 'anonymous'}`;
      }
      // Sync userId for match history
      if (data.user.id) localStorage.setItem('agentarena_user_id', data.user.id);
      return data.user;
    }
  } catch (_) {}
  clearAuthToken();
  if (signInBtn) signInBtn.style.display = '';
  if (profileBadge) profileBadge.style.display = 'none';
  return null;
}

document.getElementById('signInBtn')?.addEventListener('click', () => {
  const modal = document.getElementById('signInModal');
  if (modal?.showModal) modal.showModal();
});

document.getElementById('signInCancelBtn')?.addEventListener('click', () => {
  document.getElementById('signInModal')?.close();
});

document.getElementById('signInForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('authEmail')?.value?.trim();
  const displayName = document.getElementById('authDisplayName')?.value?.trim();
  const authError = document.getElementById('authError');

  if (!email || !displayName) return;

  try {
    // Try to register; if email exists, try upgrading anonymous account
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, displayName }),
    });
    const data = await res.json();
    if (data.ok) {
      setAuthToken(data.session.token);
      if (data.user?.id) localStorage.setItem('agentarena_user_id', data.user.id);
      document.getElementById('signInModal')?.close();
      checkAuth();
      return;
    }
    if (authError) {
      authError.style.display = '';
      authError.textContent = data.error || 'Sign in failed';
    }
  } catch (_) {
    if (authError) {
      authError.style.display = '';
      authError.textContent = 'Network error — try again';
    }
  }
});

defaultRecoveryHint();
updateControlState(currentState);
void refreshOpsStatus();
void autoJoinFromQuery();
void loadRecentMatches();
void checkAuth();
