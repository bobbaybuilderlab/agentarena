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

let me = { roomId: '', playerId: '', game: 'mafia' };
let currentState = null;
let attemptedAutoJoin = false;
let suggestedReclaim = null;
let attemptedSuggestedReclaim = false;

function parseQueryConfig() {
  const params = new URLSearchParams(window.location.search || '');
  const queryGame = params.get('game');
  const queryRoom = params.get('room');
  const queryName = params.get('name');
  const reclaimName = params.get('reclaimName');
  const claimToken = params.get('claimToken');
  const reclaimHost = params.get('reclaimHost') === '1';
  const autojoin = params.get('autojoin') === '1';

  const normalizedQueryName = queryName ? String(queryName).trim().slice(0, 24) : '';
  const normalizedReclaimName = reclaimName ? String(reclaimName).trim().slice(0, 24) : '';

  if (queryGame === 'mafia' || queryGame === 'amongus') {
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
    reclaimHost,
    claimToken: claimToken ? String(claimToken).trim() : '',
  };
}

function emitAck(event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function setStatus(text) {
  playStatus.textContent = text;
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
  return me.game === 'mafia' ? `mafia:${name}` : `amongus:${name}`;
}

function renderClaimSeats(data) {
  if (!claimSeatsView) return;
  const seats = data?.claimable || [];

  const suggestedButton = suggestedReclaim?.name
    ? `<button class="btn btn-primary" type="button" data-claim-name="${suggestedReclaim.name}" data-claim-suggested="1">Reclaim suggested seat: ${suggestedReclaim.name}${suggestedReclaim.hostSeat ? ' (host)' : ''}</button>`
    : '';

  if (!seats.length) {
    claimSeatsView.innerHTML = suggestedButton || 'No reconnect seats found for this lobby.';
    return;
  }

  claimSeatsView.innerHTML = [
    '<strong>Reconnect seats:</strong>',
    suggestedButton,
    ...seats.map((seat) => `
      <button class="btn btn-soft" type="button" data-claim-name="${seat.name}">
        Claim ${seat.name}${seat.hostSeat ? ' (host)' : ''}
      </button>
    `),
  ].filter(Boolean).join(' ');
}

async function loadClaimableSeats() {
  const mode = gameMode?.value === 'amongus' ? 'amongus' : 'mafia';
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
      return;
    }
    renderClaimSeats(data);
  } catch (_err) {
    claimSeatsView.textContent = 'Could not load reconnect seats';
  }
}

async function sendReconnectTelemetry(outcome) {
  const mode = gameMode?.value === 'amongus' ? 'amongus' : 'mafia';
  const roomId = me.roomId ? String(me.roomId).trim().toUpperCase() : '';
  if (!roomId) return;
  try {
    await fetch('/api/play/reconnect-telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, roomId, outcome }),
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

function updateControlState(state) {
  const players = state?.players || [];
  const isHost = !!(state?.hostPlayerId && me.playerId && state.hostPlayerId === me.playerId);
  const inLobby = state?.status === 'lobby';
  const finished = state?.status === 'finished';
  const minPlayersReady = players.length >= 4;
  const disconnectedHumans = players.filter((p) => !p.isBot && !p.isConnected);

  if (startBtn) {
    startBtn.disabled = !isHost || !inLobby;
    startBtn.title = !isHost ? 'Host only' : !inLobby ? 'Game already started' : 'Auto-fills bots + replaces disconnected lobby players';
    startBtn.textContent = inLobby ? 'Start Ready' : 'Start';
  }

  if (autofillBtn) {
    autofillBtn.disabled = !isHost || !inLobby;
    autofillBtn.title = !isHost ? 'Host only' : !inLobby ? 'Only available in lobby' : '';
  }

  if (rematchBtn) {
    rematchBtn.disabled = !isHost || !finished;
    rematchBtn.title = !isHost ? 'Host only' : !finished ? 'Available after game ends' : '';
  }

  if (!isHost && inLobby) {
    setStatus(`Waiting for host to start · players ${players.length}/4`);
  } else if (isHost && inLobby) {
    const reasons = [];
    if (!minPlayersReady) reasons.push(`needs ${Math.max(0, 4 - players.length)} more player(s)`);
    if (disconnectedHumans.length > 0) reasons.push(`${disconnectedHumans.length} disconnected player(s) will be replaced`);
    if (reasons.length > 0) {
      setStatus(`Start Ready check: ${reasons.join(' · ')}`);
    } else {
      setStatus('Lobby ready. Start Ready launches immediately.');
    }
  }
}

function renderState(state) {
  currentState = state;
  stateJson.textContent = JSON.stringify(state, null, 2);
  if (state.botAutoplay) {
    setStatus(`🤖 Bot autopilot active · ${state.phase || state.status}`);
  }
  updateControlState(state);

  playersView.innerHTML = (state.players || []).map((p) => `
    <article>
      <h3>${p.name}${p.isBot ? ' 🤖' : ''}</h3>
      <p>ID: ${p.id}</p>
      <p>${p.alive === false ? '☠️ dead' : '✅ alive'} · ${p.isConnected ? 'online' : 'offline'}</p>
      <p>${p.role ? `role: ${p.role}` : ''}</p>
    </article>
  `).join('') || '<p>No players</p>';

  renderActions(state);
}

function renderActions(state) {
  const aliveOthers = (state.players || []).filter((p) => p.id !== me.playerId && p.alive !== false);

  if (me.game === 'mafia') {
    if (state.status === 'finished') {
      actionsView.innerHTML = `<p>Winner: <strong>${state.winner}</strong></p>`;
      return;
    }

    if (state.phase === 'night') {
      actionsView.innerHTML = aliveOthers.map((p) => `<button class="btn btn-soft" data-action="nightKill" data-target="${p.id}" type="button">Night kill ${p.name}</button>`).join('') || '<p>No valid targets</p>';
      return;
    }

    if (state.phase === 'discussion') {
      actionsView.innerHTML = '<p>Discussion phase. Click Advance/Ready to move on.</p>';
      return;
    }

    if (state.phase === 'voting') {
      actionsView.innerHTML = aliveOthers.map((p) => `<button class="btn btn-primary" data-action="vote" data-target="${p.id}" type="button">Vote ${p.name}</button>`).join('') || '<p>No vote targets</p>';
      return;
    }
  }

  if (me.game === 'amongus') {
    if (state.status === 'finished') {
      actionsView.innerHTML = `<p>Winner: <strong>${state.winner}</strong></p>`;
      return;
    }

    if (state.phase === 'tasks') {
      actionsView.innerHTML = `
        <button class="btn btn-primary" data-action="task" type="button">Do task</button>
        ${aliveOthers.map((p) => `<button class="btn btn-soft" data-action="kill" data-target="${p.id}" type="button">Imposter kill ${p.name}</button>`).join('')}
        <button class="btn btn-soft" data-action="callMeeting" type="button">Call meeting</button>
      `;
      return;
    }

    if (state.phase === 'meeting') {
      actionsView.innerHTML = aliveOthers.map((p) => `<button class="btn btn-primary" data-action="vote" data-target="${p.id}" type="button">Vote eject ${p.name}</button>`).join('') || '<p>No vote targets</p>';
      return;
    }
  }

  actionsView.innerHTML = '<p>Waiting...</p>';
}

hostBtn?.addEventListener('click', async () => {
  me.game = gameMode.value;
  const res = await emitAck(activeEvent('room:create'), { name: playerName.value.trim() || 'Host' });
  if (!res?.ok) return setStatus(formatError(res, 'Host failed'));
  me.roomId = res.roomId;
  me.playerId = res.playerId;
  roomIdInput.value = me.roomId;
  setStatus(`Hosted ${me.game} room ${me.roomId}`);
  renderState(res.state);
  void loadClaimableSeats();
});

joinBtn?.addEventListener('click', async () => {
  me.game = gameMode.value;
  const res = await emitAck(activeEvent('room:join'), {
    roomId: roomIdInput.value.trim().toUpperCase(),
    name: playerName.value.trim() || 'Player',
  });
  if (!res?.ok) return setStatus(formatError(res, 'Join failed'));
  me.roomId = res.roomId;
  me.playerId = res.playerId;
  setStatus(`Joined ${me.game} room ${me.roomId}`);
  renderState(res.state);
  void loadClaimableSeats();
});

loadClaimsBtn?.addEventListener('click', async () => {
  await loadClaimableSeats();
});

claimSeatsView?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-claim-name]');
  if (!btn) return;
  const claimName = btn.getAttribute('data-claim-name') || '';
  if (!claimName) return;
  if (playerName) playerName.value = claimName;

  me.game = gameMode.value;
  const res = await emitAck(activeEvent('room:join'), {
    roomId: roomIdInput.value.trim().toUpperCase(),
    name: claimName,
  });
  if (!res?.ok) return setStatus(formatError(res, 'Claim failed'));

  me.roomId = res.roomId;
  me.playerId = res.playerId;
  suggestedReclaim = null;
  setStatus(`Reconnected as ${claimName}${res.playerId === currentState?.hostPlayerId ? ' (host)' : ''}`);
  renderState(res.state);
  void loadClaimableSeats();
});

quickMatchBtn?.addEventListener('click', async () => {
  try {
    const mode = gameMode?.value === 'amongus' ? 'amongus' : 'mafia';
    const name = playerName?.value?.trim() || `Player-${Math.floor(Math.random() * 999)}`;
    const res = await fetch('/api/play/quick-join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, name }),
    });
    const data = await res.json();
    if (!data?.ok || !data?.joinTicket?.joinUrl) {
      setStatus(formatError(data, 'Quick match failed'));
      return;
    }
    window.location.href = data.joinTicket.joinUrl;
  } catch (_err) {
    setStatus('Quick match failed');
  }
});

startBtn?.addEventListener('click', async () => {
  if (!me.roomId || !me.playerId) return setStatus('Host or join first');
  const eventName = currentState?.status === 'lobby' ? activeEvent('start-ready') : activeEvent('start');
  const res = await emitAck(eventName, { roomId: me.roomId, playerId: me.playerId });
  if (!res?.ok) return setStatus(formatError(res, 'Start failed'));
  const addedBots = Number(res.addedBots || 0);
  const removed = Number(res.removedDisconnectedHumans || 0);
  if (addedBots > 0 || removed > 0) {
    setStatus(`Game started · +${addedBots} bot(s), replaced ${removed} disconnected player(s)`);
  } else {
    setStatus('Game started');
  }
  renderState(res.state);
});

rematchBtn?.addEventListener('click', async () => {
  if (!me.roomId || !me.playerId) return setStatus('Host or join first');
  const res = await emitAck(activeEvent('rematch'), { roomId: me.roomId, playerId: me.playerId });
  if (!res?.ok) return setStatus(formatError(res, 'Rematch failed'));
  setStatus('Rematch started');
  renderState(res.state);
});

autofillBtn?.addEventListener('click', async () => {
  if (!me.roomId || !me.playerId) return setStatus('Host or join first');
  const res = await emitAck(activeEvent('autofill'), { roomId: me.roomId, playerId: me.playerId, minPlayers: 4 });
  if (!res?.ok) return setStatus(formatError(res, 'Auto-fill failed'));
  setStatus(`Auto-filled ${res.addedBots || 0} bot(s)`);
  renderState(res.state);
});

advanceBtn?.addEventListener('click', async () => {
  if (!me.roomId) return;
  if (me.game === 'mafia' && currentState?.phase === 'discussion') {
    const res = await emitAck('mafia:action', { roomId: me.roomId, playerId: me.playerId, type: 'ready' });
    if (res?.ok) renderState(res.state);
  } else if (me.game === 'amongus' && currentState?.phase === 'tasks') {
    const res = await emitAck('amongus:action', { roomId: me.roomId, playerId: me.playerId, type: 'callMeeting' });
    if (res?.ok) renderState(res.state);
  }
});

actionsView?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const type = btn.getAttribute('data-action');
  const targetId = btn.getAttribute('data-target') || undefined;
  const res = await emitAck(activeEvent('action'), { roomId: me.roomId, playerId: me.playerId, type, targetId });
  if (!res?.ok) return setStatus(formatError(res, 'Action failed'));
  renderState(res.state);
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
  const { autojoin, reclaimName, reclaimHost, queryName, claimToken } = parseQueryConfig();
  if (!autojoin || attemptedAutoJoin) return;
  attemptedAutoJoin = true;

  const roomId = roomIdInput?.value?.trim().toUpperCase();
  if (!roomId) return;

  me.game = gameMode?.value === 'amongus' ? 'amongus' : 'mafia';
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
      renderState(retry.state);
      const reclaimed = await attemptSuggestedReclaimAuto();
      void loadClaimableSeats();
      if (!reclaimed) {
        setStatus(`Reconnect token expired/used. Joined as ${fallbackName}; use "Reclaim suggested seat" below if needed.`);
      }
      return;
    }

    setStatus(`Reconnect token failed. ${formatError(retry, `Quick-join failed for room ${roomId}`)}`);
    void loadClaimableSeats();
    return;
  }

  if (!res?.ok) {
    setStatus(formatError(res, `Quick-join failed for room ${roomId}`));
    return;
  }

  suggestedReclaim = null;
  me.roomId = res.roomId;
  me.playerId = res.playerId;
  setStatus(reclaimName ? `Reconnected ${reclaimName} in ${me.game} room ${me.roomId}` : `Quick-joined ${me.game} room ${me.roomId}`);
  renderState(res.state);
  void loadClaimableSeats();
}

setInterval(() => {
  void refreshOpsStatus();
}, 3000);

void refreshOpsStatus();
void autoJoinFromQuery();
