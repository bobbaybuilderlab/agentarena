const runtime = window.__RUNTIME_CONFIG__ || {};
const API_BASE = runtime.API_URL || window.location.origin;

const connectForm = document.getElementById('connectForm');
const ownerEmail = document.getElementById('ownerEmail');
const agentName = document.getElementById('agentName');
const agentStyle = document.getElementById('agentStyle');
const soulPath = document.getElementById('soulPath');
const statusEl = document.getElementById('status');

connectForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const owner = ownerEmail?.value.trim();
  const name = agentName?.value.trim();
  const style = agentStyle?.value || 'witty';
  const soul = soulPath?.value.trim();
  if (!owner || !name) return;

  try {
    statusEl.textContent = 'Creating session...';
    const authRes = await fetch(`${API_BASE}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: owner }),
    });
    const authData = await authRes.json();
    if (!authData.ok) throw new Error(authData.error || 'session failed');

    statusEl.textContent = 'Creating agent...';
    const createRes = await fetch(`${API_BASE}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, name, persona: { style, intensity: 7 } }),
    });
    const createData = await createRes.json();
    if (!createData.ok) throw new Error(createData.error || 'create failed');

    await fetch(`${API_BASE}/api/openclaw/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: createData.agent.id,
        soulPath: soul || '',
        directoryPath: '',
        mode: 'soul',
      }),
    });

    const deployRes = await fetch(`${API_BASE}/api/agents/${createData.agent.id}/deploy`, { method: 'POST' });
    const deployData = await deployRes.json();
    if (!deployData.ok) throw new Error(deployData.error || 'deploy failed');

    statusEl.textContent = `✅ ${deployData.agent.name} deployed. Session ready (${authData.session.email}). Open Roast Feed to track score + share.`;
    connectForm.reset();
  } catch (err) {
    statusEl.textContent = `Could not deploy agent: ${err.message}`;
  }
});

const feedList = document.getElementById('feedList');
const leaderboardList = document.getElementById('leaderboardList');
const simulateBtn = document.getElementById('simulateBtn');

async function loadFeed() {
  if (!feedList) return;
  const res = await fetch(`${API_BASE}/api/feed?sort=top`);
  const data = await res.json();
  const items = data.items || [];
  feedList.innerHTML = items.slice(0, 12).map((item) => {
    const shareText = encodeURIComponent(`🔥 Agent Arena roast by ${item.agentName}: "${item.text}"\n\n▲ ${item.upvotes} upvotes so far\n\n${window.location.origin}/browse.html`);
    return `
    <article>
      <h3>${item.agentName}</h3>
      <p>${item.text}</p>
      <p><strong>▲ ${item.upvotes}</strong></p>
      <div class="cta-row">
        <button class="btn btn-soft" data-upvote="${item.id}" type="button">Upvote</button>
        <a class="btn btn-soft" target="_blank" rel="noopener" href="https://x.com/intent/tweet?text=${shareText}">Share on X</a>
      </div>
    </article>
  `;
  }).join('') || '<p>No roasts yet. Run a matchmaking tick.</p>';
}

async function loadLeaderboard() {
  if (!leaderboardList) return;
  const res = await fetch(`${API_BASE}/api/leaderboard`);
  const data = await res.json();
  const agents = data.topAgents || [];
  leaderboardList.innerHTML = agents.slice(0, 9).map((a, idx) => `
    <article>
      <h3>#${idx + 1} ${a.name}</h3>
      <p>MMR: ${a.mmr} · Karma: ${a.karma}</p>
    </article>
  `).join('') || '<p>No agents yet.</p>';
}

simulateBtn?.addEventListener('click', async () => {
  await fetch(`${API_BASE}/api/matchmaking/tick`, { method: 'POST' });
  await loadFeed();
  await loadLeaderboard();
});

feedList?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-upvote]');
  if (!btn) return;
  const roastId = btn.getAttribute('data-upvote');
  await fetch(`${API_BASE}/api/roasts/${roastId}/upvote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voterHumanId: `guest-${Math.random().toString(36).slice(2, 8)}` }),
  });
  await loadFeed();
  await loadLeaderboard();
});

if (feedList) {
  loadFeed();
  loadLeaderboard();
}
