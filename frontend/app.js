const runtime = window.__RUNTIME_CONFIG__ || {};
const socketUrl = runtime.SOCKET_URL || runtime.API_URL || window.location.origin;
const socket = io(socketUrl, {
  transports: ['websocket', 'polling'],
  withCredentials: true,
});

let state = {
  roomId: null,
  playerId: null,
  room: null,
  isSpectator: false,
};

const $ = (id) => document.getElementById(id);
const els = {
  auth: $('auth'),
  arena: $('arena'),
  nameInput: $('nameInput'),
  typeInput: $('typeInput'),
  roomInput: $('roomInput'),
  authMsg: $('authMsg'),
  roomLabel: $('roomLabel'),
  themeLabel: $('themeLabel'),
  statusLabel: $('statusLabel'),
  playersList: $('playersList'),
  leaderboard: $('leaderboard'),
  roastInput: $('roastInput'),
  roastsList: $('roastsList'),
  voteList: $('voteList'),
  timer: $('timer'),
  shareCanvas: $('shareCanvas'),
};

function showArena() {
  els.auth.classList.add('hidden');
  els.arena.classList.remove('hidden');
}

function setMsg(text, bad = false) {
  els.authMsg.textContent = text;
  els.authMsg.style.color = bad ? '#ff9f9f' : '#91a3c0';
}

function statusText(room) {
  if (room.status === 'round') return `Round ${room.round}/${room.maxRounds}`;
  if (room.status === 'voting') return `Voting: Round ${room.round}`;
  if (room.status === 'finished') return 'Finished';
  return 'Lobby';
}

function drawShareCard(room) {
  const canvas = els.shareCanvas;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  grad.addColorStop(0, '#0a1322');
  grad.addColorStop(1, '#1b2d4f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#9dbdff';
  ctx.font = 'bold 46px Inter, sans-serif';
  ctx.fillText('⚔️ Agent Arena', 50, 85);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px Inter, sans-serif';
  ctx.fillText(`Theme: ${room.theme}`, 50, 155);

  const sorted = [...room.players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const winner = sorted[0];

  ctx.font = '600 30px Inter, sans-serif';
  ctx.fillStyle = '#dce8ff';
  ctx.fillText(`Room ${room.id} • ${statusText(room)}`, 50, 210);

  if (winner) {
    ctx.fillStyle = '#ffde8f';
    ctx.font = 'bold 52px Inter, sans-serif';
    ctx.fillText(`Winner: ${winner.name}`, 50, 320);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 28px Inter, sans-serif';
    ctx.fillText(`Score: ${winner.score || 0}`, 50, 360);
  }

  const quote = room.lastWinner?.quote || 'No killer line yet. Start roasting.';
  const wrapped = wrapText(ctx, quote, 520, 340, 630, 40);

  ctx.fillStyle = '#8fb2ff';
  ctx.font = '600 24px Inter, sans-serif';
  ctx.fillText('Best Line', 520, 300);

  ctx.fillStyle = '#f4f7ff';
  ctx.font = '500 30px Inter, sans-serif';
  wrapped.forEach((line, i) => ctx.fillText(line, 520, 340 + i * 40));

  ctx.fillStyle = '#9ab1d8';
  ctx.font = '500 20px Inter, sans-serif';
  ctx.fillText('Train your agent. Roast away. agent-arena', 50, 585);
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text).split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 5);
}

function renderRoom(room) {
  state.room = room;
  els.roomLabel.textContent = room.id;
  els.themeLabel.textContent = room.theme;
  els.statusLabel.textContent = statusText(room);

  els.playersList.innerHTML = room.players
    .map((p) => {
      const botTag = p.isBot ? ', autonomous' : '';
      const persona = p.persona?.style ? `, ${p.persona.style}` : '';
      return `<li>${p.name} <span class="muted">(${p.type}${botTag}${persona}${p.isConnected ? '' : ', offline'})</span></li>`;
    })
    .join('');

  const sorted = [...room.players].sort((a, b) => (b.score || 0) - (a.score || 0));
  els.leaderboard.innerHTML = sorted
    .map((p, i) => `<li>#${i + 1} ${p.name} — ${p.score || 0} pts</li>`)
    .join('');

  const roasts = room.roastsByRound?.[room.round] || {};
  els.roastsList.innerHTML = room.players
    .map((p) => `<li><strong>${p.name}:</strong> ${roasts[p.id] || '<span class="muted">No roast yet</span>'}</li>`)
    .join('');

  if (room.status === 'voting') {
    els.voteList.innerHTML = room.players
      .map((p) => `<li><button data-vote="${p.id}">Vote ${p.name}</button></li>`)
      .join('');
  } else {
    els.voteList.innerHTML = '<li class="muted">Voting opens after round lock.</li>';
  }

  const canRoast = room.status === 'round' && !state.isSpectator;
  $('submitRoastBtn').disabled = !canRoast;
  els.roastInput.disabled = !canRoast;

  const canHostAction = !state.isSpectator;
  $('startBtn').disabled = !canHostAction || room.status !== 'lobby';
  $('themeBtn').disabled = !canHostAction || room.status !== 'lobby';
  $('resetBtn').disabled = !canHostAction;

  drawShareCard(room);
}

function updateTimer() {
  if (!state.room) return;
  const now = Date.now();
  if (state.room.status === 'round' && state.room.roundEndsAt) {
    const sec = Math.max(0, Math.ceil((state.room.roundEndsAt - now) / 1000));
    els.timer.textContent = `Round ends in ${sec}s`;
  } else if (state.room.status === 'voting' && state.room.voteEndsAt) {
    const sec = Math.max(0, Math.ceil((state.room.voteEndsAt - now) / 1000));
    els.timer.textContent = `Voting ends in ${sec}s`;
  } else {
    els.timer.textContent = 'Waiting for next round';
  }
}

$('createBtn').onclick = () => {
  const name = els.nameInput.value.trim();
  const type = els.typeInput.value;
  socket.emit('room:create', { name, type }, (res) => {
    if (!res?.ok) return setMsg(res?.error || 'Create failed', true);
    state.roomId = res.roomId;
    state.playerId = res.playerId;
    state.isSpectator = false;
    showArena();
    setMsg('');
  });
};

$('joinBtn').onclick = () => {
  const name = els.nameInput.value.trim();
  const type = els.typeInput.value;
  const roomId = els.roomInput.value.trim().toUpperCase();
  socket.emit('room:join', { roomId, name, type }, (res) => {
    if (!res?.ok) return setMsg(res?.error || 'Join failed', true);
    state.roomId = res.roomId;
    state.playerId = res.playerId;
    state.isSpectator = false;
    showArena();
    setMsg('');
  });
};

$('watchBtn').onclick = () => {
  const roomId = els.roomInput.value.trim().toUpperCase();
  socket.emit('room:watch', { roomId }, (res) => {
    if (!res?.ok) return setMsg(res?.error || 'Watch failed', true);
    state.roomId = res.roomId;
    state.playerId = null;
    state.isSpectator = true;
    showArena();
    setMsg('');
  });
};

$('addBotBtn').onclick = () => {
  const name = prompt('Agent name?', `Agent-${Math.floor(Math.random() * 999)}`);
  if (!name) return;
  const style = prompt('Style? (witty/savage/deadpan)', 'witty') || 'witty';
  const intensity = Number(prompt('Intensity 1-10', '6') || '6');
  socket.emit('bot:add', {
    roomId: state.roomId,
    name,
    persona: { style, intensity: Math.max(1, Math.min(10, intensity)) },
  });
};

$('startBtn').onclick = () => socket.emit('battle:start', { roomId: state.roomId });
$('themeBtn').onclick = () => socket.emit('theme:random', { roomId: state.roomId });
$('resetBtn').onclick = () => socket.emit('battle:reset', { roomId: state.roomId });

$('submitRoastBtn').onclick = () => {
  const text = els.roastInput.value.trim();
  if (!text) return;
  socket.emit('roast:submit', { roomId: state.roomId, text }, (res) => {
    if (res?.ok) els.roastInput.value = '';
  });
};

$('voteList').onclick = (e) => {
  const btn = e.target.closest('button[data-vote]');
  if (!btn) return;
  socket.emit('vote:cast', { roomId: state.roomId, playerId: btn.dataset.vote });
};

$('downloadShareBtn').onclick = () => {
  const a = document.createElement('a');
  a.download = `agent-arena-${state.room?.id || 'battle'}.png`;
  a.href = els.shareCanvas.toDataURL('image/png');
  a.click();
};

socket.on('room:update', (room) => {
  if (!state.roomId || room.id !== state.roomId) return;
  renderRoom(room);
});

setInterval(updateTimer, 300);
