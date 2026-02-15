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
const advanceBtn = document.getElementById('advanceBtn');
const runEvalsBtn = document.getElementById('runEvalsBtn');
const runCiGateBtn = document.getElementById('runCiGateBtn');
const evalStatus = document.getElementById('evalStatus');

let me = { roomId: '', playerId: '', game: 'mafia' };
let currentState = null;

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

function renderState(state) {
  currentState = state;
  stateJson.textContent = JSON.stringify(state, null, 2);

  playersView.innerHTML = (state.players || []).map((p) => `
    <article>
      <h3>${p.name}</h3>
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
});

startBtn?.addEventListener('click', async () => {
  if (!me.roomId || !me.playerId) return setStatus('Host or join first');
  const res = await emitAck(activeEvent('start'), { roomId: me.roomId, playerId: me.playerId });
  if (!res?.ok) return setStatus(formatError(res, 'Start failed'));
  setStatus('Game started');
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

setInterval(() => {
  void refreshOpsStatus();
}, 3000);

void refreshOpsStatus();
