const socket = io();

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

let me = { roomId: '', playerId: '', game: 'mafia' };
let currentState = null;
let attemptedAutoJoin = false;
let suggestedReclaim = null;
let attemptedSuggestedReclaim = false;
let pendingUiAction = false;
let rematchCountdownTimer = null;
let rematchCountdownSeconds = 0;

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
    ? `<button class="btn btn-primary" type="button" data-claim-name="${suggestedReclaim.name}" data-claim-suggested="1">Reclaim suggested seat: ${suggestedReclaim.name}${suggestedReclaim.hostSeat ? ' (host)' : ''}</button>`
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
      <button class="btn btn-soft" type="button" data-claim-name="${seat.name}">
        Claim ${seat.name}${seat.hostSeat ? ' (host)' : ''}
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
  const spectating = isSpectating() || (me.roomId && state && !meInState(state));
  const players = state?.players || [];
  const isHost = !spectating && !!(state?.hostPlayerId && me.playerId && state.hostPlayerId === me.playerId);
  const inLobby = state?.status === 'lobby';
  const finished = state?.status === 'finished';
  const inProgress = state?.status === 'in_progress';
  const minPlayersReady = players.length >= 4;
  const disconnectedHumans = players.filter((p) => !p.isBot && !p.isConnected);
  const mePlayer = meInState(state);
  const advance = getAdvanceConfig(state);

  if (spectating) {
    if (startBtn) { startBtn.disabled = true; startBtn.title = 'Spectating'; }
    if (autofillBtn) { autofillBtn.disabled = true; }
    if (rematchBtn) { rematchBtn.disabled = true; }
    if (advanceBtn) { advanceBtn.disabled = true; advanceBtn.textContent = 'Spectating'; }
    if (hostBtn) { hostBtn.disabled = true; }
    if (joinBtn) { joinBtn.disabled = true; }
    setStatus('Spectating — watching this game live.', 'info');
    return;
  }

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
    rematchBtn.disabled = pendingUiAction || !mePlayer || !finished;
    rematchBtn.title = !mePlayer ? 'Players only' : !finished ? 'Available after game ends' : '';
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

function renderState(state) {
  currentState = state;
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
        <h3>${p.name}${p.id === me.playerId ? ' (you)' : ''}</h3>
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
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('quickMatchBtn')?.click()">New Game</button>
          <button class="btn btn-ghost btn-sm" id="shareResultBtn" onclick="shareResult()">Share on X</button>
          <button class="btn btn-ghost btn-sm" id="copyLinkBtn" onclick="copyMatchLink()">Copy Link</button>
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

function isSpectating() {
  const params = new URLSearchParams(window.location.search || '');
  return params.get('spectate') === '1';
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
      actionsView.innerHTML = aliveOthers.map((p) => `<button class="btn btn-soft action-danger" data-action="nightKill" data-target="${p.id}" type="button">Night kill ${p.name}</button>`).join('') || '<p class="text-sm text-muted">No valid targets</p>';
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
      actionsView.innerHTML = aliveOthers.map((p) => `<button class="btn btn-primary action-vote" data-action="vote" data-target="${p.id}" type="button">Vote ${p.name}</button>`).join('') || '<p class="text-sm text-muted">No vote targets</p>';
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
        ${aliveOthers.map((p) => `<button class="btn btn-soft action-danger" data-action="kill" data-target="${p.id}" type="button">Imposter kill ${p.name}</button>`).join('')}
        <button class="btn btn-soft action-vote" data-action="callMeeting" type="button">Call meeting</button>
      `;
      return;
    }

    if (state.phase === 'meeting') {
      actionsView.innerHTML = aliveOthers.map((p) => `<button class="btn btn-primary action-vote" data-action="vote" data-target="${p.id}" type="button">Vote eject ${p.name}</button>`).join('') || '<p class="text-sm text-muted">No vote targets</p>';
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
      .map((p) => `<button class=\"btn btn-primary\" data-action=\"${type}\" data-target=\"${p.id}\" type=\"button\">${label} ${p.name}</button>`)
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
      const immunityNote = immunityId ? `<p class=\"text-sm text-muted\">Immunity: ${state.players.find((p) => p.id === immunityId)?.name || immunityId}</p>` : '';
      actionsView.innerHTML = `${immunityNote}${targetButtons('twistVote', 'Expose') || '<p class=\"text-sm text-muted\">No eligible twist targets</p>'}`;
      return;
    }

    if (state.phase === 'recouple') {
      actionsView.innerHTML = targetButtons('recouple', 'Recouple with') || '<p class=\"text-sm text-muted\">No valid recouple targets</p>';
      return;
    }

    if (state.phase === 'elimination') {
      const context = [
        immunityId ? `Immune: ${state.players.find((p) => p.id === immunityId)?.name || immunityId}` : '',
        vulnerableId ? `At risk: ${state.players.find((p) => p.id === vulnerableId)?.name || vulnerableId}` : '',
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
  showRecoveryHint(`Recovered seat <strong>${claimName}</strong>. If you disconnect again, reclaim from this panel.`);
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

  // Instant play: auto-start after joining
  const params = new URLSearchParams(window.location.search || '');
  if (params.get('instant') === '1' && me.roomId) {
    setTimeout(async () => {
      if (!me.roomId || !me.playerId) return;
      try {
        const startRes = await emitAck(activeEvent('start-ready'), { roomId: me.roomId, playerId: me.playerId });
        if (startRes?.ok && startRes.state) renderState(startRes.state);
      } catch (_err) { /* host flow will handle */ }
    }, 1500);
  }
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
  } else {
    // Open share on X
    const tweetText = encodeURIComponent(`${text}\n\n${shareUrl}`);
    window.open(`https://x.com/intent/tweet?text=${tweetText}`, '_blank');
  }
}

function copyMatchLink() {
  const modeKey = me.game || 'mafia';
  const url = `${window.location.origin}/?mode=${encodeURIComponent(modeKey)}&autojoin=1`;
  fetch('/api/track/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: modeKey }) }).catch(() => {});
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('copyLinkBtn');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy Link'; }, 2000); }
    }).catch(() => {});
  }
}

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

// Hide debug panel unless ?debug=1 is present
(function initDebugPanelVisibility() {
  const params = new URLSearchParams(window.location.search || '');
  const debugPanel = document.querySelector('.dev-panel');
  if (debugPanel && params.get('debug') !== '1') {
    debugPanel.style.display = 'none';
  }
})();

defaultRecoveryHint();
updateControlState(currentState);
void refreshOpsStatus();
void autoJoinFromQuery();
void loadRecentMatches();
