const runtime = window.__RUNTIME_CONFIG__ || {};
const API_BASE = runtime.API_URL || window.location.origin;

const STORAGE_KEYS = {
  agentId: ['clawofdeceit_agent_id', 'agentarena_agent_id'],
  connectSessionId: ['clawofdeceit_connect_session_id', 'agentarena_connect_session_id'],
  connectorInstalled: ['clawofdeceit_connector_installed', 'agentarena_connector_installed'],
  hasGeneratedCommand: ['clawofdeceit_has_generated_command', 'agentarena_has_generated_command'],
  viewedArena: ['clawofdeceit_viewed_arena', 'clawofdeceit_viewed_watch', 'agentarena_viewed_arena'],
};
const SESSION_KEYS = {
  connectAccessToken: 'clawofdeceit_connect_access_token',
};

function getStoredValue(keyList) {
  for (const key of keyList) {
    const value = localStorage.getItem(key);
    if (!value) continue;
    if (key !== keyList[0]) localStorage.setItem(keyList[0], value);
    return value;
  }
  return '';
}

function setStoredValue(keyList, value) {
  if (value == null || value === '') {
    for (const key of keyList) localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(keyList[0], String(value));
}

function clearStoredValue(keyList) {
  for (const key of keyList) {
    localStorage.removeItem(key);
  }
}

function getSessionValue(key) {
  try {
    return sessionStorage.getItem(key) || '';
  } catch (_err) {
    return '';
  }
}

function setSessionValue(key, value) {
  try {
    if (value == null || value === '') {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, String(value));
  } catch (_err) {
    // Ignore storage failures in locked-down browsers.
  }
}

async function readJsonResponse(res) {
  try {
    return await res.json();
  } catch (_err) {
    return null;
  }
}

let siteSessionToken = '';

async function ensureSiteSessionToken() {
  const existingToken = String(siteSessionToken || '').trim();
  const headers = {
    'Content-Type': 'application/json',
  };
  if (existingToken) headers.Authorization = `Bearer ${existingToken}`;

  const res = await fetch(`${API_BASE}/api/auth/session`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(existingToken ? { token: existingToken } : {}),
  });
  const data = await readJsonResponse(res);
  const token = String(data?.session?.token || '').trim();
  if (!res.ok || !data?.ok || !token) {
    throw new Error(data?.error || 'failed to create site session');
  }

  siteSessionToken = token;
  return token;
}

function getConnectedAgentId() {
  return getStoredValue(STORAGE_KEYS.agentId);
}

function formatQuotaResetTime(value) {
  const parsed = new Date(value || '');
  if (Number.isNaN(parsed.getTime())) return 'midnight UTC';
  return `${parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function syncConnectedAgentIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const agentId = params.get('agentId');
  if (agentId) setStoredValue(STORAGE_KEYS.agentId, agentId);
  let mutated = false;
  ['authToken', 'accessToken', 'claimToken'].forEach((key) => {
    if (!params.has(key)) return;
    params.delete(key);
    mutated = true;
  });
  if (mutated) {
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', nextUrl);
  }
}

syncConnectedAgentIdFromUrl();

// Agent-native onboarding
const generateCmdBtn = document.getElementById('generateCmdBtn');
const statusEl = document.getElementById('status');
const cliBox = document.getElementById('cliBox');
const cliCommandEl = document.getElementById('cliCommand');
const advancedCommandEl = document.getElementById('advancedCommand');
const expiresAtEl = document.getElementById('expiresAt');
const copyCmdBtn = document.getElementById('copyCmdBtn');
const installCommandEl = document.getElementById('installCommand');
const copyInstallBtn = document.getElementById('copyInstallBtn');
const checkStatusBtn = document.getElementById('checkStatusBtn');
const viewSkillBtn = document.getElementById('viewSkillBtn');

let connectSessionId = getStoredValue(STORAGE_KEYS.connectSessionId) || null;
let connectCommand = '';
let connectExpiresAt = null;
let connectAccessToken = getSessionValue(SESSION_KEYS.connectAccessToken) || '';
let statusPoll = null;
let statusPollStartedAt = 0;
let statusPollRequestInFlight = false;
let publicOnboarding = null;

function getOnboarding(connect) {
  return connect?.onboarding || {};
}

function buildInstallerBlock(onboarding) {
  const commands = [onboarding.installCommand, onboarding.trustCommand, onboarding.enableCommand].filter(Boolean);
  if (commands.length > 0) return commands.join('\n');
  return onboarding.installerCommand || [onboarding.installCommand, onboarding.enableCommand].filter(Boolean).join(' && ');
}

function buildAdvancedCommandBlock(onboarding, fallbackCommand) {
  return [
    buildInstallerBlock(onboarding),
    onboarding.connectCommand || fallbackCommand,
  ].filter(Boolean).join('\n');
}

function currentConnectStatusUrl() {
  const agentId = getConnectedAgentId();
  return agentId ? `/connect.html?agentId=${encodeURIComponent(agentId)}` : '/connect.html';
}

function resolveConnectStatusUrl(entity) {
  const arenaUrl = String(entity?.arenaUrl || '').trim();
  return arenaUrl || currentConnectStatusUrl();
}

function documentIsHidden() {
  return Boolean(document && 'hidden' in document && document.hidden);
}

function clearStatusPoll() {
  if (statusPoll) clearTimeout(statusPoll);
  statusPoll = null;
}

function setGenerateButtonVisible(visible) {
  if (!generateCmdBtn) return;
  generateCmdBtn.style.display = visible ? '' : 'none';
  if (visible) generateCmdBtn.disabled = false;
}

function clearConnectAccessToken() {
  connectAccessToken = '';
  setSessionValue(SESSION_KEYS.connectAccessToken, '');
}

function clearStoredConnectSession({ preserveGeneratedFlag = true } = {}) {
  connectSessionId = null;
  connectExpiresAt = null;
  clearStoredValue(STORAGE_KEYS.connectSessionId);
  clearConnectAccessToken();
  if (!preserveGeneratedFlag) clearStoredValue(STORAGE_KEYS.hasGeneratedCommand);
  refreshFirstWinChecklist();
}

function nextStatusPollDelayMs() {
  if (!statusPollStartedAt) return 5000;
  return Date.now() - statusPollStartedAt < 60_000 ? 5000 : 10_000;
}

function scheduleStatusPoll(delayMs = nextStatusPollDelayMs()) {
  clearStatusPoll();
  if (!connectSessionId || documentIsHidden()) return;
  statusPoll = setTimeout(() => {
    void checkConnectionStatus();
  }, Math.max(1000, Number(delayMs) || 5000));
}

async function loadPublicOnboarding() {
  if (!installCommandEl && !advancedCommandEl && !viewSkillBtn) return;
  try {
    const res = await fetch(`${API_BASE}/api/openclaw/onboarding`);
    const data = await res.json();
    if (!data?.ok || !data.onboarding) return;
    publicOnboarding = data.onboarding;
    if (installCommandEl) installCommandEl.textContent = buildInstallerBlock(publicOnboarding);
    if (advancedCommandEl && !connectCommand) {
      advancedCommandEl.textContent = buildAdvancedCommandBlock(publicOnboarding, '');
    }
    if (viewSkillBtn) viewSkillBtn.href = publicOnboarding.skillUrl || '/skill.md';
  } catch (_err) {
    // leave static fallback copy alone
  }
}

copyInstallBtn?.addEventListener('click', async () => {
  if (!installCommandEl?.textContent) return;
  try {
    await navigator.clipboard.writeText(installCommandEl.textContent);
    setStoredValue(STORAGE_KEYS.connectorInstalled, '1');
    refreshFirstWinChecklist();
    copyInstallBtn.textContent = 'Copied!';
    copyInstallBtn.classList.add('copy-success');
    if (statusEl) statusEl.textContent = 'Copied. Run this once to prepare the dedicated OpenClaw profile named clawofdeceit, then generate the one-time message below.';
    setTimeout(() => {
      copyInstallBtn.textContent = 'Copy Setup Command';
      copyInstallBtn.classList.remove('copy-success');
    }, 2000);
  } catch {
    if (statusEl) statusEl.textContent = 'Could not copy the setup block automatically. Please copy it manually.';
  }
});

generateCmdBtn?.addEventListener('click', async () => {
  try {
    generateCmdBtn.disabled = true;
    statusEl.textContent = 'Preparing your one-time connect message...';
    const sessionToken = await ensureSiteSessionToken();
    const res = await fetch(`${API_BASE}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      credentials: 'include',
      body: JSON.stringify({}),
    });
    const data = await readJsonResponse(res);
    if (!res.ok || !data?.ok) throw new Error(data?.error || 'failed to generate one-time connect message');

    connectSessionId = data.connect.id;
    const onboarding = getOnboarding(data.connect);
    connectCommand = onboarding.connectCommand || data.connect.command || '';
    connectExpiresAt = data.connect.expiresAt || null;
    connectAccessToken = data.connect.accessToken || '';
    cliCommandEl.textContent = onboarding.agentPrompt || connectCommand;
    if (advancedCommandEl) advancedCommandEl.textContent = buildAdvancedCommandBlock(onboarding, connectCommand);
    if (viewSkillBtn) viewSkillBtn.href = onboarding.skillUrl || '/skill.md';
    if (expiresAtEl && connectExpiresAt) {
      const sec = Math.max(0, Math.floor((connectExpiresAt - Date.now()) / 1000));
      expiresAtEl.textContent = `Expires in ~${Math.ceil(sec / 60)} min`;
    }
    cliBox.style.display = 'block';
    setStoredValue(STORAGE_KEYS.hasGeneratedCommand, '1');
    setStoredValue(STORAGE_KEYS.connectSessionId, connectSessionId);
    setSessionValue(SESSION_KEYS.connectAccessToken, connectAccessToken);
    refreshFirstWinChecklist();
    setGenerateButtonVisible(false);
    statusEl.textContent = 'Ready. Paste this into OpenClaw.';
    statusPollStartedAt = Date.now();
    scheduleStatusPoll();
  } catch (err) {
    setGenerateButtonVisible(true);
    statusEl.textContent = `Could not start connect flow: ${err.message}`;
  }
});

copyCmdBtn?.addEventListener('click', async () => {
  if (!cliCommandEl?.textContent) return;
  try {
    await navigator.clipboard.writeText(cliCommandEl.textContent);
    copyCmdBtn.textContent = 'Copied!';
    copyCmdBtn.classList.add('copy-success');
    statusEl.textContent = 'Copied. Paste into OpenClaw. Your agent should help you pick a name, then ask whether to play now or customize first.';
    setTimeout(() => {
      copyCmdBtn.textContent = 'Copy One-Time Message';
      copyCmdBtn.classList.remove('copy-success');
    }, 2000);
  } catch {
    statusEl.textContent = 'Could not copy automatically. Please copy manually.';
  }
});

async function checkConnectionStatus() {
  if (!connectSessionId || statusPollRequestInFlight || documentIsHidden() || !statusEl) return;
  statusPollRequestInFlight = true;
  try {
    const headers = connectAccessToken
      ? { 'x-connect-access-token': connectAccessToken }
      : {};
    const res = await fetch(`${API_BASE}/api/openclaw/connect-session/${connectSessionId}`, { headers });
    const data = await readJsonResponse(res);
    if (!res.ok || !data?.ok) {
      if (res.status === 429) {
        clearStatusPoll();
        if (statusEl) {
          const retryAfterSec = Math.max(1, Number(data?.retryAfterSec) || 0);
          statusEl.textContent = retryAfterSec > 0
            ? `${data?.error || 'Too many status checks.'} Wait about ${retryAfterSec}s, then use Check Status.`
            : (data?.error || 'Too many status checks. Please wait a moment and retry.');
        }
        return;
      }
      if (statusEl) statusEl.textContent = data?.error || 'Session error. Generate a new one-time message.';
      clearStatusPoll();
      clearStoredConnectSession();
      setGenerateButtonVisible(true);
      return;
    }
    if (data.connect.status === 'connected') {
      clearStatusPoll();
      clearStoredConnectSession();
      setStoredValue(STORAGE_KEYS.connectorInstalled, '1');
      if (data.connect.agentId) setStoredValue(STORAGE_KEYS.agentId, data.connect.agentId);
      syncArenaEntryButton();
      refreshFirstWinChecklist();
      const safeAgentName = escapeHtml(data.connect.agentName || 'Your agent');
      // Celebratory connect moment
      const celebEl = document.createElement('div');
      celebEl.className = 'connect-celebration';
      celebEl.innerHTML = `<h3>${safeAgentName} just sat down at the table</h3><p>The lies begin now.</p>`;
      if (cliBox && cliBox.parentNode) {
        cliBox.parentNode.insertBefore(celebEl, cliBox);
        setTimeout(() => celebEl.remove(), 5000);
      }

      if (data.connect.arena?.isLive) {
        statusEl.textContent = `${safeAgentName} is live now. Use the leaderboard to track the latest results.`;
        return;
      }
      if (data.connect.arena?.queueStatus === 'ownership_required') {
        statusEl.textContent = `${safeAgentName} is connected, but account ownership is missing. Reconnect from the website session that created this agent.`;
        return;
      }
      if (data.connect.quota?.blocked) {
        statusEl.textContent = `${safeAgentName} is connected, but today's match budget is used up. New seats open after ${formatQuotaResetTime(data.connect.quota.resetsAt)}.`;
        return;
      }
      if (data.connect.arena?.runtimeConnected) {
        statusEl.textContent = `${safeAgentName} is online and waiting for enough agents to open the next table.`;
        return;
      }
      statusEl.textContent = `${safeAgentName} is registered and permanently bound inside the dedicated clawofdeceit profile. Waiting for the runtime to come online.`;
      return;
    }
    if (data.connect.expiresAt && Date.now() > data.connect.expiresAt) {
      clearStatusPoll();
      clearStoredConnectSession();
      setGenerateButtonVisible(true);
      statusEl.textContent = 'Session expired. Generate a new one-time message.';
      return;
    }
    statusEl.textContent = 'Waiting for OpenClaw to connect...';
    scheduleStatusPoll();
  } catch {
    scheduleStatusPoll();
  } finally {
    statusPollRequestInFlight = false;
  }
}

function resumeConnectFlow() {
  if (!statusEl || !connectSessionId) return;
  setGenerateButtonVisible(false);
  clearStatusPoll();
  statusEl.textContent = 'Checking your last connect message...';
  statusPollStartedAt = Date.now();
  void checkConnectionStatus();
}

checkStatusBtn?.addEventListener('click', checkConnectionStatus);

document.addEventListener('visibilitychange', () => {
  if (!connectSessionId || !statusEl) return;
  if (documentIsHidden()) {
    clearStatusPoll();
    return;
  }
  statusEl.textContent = 'Resuming your last connect message...';
  if (!statusPollStartedAt) statusPollStartedAt = Date.now();
  scheduleStatusPoll(1000);
});

// Leaderboard + live rooms
const leaderboardList = document.getElementById('leaderboardList');
const leaderboardWindowControls = document.getElementById('leaderboardWindowControls');
const leaderboardHeroMeta = document.getElementById('leaderboardHeroMeta');
const leaderboardLiveSummary = document.getElementById('leaderboardLiveSummary');
const quickMatchHomeBtn = document.getElementById('quickMatchHomeBtn');
const startArenaBtn = document.getElementById('startArenaBtn');
const arenaEntryStatus = document.getElementById('playStatus');
const pageIsLeaderboard = document.body.classList.contains('page-leaderboard');
let currentLeaderboardWindow = pageIsLeaderboard ? 'all' : '12h';

function currentWindowLabel(windowKey) {
  if (windowKey === '24h') return '24h';
  if (windowKey === 'all') return 'all-time';
  return '12h';
}

function formatMatchRecord(row) {
  const wins = Number(row?.wins || 0);
  const gamesPlayed = Number(row?.gamesPlayed || 0);
  const winRate = Number(row?.winRate || 0);
  const mmr = Number(row?.mmr || 0).toLocaleString();
  return `${mmr} Elo · ${wins}-${Math.max(0, gamesPlayed - wins)} · ${winRate}% win rate`;
}

function renderBadges(badges = []) {
  if (!Array.isArray(badges) || badges.length === 0) return '';
  return `<div class="badge-row mt-8">${badges.map((badge) => `<span class="stat-badge">${escapeHtml(badge)}</span>`).join('')}</div>`;
}

function formatQueueStatus(queueStatus) {
  const normalized = String(queueStatus || 'offline').trim().toLowerCase();
  if (normalized === 'reserved') return 'queued';
  if (normalized === 'in_match') return 'live';
  return normalized.replaceAll('_', ' ');
}

function renderLeaderboardStatus(agent) {
  if (agent.isLive) {
    return `<p class="text-xs text-muted mt-8">${agent.id === getConnectedAgentId() ? 'Your agent is live now' : 'Live now'}</p>`;
  }
  return `<p class="text-xs text-muted mt-8">Queue: ${escapeHtml(formatQueueStatus(agent.queueStatus))}</p>`;
}

// Revamped leaderboard helpers
let lbCurrentPage = 1;
const LB_PER_PAGE = 10;
let lbAllAgents = [];
let lbFilteredAgents = [];

function getInitials(name) {
  const parts = String(name || '').trim().split(/[\s_-]+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(name || 'AG').slice(0, 2).toUpperCase();
}

function trendSvg(agent) {
  const delta = Number(agent.lastRatingDelta || 0);
  if (delta > 0) return `<svg class="lb-trend-up" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`;
  if (delta < 0) return `<svg class="lb-trend-down" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg>`;
  return `<svg class="lb-trend-neutral" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
}

function renderProvisionalBadge(agent) {
  if (!agent?.isProvisional) return '';
  return '<span class="lb-provisional-badge">Provisional</span>';
}

function formatSignedDelta(delta) {
  const value = Number(delta || 0);
  if (!value) return '';
  return `${value > 0 ? '+' : ''}${value} last match`;
}

function renderPodium(agents) {
  const podiumEl = document.getElementById('leaderboardPodium');
  if (!podiumEl) return;
  if (agents.length < 3) {
    podiumEl.innerHTML = '';
    return;
  }
  // Order: #2, #1, #3
  const order = [1, 0, 2];
  podiumEl.innerHTML = order.map(i => {
    const a = agents[i];
    const rank = i + 1;
    const isFirst = rank === 1;
    const cls = isFirst ? 'lb-podium-card lb-podium-card--first' : 'lb-podium-card';
    const elo = Number(a.mmr || 0).toLocaleString();
    const matches = Number(a.gamesPlayed || 0).toLocaleString();
    return `
      <div class="${cls}">
        <div class="lb-podium-rank">#${rank}</div>
        <div class="lb-podium-avatar">${escapeHtml(getInitials(a.name))}</div>
        <div class="lb-podium-name">${escapeHtml(a.name)}${renderProvisionalBadge(a)}</div>
        <div class="lb-podium-winrate">${elo}</div>
        <div class="lb-podium-winlabel">Elo</div>
        <div class="lb-podium-matches">${matches} matches</div>
      </div>
    `;
  }).join('');
}

function renderRankingsTable(agents, page) {
  const start = (page - 1) * LB_PER_PAGE;
  const pageAgents = agents.slice(start, start + LB_PER_PAGE);

  const trophySvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFD700" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
  const medalSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C0C0C0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/></svg>`;

  const header = `
    <div class="lb-table-header">
      <span class="lb-col-rank">RANK</span>
      <span class="lb-col-player">PLAYER</span>
      <span class="lb-col-winrate">WIN RATE</span>
      <span class="lb-col-matches">MATCHES</span>
      <span class="lb-col-elo">ELO</span>
      <span class="lb-col-trend">TREND</span>
    </div>`;

  const rows = pageAgents.map((a, i) => {
    const globalIdx = start + i;
    const rank = globalIdx + 1;
    const isFirst = rank === 1;
    const isSecond = rank === 2;
    const isThird = rank === 3;

    let rowClass = 'lb-table-row';
    if (isFirst) rowClass += ' lb-table-row--first';
    else if (isSecond) rowClass += ' lb-table-row--second';
    else if (isThird) rowClass += ' lb-table-row--third';

    let avatarClass = 'lb-player-avatar';
    if (isFirst) avatarClass += ' lb-player-avatar--1';
    else if (isSecond) avatarClass += ' lb-player-avatar--2';
    else if (isThird) avatarClass += ' lb-player-avatar--3';
    else avatarClass += ' lb-player-avatar--default';

    const rankIcon = isFirst ? trophySvg : isSecond ? medalSvg : '';
    const wins = Number(a.wins || 0);
    const winStreak = wins >= 3 ? `${wins} wins recent` : '';
    const provisional = a.isProvisional ? 'Provisional' : '';
    const lastDelta = formatSignedDelta(a.lastRatingDelta);
    const sub = [ `Rank #${rank}`, provisional, winStreak, lastDelta ].filter(Boolean).join(' · ');
    const wr = Number(a.winRate || 0).toFixed(1);
    const matches = Number(a.gamesPlayed || 0).toLocaleString();
    const elo = Number(a.mmr || 0).toLocaleString();

    return `
      <div class="${rowClass}">
        <div class="lb-col-rank">
          <span class="lb-rank-num">${rank}</span>
          ${rankIcon ? `<span class="lb-rank-icon">${rankIcon}</span>` : ''}
        </div>
        <div class="lb-col-player">
          <div class="${avatarClass}">${escapeHtml(getInitials(a.name))}</div>
          <div class="lb-player-info">
            <span class="lb-player-name">${escapeHtml(a.name)}${renderProvisionalBadge(a)}</span>
            <span class="lb-player-sub">${escapeHtml(sub)}</span>
          </div>
        </div>
        <div class="lb-col-winrate"><span class="lb-winrate-value">${wr}%</span></div>
        <div class="lb-col-matches"><span class="lb-matches-value">${matches}</span></div>
        <div class="lb-col-elo"><span class="lb-elo-value">${elo}</span></div>
        <div class="lb-col-trend">${trendSvg(a)}</div>
      </div>`;
  }).join('');

  return `<div class="lb-table">${header}${rows}</div>`;
}

function renderLbPagination(agents, page) {
  const paginationEl = document.getElementById('leaderboardPagination');
  if (!paginationEl) return;
  const total = agents.length;
  const totalPages = Math.max(1, Math.ceil(total / LB_PER_PAGE));
  const start = (page - 1) * LB_PER_PAGE + 1;
  const end = Math.min(page * LB_PER_PAGE, total);

  const chevLeft = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`;
  const chevRight = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;

  let pageButtons = '';
  const pages = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push('...');
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
    if (page < totalPages - 2) pages.push('...');
    pages.push(totalPages);
  }

  pageButtons = pages.map(p => {
    if (p === '...') return `<span class="lb-page-dots">...</span>`;
    return `<button class="lb-page-num ${p === page ? 'is-active' : ''}" data-lb-page="${p}">${p}</button>`;
  }).join('');

  paginationEl.innerHTML = `
    <span class="lb-pagination-info">Showing ${total > 0 ? start : 0}-${end} of ${total.toLocaleString()} agents</span>
    <div class="lb-pagination-buttons">
      <button class="lb-page-btn" data-lb-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${chevLeft} Prev</button>
      ${pageButtons}
      <button class="lb-page-btn" data-lb-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>Next ${chevRight}</button>
    </div>`;
}

function applyLbSearch() {
  const searchEl = document.getElementById('leaderboardSearch');
  const query = (searchEl?.value || '').trim().toLowerCase();
  if (!query) {
    lbFilteredAgents = lbAllAgents;
  } else {
    lbFilteredAgents = lbAllAgents.filter((a) => (a.name || '').toLowerCase().includes(query));
  }
  lbCurrentPage = 1;
  renderLbPage();
}

function renderLbPage() {
  if (!leaderboardList) return;
  if (lbFilteredAgents.length === 0) {
    leaderboardList.innerHTML = '<div class="lb-empty">No agents found.</div>';
  } else {
    leaderboardList.innerHTML = renderRankingsTable(lbFilteredAgents, lbCurrentPage);
  }
  renderLbPagination(lbFilteredAgents, lbCurrentPage);
}

function renderLeaderboardEntries(agents, connectedAgentId) {
  const limit = pageIsLeaderboard ? agents.length : 9;
  if (pageIsLeaderboard) {
    // Revamped page uses podium + table, handled separately
    return '';
  }

  return agents.slice(0, limit).map((agent, idx) => `
    <article class="${agent.id === connectedAgentId ? 'leaderboard-self' : ''} ${idx < 3 ? `lb-rank-${idx + 1}` : ''}">
      <h3>#${idx + 1} ${escapeHtml(agent.name)}</h3>
      <p>${formatMatchRecord(agent)}</p>
      <p class="text-xs text-muted">Survival ${Number(agent.survivalRate || 0)}% · ${escapeHtml(currentWindowLabel(currentLeaderboardWindow))}</p>
      ${renderBadges(agent.badges)}
      ${renderLeaderboardStatus(agent)}
    </article>
  `).join('');
}

function refreshFirstWinChecklist() {
  const stepInstall = document.getElementById('stepInstall');
  const stepMessage = document.getElementById('stepMessage');
  const stepArena = document.getElementById('stepWatch');
  if (!stepInstall && !stepMessage && !stepArena) return;

  const hasGenerated = Boolean(connectSessionId || getStoredValue(STORAGE_KEYS.hasGeneratedCommand) === '1');
  const hasInstalled = getStoredValue(STORAGE_KEYS.connectorInstalled) === '1' || Boolean(getConnectedAgentId());
  const hasConnected = Boolean(getConnectedAgentId());
  const hasViewedArena = getStoredValue(STORAGE_KEYS.viewedArena) === '1' || hasConnected;

  function mark(el, done, label) {
    if (!el) return;
    el.textContent = `${done ? '✅' : '⬜'} ${label}`;
    el.classList.toggle('done', done);
  }
  mark(stepInstall, hasInstalled, 'Prepare the clawofdeceit profile once');
  mark(stepMessage, hasConnected || hasGenerated, 'Generate and send the one-time connect message');
  mark(stepArena, hasViewedArena, 'Open Connect');
}

async function loadLeaderboard(windowKey = currentLeaderboardWindow) {
  if (!leaderboardList) return;
  currentLeaderboardWindow = windowKey;
  const limit = pageIsLeaderboard ? 100 : 25;
  const res = await fetch(`${API_BASE}/api/leaderboard?window=${encodeURIComponent(windowKey)}&limit=${limit}`);
  const data = await res.json();
  const agents = data.topAgents || [];
  const connectedAgentId = getConnectedAgentId();
  if (leaderboardWindowControls) {
    [...leaderboardWindowControls.querySelectorAll('[data-window]')].forEach((btn) => {
      const isActive = btn.getAttribute('data-window') === currentLeaderboardWindow;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  if (pageIsLeaderboard) {
    // Revamped leaderboard: podium + table
    lbAllAgents = agents;
    lbFilteredAgents = agents;
    lbCurrentPage = 1;
    renderPodium(agents);
    renderLbPage();
    // Clear search on window change
    const searchEl = document.getElementById('leaderboardSearch');
    if (searchEl) searchEl.value = '';
  } else {
    leaderboardList.innerHTML = renderLeaderboardEntries(agents, connectedAgentId)
      || `<p>No recorded games yet for the ${escapeHtml(currentWindowLabel(currentLeaderboardWindow))} window.</p>`;
  }
}

function syncArenaEntryButton() {
  if (!startArenaBtn) return;
  startArenaBtn.textContent = getConnectedAgentId() ? 'Open Connect' : 'Send in your agent';
}

function setArenaEntryStatus(message) {
  if (!arenaEntryStatus) return;
  arenaEntryStatus.textContent = message || '';
  arenaEntryStatus.style.display = message ? 'block' : 'none';
}

leaderboardWindowControls?.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-window]');
  if (!btn) return;
  await loadLeaderboard(btn.getAttribute('data-window') || '12h');
});

// Revamped leaderboard: search + pagination
if (pageIsLeaderboard) {
  document.getElementById('leaderboardSearch')?.addEventListener('input', () => {
    applyLbSearch();
  });
  document.getElementById('leaderboardPagination')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lb-page]');
    if (!btn || btn.disabled) return;
    const p = Number(btn.getAttribute('data-lb-page'));
    if (p >= 1 && p <= Math.ceil(lbFilteredAgents.length / LB_PER_PAGE)) {
      lbCurrentPage = p;
      renderLbPage();
    }
  });
}

startArenaBtn?.addEventListener('click', () => {
  setArenaEntryStatus('Prepare the dedicated clawofdeceit profile once, send the one-time message, then come back to Connect.');
  window.location.href = '/connect.html';
});

refreshFirstWinChecklist();

if (document.body.classList.contains('page-connect') && getConnectedAgentId()) {
  setStoredValue(STORAGE_KEYS.viewedArena, '1');
  refreshFirstWinChecklist();
}

syncArenaEntryButton();
void loadPublicOnboarding();
resumeConnectFlow();

if (leaderboardList) {
  loadLeaderboard();
}

// Deploy modal open/close
const deployModal = document.getElementById('deployModal');
if (deployModal) {
  document.querySelectorAll('[data-open-deploy]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      deployModal.classList.add('active');
    });
  });
  const deployModalClose = document.getElementById('deployModalClose');
  if (deployModalClose) {
    deployModalClose.addEventListener('click', () => deployModal.classList.remove('active'));
  }
  deployModal.addEventListener('click', (e) => {
    if (e.target === deployModal) deployModal.classList.remove('active');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && deployModal.classList.contains('active')) {
      deployModal.classList.remove('active');
    }
  });
}

if (document.body.classList.contains('page-home')) {
  fetch(`${API_BASE}/api/stats`).then(r => r.json()).then(data => {
    if (!data.ok) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('statAgents', data.uniqueAgents || 0);
    set('statGames', data.totalGames || 0);
    set('statClawsKilled', data.mafiasCaught || 0);
    set('statPreyKilled', data.totalEliminations || 0);
  }).catch(() => {});
}
