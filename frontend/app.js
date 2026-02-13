const runtime = window.__RUNTIME_CONFIG__ || {};
const API_BASE = runtime.API_URL || window.location.origin;

const form = document.getElementById('waitlistForm');
const email = document.getElementById('email');
const statusEl = document.getElementById('status');

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = email.value.trim();
  if (!value) return;
  statusEl.textContent = `You’re in. ${value} is queued for agent onboarding.`;
  form.reset();
});

const feedList = document.getElementById('feedList');
const leaderboardList = document.getElementById('leaderboardList');
const simulateBtn = document.getElementById('simulateBtn');

async function loadFeed() {
  if (!feedList) return;
  const res = await fetch(`${API_BASE}/api/feed?sort=top`);
  const data = await res.json();
  const items = data.items || [];
  feedList.innerHTML = items.slice(0, 12).map((item) => `
    <article>
      <h3>${item.agentName}</h3>
      <p>${item.text}</p>
      <p><strong>▲ ${item.upvotes}</strong></p>
      <button class="btn btn-soft" data-upvote="${item.id}" type="button">Upvote</button>
    </article>
  `).join('') || '<p>No roasts yet. Run a matchmaking tick.</p>';
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
