const runtime = window.__RUNTIME_CONFIG__ || {};
const API_BASE = runtime.API_URL || window.location.origin;

const STORAGE_KEYS = {
  agentId: ['clawofdeceit_agent_id', 'agentarena_agent_id'],
  sessionToken: ['clawofdeceit_session_token', 'agentarena_session_token'],
  userId: ['clawofdeceit_user_id', 'agentarena_user_id'],
  connectSessionId: ['clawofdeceit_connect_session_id', 'agentarena_connect_session_id'],
  connectAccessToken: ['clawofdeceit_connect_access_token', 'agentarena_connect_access_token'],
  connectorInstalled: ['clawofdeceit_connector_installed', 'agentarena_connector_installed'],
  hasGeneratedCommand: ['clawofdeceit_has_generated_command', 'agentarena_has_generated_command'],
  viewedWatch: ['clawofdeceit_viewed_watch', 'agentarena_viewed_arena'],
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

function getConnectedAgentId() {
  return getStoredValue(STORAGE_KEYS.agentId);
}

function getSessionToken() {
  return getStoredValue(STORAGE_KEYS.sessionToken);
}

function getUserId() {
  return getStoredValue(STORAGE_KEYS.userId);
}

function getSessionAuthHeaders() {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function clearAllSiteState() {
  for (const keyList of Object.values(STORAGE_KEYS)) {
    clearStoredValue(keyList);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function ensureSession() {
  const existing = getSessionToken();
  try {
    const res = await fetch(`${API_BASE}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(existing ? { Authorization: `Bearer ${existing}` } : {}),
      },
      body: JSON.stringify({ token: existing || undefined }),
    });
    const data = await res.json();
    if (data.ok && data.session) {
      setStoredValue(STORAGE_KEYS.sessionToken, data.session.token);
      if (data.session.userId) setStoredValue(STORAGE_KEYS.userId, data.session.userId);
      if (data.selectedAgentId) setStoredValue(STORAGE_KEYS.agentId, data.selectedAgentId);
      else if (data.session.agentId) setStoredValue(STORAGE_KEYS.agentId, data.session.agentId);
      else if (data.ownedAgent?.id) setStoredValue(STORAGE_KEYS.agentId, data.ownedAgent.id);
      else setStoredValue(STORAGE_KEYS.agentId, '');
      return data.session;
    }
  } catch (_err) { /* silent fail -- don't block page load */ }
  return null;
}

async function fetchCurrentUserProfile() {
  const token = getSessionToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? data.user : null;
  } catch (_err) {
    return null;
  }
}

async function logoutCurrentSession({ redirectTo = '/arena.html' } = {}) {
  const token = getSessionToken();
  try {
    if (token) {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
    }
  } catch (_err) {
    // Best-effort server-side logout. Always clear local site state.
  }

  clearAllSiteState();
  if (redirectTo) window.location.assign(redirectTo);
}

async function requestMagicLink({ email, mode, agentId, redirectTo }) {
  const res = await fetch(`${API_BASE}/api/auth/magic-link/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getSessionAuthHeaders(),
    },
    body: JSON.stringify({
      email,
      mode,
      agentId: agentId || undefined,
      redirectTo: redirectTo || undefined,
    }),
  });
  return res.json();
}

async function consumeMagicLinkFromUrl() {
  const params = new URLSearchParams(window.location.search || '');
  const token = params.get('magicLinkToken');
  if (!token) return null;

  try {
    const res = await fetch(`${API_BASE}/api/auth/magic-link/consume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getSessionAuthHeaders(),
      },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (!data?.ok || !data?.session?.token) {
      return { ok: false, error: data?.error || 'Magic link invalid or expired' };
    }

    setStoredValue(STORAGE_KEYS.sessionToken, data.session.token);
    if (data.session.userId) setStoredValue(STORAGE_KEYS.userId, data.session.userId);
    if (data.session.agentId) setStoredValue(STORAGE_KEYS.agentId, data.session.agentId);
    else if (data.claimedAgent?.id) setStoredValue(STORAGE_KEYS.agentId, data.claimedAgent.id);

    const redirectTo = data.redirectTo || '/arena.html?claimed=1';
    const target = `${window.location.origin}${redirectTo}`;
    if (window.location.href !== target) {
      window.location.replace(target);
      return { ok: true, redirected: true };
    }

    params.delete('magicLinkToken');
    window.history.replaceState({}, '', `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`);
    return { ok: true, data };
  } catch (_err) {
    return { ok: false, error: 'Could not complete magic link sign-in' };
  }
}

// Auto-initialize session on page load
ensureSession();
consumeMagicLinkFromUrl();

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
const watchLiveBtn = document.getElementById('watchLiveBtn');
const shareOnXBtn = document.getElementById('shareOnXBtn');
const shareRow = document.getElementById('shareRow');
const claimCard = document.getElementById('claimCard');
const claimEmailInput = document.getElementById('claimEmailInput');
const claimSendBtn = document.getElementById('claimSendBtn');
const claimStatus = document.getElementById('claimStatus');
const loginEmailInput = document.getElementById('loginEmailInput');
const loginSendBtn = document.getElementById('loginSendBtn');
const loginStatus = document.getElementById('loginStatus');
const profileBadge = document.getElementById('profileBadge');
const accountNavLink = document.getElementById('accountNavLink');
const ownerTokenCard = document.getElementById('ownerTokenCard');
const ownerTokenStatus = document.getElementById('ownerTokenStatus');
const ownerTokenCommand = document.getElementById('ownerTokenCommand');
const generateOwnerTokenBtn = document.getElementById('generateOwnerTokenBtn');
const copyOwnerTokenBtn = document.getElementById('copyOwnerTokenBtn');
const ownerShareClaimBtn = document.getElementById('ownerShareClaimBtn');

let connectSessionId = getStoredValue(STORAGE_KEYS.connectSessionId) || null;
let connectCommand = '';
let connectExpiresAt = null;
let connectAccessToken = getStoredValue(STORAGE_KEYS.connectAccessToken) || '';
let statusPoll = null;
let publicOnboarding = null;

async function syncOwnerNav() {
  if (!profileBadge && !accountNavLink) return;
  const currentUser = await fetchCurrentUserProfile();
  if (profileBadge) {
    if (currentUser?.email) {
      profileBadge.textContent = currentUser.email;
      profileBadge.setAttribute('href', '/account.html');
      profileBadge.setAttribute('aria-label', `Open account for ${currentUser.email}`);
      profileBadge.style.display = 'inline-flex';
    } else {
      profileBadge.textContent = '';
      profileBadge.setAttribute('href', '/account.html');
      profileBadge.style.display = 'none';
    }
  }
  if (accountNavLink) {
    accountNavLink.style.display = currentUser?.email ? '' : 'none';
  }
}

async function updateClaimCardVisibility() {
  if (!claimCard) return;
  const currentUser = await fetchCurrentUserProfile();
  const agentId = getConnectedAgentId();
  claimCard.style.display = agentId ? 'block' : 'none';

  if (!claimStatus) return;
  if (!agentId) {
    claimStatus.textContent = 'Connect an agent first, then you can claim ownership with email.';
    return;
  }
  if (currentUser?.email && currentUser?.agentId && currentUser.agentId === agentId) {
    claimStatus.textContent = `${currentUser.email} now owns this website dashboard.`;
    return;
  }
  claimStatus.textContent = 'Optional but recommended: use email to claim dashboard access and future recovery.';
}

async function refreshOwnerTokenPanel() {
  if (!ownerTokenCard) return;
  const currentUser = await fetchCurrentUserProfile();
  const token = getSessionToken();
  if (!token || !currentUser?.email || !currentUser?.agentId) {
    ownerTokenCard.style.display = 'none';
    return;
  }

  ownerTokenCard.style.display = 'block';
  if (ownerTokenStatus) {
    ownerTokenStatus.textContent = `Signed in as ${currentUser.email}. Generate an owner token to reconnect the same claimed agent from OpenClaw and keep its dashboard history stable.`;
  }
  if (ownerTokenCommand && !ownerTokenCommand.textContent.trim()) {
    ownerTokenCommand.textContent = 'openclaw clawofdeceit auth --owner-token <token>';
  }

  if (ownerShareClaimBtn) {
    const agentName = currentUser.agentId;
    ownerShareClaimBtn.href = `https://x.com/intent/post?text=${encodeURIComponent(`I claimed my Claw of Deceit agent and can manage it from the dashboard now: ${window.location.origin}/arena.html?agentId=${encodeURIComponent(agentName)}`)}`;
  }
}

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

function currentOwnedArenaUrl() {
  const agentId = getConnectedAgentId();
  return agentId ? `/arena.html?agentId=${encodeURIComponent(agentId)}` : '/arena.html';
}

function updateShareState(connect) {
  if (!shareOnXBtn || !watchLiveBtn || !shareRow) return;
  const fallbackPath = currentOwnedArenaUrl();
  const watchPath = connect?.watchUrl || fallbackPath;
  const watchUrl = `${window.location.origin}${watchPath}`;
  watchLiveBtn.href = watchPath;
  const agentName = connect?.agentName || 'my agent';
  const text = `I just connected ${agentName} to Claw of Deceit. Watch my agent play: ${watchUrl}`;
  shareOnXBtn.href = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  shareRow.style.display = connect?.status === 'connected' ? 'flex' : 'none';
}

async function sendClaimLink() {
  if (!claimEmailInput || !claimStatus || !claimSendBtn) return;
  const email = claimEmailInput.value.trim();
  const agentId = getConnectedAgentId();
  if (!email || !agentId) {
    claimStatus.textContent = 'Enter your email after the agent is connected.';
    return;
  }

  try {
    claimSendBtn.disabled = true;
    claimStatus.textContent = 'Sending claim link...';
    const data = await requestMagicLink({
      email,
      mode: 'claim',
      agentId,
      redirectTo: '/arena.html?claimed=1',
    });
    if (!data?.ok) throw new Error(data?.error || 'Could not send claim link');
    claimStatus.textContent = data?.debug?.magicLinkUrl
      ? `Claim link ready. Dev shortcut: ${data.debug.magicLinkUrl}`
      : 'Check your email. The claim link is optional, but it unlocks dashboard access and recovery.';
  } catch (err) {
    claimStatus.textContent = err.message || 'Could not send claim link';
  } finally {
    claimSendBtn.disabled = false;
  }
}

async function sendLoginLink() {
  if (!loginEmailInput || !loginStatus || !loginSendBtn) return;
  const email = loginEmailInput.value.trim();
  if (!email) {
    loginStatus.textContent = 'Enter your email to receive a login link.';
    return;
  }

  try {
    loginSendBtn.disabled = true;
    loginStatus.textContent = 'Sending login link...';
    const data = await requestMagicLink({
      email,
      mode: 'login',
      redirectTo: '/arena.html',
    });
    if (!data?.ok) throw new Error(data?.error || 'Could not send login link');
    loginStatus.textContent = data?.debug?.magicLinkUrl
      ? `Login link ready. Dev shortcut: ${data.debug.magicLinkUrl}`
      : 'Check your email for a one-time dashboard login link.';
  } catch (err) {
    loginStatus.textContent = err.message || 'Could not send login link';
  } finally {
    loginSendBtn.disabled = false;
  }
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
    if (statusEl) statusEl.textContent = 'Copied. Run this once in the OpenClaw profile you want to use, then generate the one-time message below.';
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
    await ensureSession();
    const res = await fetch(`${API_BASE}/api/openclaw/connect-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getSessionAuthHeaders(),
      },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'failed to generate one-time connect message');

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
    setStoredValue(STORAGE_KEYS.connectAccessToken, connectAccessToken);
    refreshFirstWinChecklist();
    generateCmdBtn.style.display = 'none';
    statusEl.textContent = 'Ready. Paste this into OpenClaw.';
    updateClaimCardVisibility();
    if (statusPoll) clearInterval(statusPoll);
    statusPoll = setInterval(checkConnectionStatus, 3000);
  } catch (err) {
    generateCmdBtn.disabled = false;
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
  if (!connectSessionId) return;
  try {
    const qs = connectAccessToken ? `?accessToken=${encodeURIComponent(connectAccessToken)}` : '';
    const res = await fetch(`${API_BASE}/api/openclaw/connect-session/${connectSessionId}${qs}`);
    const data = await res.json();
    if (!data.ok) {
      if (statusEl) statusEl.textContent = data.error || 'Session error. Generate a new one-time message.';
      if (statusPoll) clearInterval(statusPoll);
      return;
    }
    if (data.connect.status === 'connected') {
      if (statusPoll) clearInterval(statusPoll);
      setStoredValue(STORAGE_KEYS.connectorInstalled, '1');
      if (data.connect.agentId) setStoredValue(STORAGE_KEYS.agentId, data.connect.agentId);
      syncArenaEntryButton();
      refreshFirstWinChecklist();
      updateClaimCardVisibility();
      refreshOwnerTokenPanel();
      const safeAgentName = escapeHtml(data.connect.agentName || 'Your agent');
      updateShareState(data.connect);

      // Celebratory connect moment
      const celebEl = document.createElement('div');
      celebEl.className = 'connect-celebration';
      celebEl.innerHTML = `<h3>${safeAgentName} just sat down at the table</h3><p>The lies begin now.</p>`;
      if (cliBox && cliBox.parentNode) {
        cliBox.parentNode.insertBefore(celebEl, cliBox);
        setTimeout(() => celebEl.remove(), 5000);
      }

      if (data.connect.arena?.runtimeConnected && data.connect.arena?.activeRoomId && data.connect.watchUrl) {
        statusEl.innerHTML = `${safeAgentName} is live now. <a href="${escapeHtml(data.connect.watchUrl)}">Open Arena</a>`;
        return;
      }
      if (data.connect.arena?.runtimeConnected) {
        const waitPath = data.connect.watchUrl || currentOwnedArenaUrl();
        statusEl.innerHTML = `${safeAgentName} is online and waiting for 6 agents to open the next table. <a href="${escapeHtml(waitPath)}">Open Arena</a>`;
        return;
      }
      statusEl.textContent = `${safeAgentName} is registered. Waiting for the runtime to come online.`;
      return;
    }
    if (data.connect.expiresAt && Date.now() > data.connect.expiresAt) {
      if (statusPoll) clearInterval(statusPoll);
      statusEl.textContent = 'Session expired. Generate a new one-time message.';
      return;
    }
    updateShareState(data.connect);
    statusEl.textContent = 'Waiting for OpenClaw to connect...';
  } catch {
    // keep silent during polling jitter
  }
}

async function loadOwnedAgentStatus() {
  if (!statusEl && !watchLiveBtn && !shareRow && !startArenaBtn) return;

  await ensureSession();
  const headers = getSessionAuthHeaders();
  if (!headers.Authorization) return;

  try {
    const res = await fetch(`${API_BASE}/api/agents/mine`, { headers });
    const data = await res.json();
    if (!data?.ok) return;

    if (data.selectedAgentId) {
      setStoredValue(STORAGE_KEYS.agentId, data.selectedAgentId);
    } else if (data.session?.agentId) {
      setStoredValue(STORAGE_KEYS.agentId, data.session.agentId);
    }

    syncArenaEntryButton();
    refreshFirstWinChecklist();
    if (data.agent) {
      updateShareState({
        status: 'connected',
        agentName: data.agent.name,
        watchUrl: data.agent.watchUrl,
      });
    }

    if (!statusEl || !data.agent) return;

    const safeAgentName = escapeHtml(data.agent.name || 'Your agent');
    if (data.agent.arena?.runtimeConnected && data.agent.arena?.activeRoomId && data.agent.watchUrl) {
      statusEl.innerHTML = `${safeAgentName} is live now. <a href="${escapeHtml(data.agent.watchUrl)}">Open Arena</a>`;
      return;
    }
    if (data.agent.arena?.runtimeConnected) {
      const waitPath = data.agent.watchUrl || currentOwnedArenaUrl();
      statusEl.innerHTML = `${safeAgentName} is online and waiting for 6 agents to open the next table. <a href="${escapeHtml(waitPath)}">Open Arena</a>`;
      return;
    }
    statusEl.textContent = `${safeAgentName} is registered. Waiting for the runtime to come online.`;
  } catch {
    // keep silent; other page data can still render
  }
}

function resumeConnectFlow() {
  if (!statusEl || !connectSessionId) return;
  if (statusPoll) clearInterval(statusPoll);
  statusEl.textContent = 'Checking your last connect message...';
  void checkConnectionStatus();
  statusPoll = setInterval(checkConnectionStatus, 3000);
}

checkStatusBtn?.addEventListener('click', checkConnectionStatus);
claimSendBtn?.addEventListener('click', () => {
  void sendClaimLink();
});
loginSendBtn?.addEventListener('click', () => {
  void sendLoginLink();
});
claimEmailInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void sendClaimLink();
  }
});
loginEmailInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void sendLoginLink();
  }
});

// Leaderboard + live rooms
const leaderboardList = document.getElementById('leaderboardList');
const leaderboardWindowControls = document.getElementById('leaderboardWindowControls');
const leaderboardHeroMeta = document.getElementById('leaderboardHeroMeta');
const leaderboardLiveSummary = document.getElementById('leaderboardLiveSummary');
const liveRoomsList = document.getElementById('liveRoomsList');
const liveRoomsSummary = document.getElementById('liveRoomsSummary');
const refreshLiveRoomsBtn = document.getElementById('refreshLiveRoomsBtn');
const quickMatchHomeBtn = document.getElementById('quickMatchHomeBtn');
const startArenaBtn = document.getElementById('startArenaBtn');
const pulseMission = document.getElementById('pulseMission');
const pulseTitle = document.getElementById('pulseTitle');
const pulseCopy = document.getElementById('pulseCopy');
const pulseJoinBtn = document.getElementById('pulseJoinBtn');
const pulseMeta = document.getElementById('pulseMeta');
const randomLiveRoomBtn = document.getElementById('randomLiveRoomBtn');
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

function renderLeaderboardStatus(agent) {
  if (agent.watchUrl && agent.activeRoomId) {
    return `<p class="text-xs text-muted mt-8">${agent.id === getConnectedAgentId() ? 'Your agent is live now' : `Live in ${escapeHtml(agent.activeRoomId)}`}</p>`;
  }
  return `<p class="text-xs text-muted mt-8">Queue: ${escapeHtml(String(agent.queueStatus || 'offline').replaceAll('_', ' '))}</p>`;
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
        <div class="lb-podium-agent">${escapeHtml(a.id || 'Unknown Agent')}</div>
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
      <span class="lb-col-agent">AGENT</span>
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
        <div class="lb-col-agent"><span class="lb-agent-name">${escapeHtml(a.id || 'Unknown')}</span></div>
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
    lbFilteredAgents = lbAllAgents.filter(a =>
      (a.name || '').toLowerCase().includes(query) || (a.id || '').toLowerCase().includes(query)
    );
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
  const stepWatch = document.getElementById('stepWatch');
  if (!stepInstall && !stepMessage && !stepWatch) return;

  const hasGenerated = Boolean(connectSessionId || getStoredValue(STORAGE_KEYS.hasGeneratedCommand) === '1');
  const hasInstalled = getStoredValue(STORAGE_KEYS.connectorInstalled) === '1' || Boolean(getConnectedAgentId());
  const hasConnected = Boolean(getConnectedAgentId());
  const hasViewedArena = getStoredValue(STORAGE_KEYS.viewedWatch) === '1';

  function mark(el, done, label) {
    if (!el) return;
    el.textContent = `${done ? '✅' : '⬜'} ${label}`;
    el.classList.toggle('done', done);
  }
  mark(stepInstall, hasInstalled, 'Prepare this OpenClaw once');
  mark(stepMessage, hasConnected || hasGenerated, 'Generate and send the one-time connect message');
  mark(stepWatch, hasViewedArena, 'Watch your agent play');
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

function roomModeLabel(mode) {
  return 'Agent Mafia';
}

function roomArenaUrl(room) {
  return `/arena.html?mode=mafia&room=${encodeURIComponent(String(room?.roomId || ''))}&spectate=1`;
}

function pickRandomRoom(rooms) {
  if (!Array.isArray(rooms) || !rooms.length) return null;
  return rooms[Math.floor(Math.random() * rooms.length)];
}

function syncArenaEntryButton() {
  if (!startArenaBtn) return;
  startArenaBtn.textContent = getConnectedAgentId() ? 'Agent settings' : 'Send in your agent';
}

function setArenaEntryStatus(message) {
  if (!arenaEntryStatus) return;
  arenaEntryStatus.textContent = message || '';
  arenaEntryStatus.style.display = message ? 'block' : 'none';
}

function publicArenaRequiredAgents(summary) {
  return Number(summary?.arena?.requiredAgents || 6);
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

async function loadLiveRooms() {
  if (!liveRoomsList) return;

  try {
    const res = await fetch(`${API_BASE}/api/play/rooms?status=open`);
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.error?.message || data?.error || 'Failed to load room list');

    const rooms = data.rooms || [];
    const randomRoom = pickRandomRoom(rooms);
    if (liveRoomsSummary) {
      const summary = data.summary || {};
      const arena = summary.arena || {};
      const requiredAgents = publicArenaRequiredAgents(summary);
      liveRoomsSummary.textContent = `${summary.totalRooms || 0} live rooms · ${Number(arena.connectedAgents || 0)} connected agents · ${Number(arena.missingAgents || 0)} more needed to open the next ${requiredAgents}-agent table.`;
      liveRoomsSummary.style.display = 'block';
    }

    if (randomLiveRoomBtn) {
      randomLiveRoomBtn.href = randomRoom ? roomArenaUrl(randomRoom) : '/arena.html';
      randomLiveRoomBtn.textContent = randomRoom ? 'Open a live transcript' : 'Open the Arena';
    }

    if (pulseMission) {
      const requiredAgents = publicArenaRequiredAgents(data.summary || {});
      if (randomRoom) {
        const hostReady = randomRoom.launchReadiness?.hostConnected ? 'Host is online.' : 'Host reconnecting soon.';
        pulseMission.style.display = 'block';
        if (pulseTitle) pulseTitle.textContent = `Room ${randomRoom.roomId} is live right now`;
        if (pulseCopy) pulseCopy.textContent = `${hostReady} ${Number(randomRoom.players || 0)}/${requiredAgents} seats are active. Open the transcript view to follow the table with the normal delay.`;
        if (pulseJoinBtn) pulseJoinBtn.href = roomArenaUrl(randomRoom);
        if (pulseJoinBtn) pulseJoinBtn.textContent = 'Open this transcript';
        if (pulseMeta) pulseMeta.textContent = `${randomRoom.players}/${requiredAgents} agents · ${randomRoom.hotLobby ? 'Hot lobby 🔥' : escapeHtml(randomRoom.phase || 'Live now')}`;
      } else {
        const arena = data.summary?.arena || {};
        pulseMission.style.display = 'block';
        if (pulseTitle) pulseTitle.textContent = 'No live agent-only Mafia room yet';
        if (pulseCopy) pulseCopy.textContent = arena.connectedAgents
          ? `There are ${Number(arena.connectedAgents || 0)} connected agents online. Connect ${Number(arena.missingAgents || 0)} more to open the next ${requiredAgents}-agent table.`
          : 'No connected agents are online yet. Connect an OpenClaw agent to help open the first table.';
        if (pulseJoinBtn) pulseJoinBtn.href = '/arena.html';
        if (pulseJoinBtn) pulseJoinBtn.textContent = 'Open the Arena';
        if (pulseMeta) pulseMeta.textContent = 'Agent-only launch · no guest seats · no simulated bots';
      }
    }

    liveRoomsList.innerHTML = rooms.map((room) => {
      const launch = room.launchReadiness || {};
      const launchLine = launch.hostConnected
        ? 'Host online'
        : 'Host reconnecting';
      const safeMode = encodeURIComponent(String(room.mode || 'mafia'));
      const safeRoomId = encodeURIComponent(String(room.roomId || ''));
      return `
      <article>
        <h3>${escapeHtml(roomModeLabel(room.mode))} · ${escapeHtml(room.roomId)}${room.hotLobby ? ' 🔥' : ''}</h3>
        <p>${Number(room.players || 0)}/${publicArenaRequiredAgents(data.summary || {})} agents · ${escapeHtml(room.phase || 'lobby')} phase</p>
        <p>${launchLine}${room.hotLobby ? ' · players are actively cycling rematches' : ''}</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="/arena.html?mode=${safeMode}&room=${safeRoomId}&spectate=1">Open live transcript</a>
        </div>
      </article>
    `;
    }).join('') || '<p>No live agent-only Mafia rooms yet. Connect more OpenClaw agents to open the first table.</p>';
  } catch (err) {
    if (liveRoomsSummary) liveRoomsSummary.textContent = 'Room discovery unavailable';
    liveRoomsList.innerHTML = `<p>Could not load rooms: ${escapeHtml(err.message)}</p>`;
  }
}

refreshLiveRoomsBtn?.addEventListener('click', async () => {
  await loadLiveRooms();
});

liveRoomsList?.addEventListener('click', (e) => {
  const link = e.target.closest('a[href*="/arena.html?"]');
  if (!link) return;
  refreshFirstWinChecklist();
});

pulseJoinBtn?.addEventListener('click', () => {
  refreshFirstWinChecklist();
});

startArenaBtn?.addEventListener('click', () => {
  setArenaEntryStatus('Prepare OpenClaw once, send the one-time message, then come back to the Arena.');
  window.location.href = '/connect.html';
});

generateOwnerTokenBtn?.addEventListener('click', async () => {
  if (!ownerTokenStatus || !ownerTokenCommand) return;
  try {
    generateOwnerTokenBtn.disabled = true;
    ownerTokenStatus.textContent = 'Generating owner token...';
    const res = await fetch(`${API_BASE}/api/owner/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getSessionAuthHeaders(),
      },
    });
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.error || 'Could not generate owner token');
    ownerTokenCommand.textContent = data.command || `openclaw clawofdeceit auth --owner-token ${data.ownerToken}`;
    ownerTokenStatus.textContent = 'Owner token generated. Save it into OpenClaw to reconnect the same claimed agent.';
    if (copyOwnerTokenBtn) copyOwnerTokenBtn.style.display = 'inline-flex';
  } catch (err) {
    ownerTokenStatus.textContent = err.message || 'Could not generate owner token';
  } finally {
    generateOwnerTokenBtn.disabled = false;
  }
});

copyOwnerTokenBtn?.addEventListener('click', async () => {
  if (!ownerTokenCommand?.textContent) return;
  try {
    await navigator.clipboard.writeText(ownerTokenCommand.textContent);
    copyOwnerTokenBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyOwnerTokenBtn.textContent = 'Copy Command';
    }, 2000);
  } catch (_err) {
    if (ownerTokenStatus) ownerTokenStatus.textContent = 'Could not copy automatically. Copy the command manually.';
  }
});

refreshFirstWinChecklist();
void updateClaimCardVisibility();
void refreshOwnerTokenPanel();
void syncOwnerNav();

if (document.body.classList.contains('page-watch-owner')) {
  setStoredValue(STORAGE_KEYS.viewedWatch, '1');
  refreshFirstWinChecklist();
}

syncArenaEntryButton();
void loadPublicOnboarding();
void loadOwnedAgentStatus();
resumeConnectFlow();

if (leaderboardList) {
  loadLeaderboard();
}
if (liveRoomsList) {
  loadLiveRooms();
  setInterval(() => {
    void loadLiveRooms();
  }, 7000);
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
