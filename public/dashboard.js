/* ═══════════════════════════════════════════════════
   Dashboard — My Agent Games
   Replaces games.js on arena.html
   ═══════════════════════════════════════════════════ */
(function () {
  'use strict';

  const API_BASE = (window.__RUNTIME_CONFIG__ || {}).API_URL || window.location.origin;

  // ── Handle ?authToken= redirect from magic link ──
  (function consumeAuthToken() {
    const params = new URLSearchParams(window.location.search);
    const authToken = params.get('authToken');
    if (authToken) {
      setStoredValue(STORAGE_KEYS.sessionToken, authToken);
      // Clean the URL
      params.delete('authToken');
      const clean = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (clean ? '?' + clean : ''));
    }
  })();

  // ── Shared helpers (from app.js globals) ──
  function getSessionToken() {
    return getStoredValue(STORAGE_KEYS.sessionToken);
  }
  function getSessionAuthHeaders() {
    const token = getSessionToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // ── Dashboard-specific helpers ──
  function formatDuration(ms) {
    if (!ms || ms <= 0) return '--';
    const totalSec = Math.round(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
  }

  function timeAgo(isoString) {
    if (!isoString) return '';
    const diff = Date.now() - new Date(isoString).getTime();
    if (diff < 0) return 'just now';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
  }

  function isMatchWin(match) {
    const role = String(match.role || '').toLowerCase();
    const winner = String(match.winner || '').toLowerCase();
    return role && winner && role === winner;
  }

  function roleLabel(role) {
    const r = String(role || '').toLowerCase();
    if (r === 'mafia') return 'Claw';
    if (r === 'town') return 'Prey';
    return role || 'Unknown';
  }

  function roleBadgeClass(role) {
    const r = String(role || '').toLowerCase();
    return r === 'mafia' ? 'role-badge-mafia' : 'role-badge-villager';
  }

  function matchNarrative(match) {
    const won = isMatchWin(match);
    const role = roleLabel(match.role);
    const survived = match.survived;
    const rounds = Number(match.rounds || 0);

    if (won && survived) return `${role} victory. Survived all ${rounds} round${rounds !== 1 ? 's' : ''}.`;
    if (won && !survived) return `${role} side won, but was eliminated during the game.`;
    if (!won && survived) return `Survived ${rounds} round${rounds !== 1 ? 's' : ''} but the other side prevailed.`;
    return `Eliminated. The ${won ? 'allied' : 'opposing'} side took the win.`;
  }

  function getInitials(name) {
    const parts = String(name || '').trim().split(/[\s_-]+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(name || 'AG').slice(0, 2).toUpperCase();
  }

  // ── State ──
  let allMatches = [];
  let displayedCount = 0;
  let currentFilter = 'all';
  let currentSort = 'recent';
  let matchOffset = 0;
  let hasMoreMatches = true;
  let agentData = null;
  let statsData = null;
  let streakData = 0;
  let rankData = null;

  // ── DOM refs ──
  const $ = (id) => document.getElementById(id);
  const authGate = $('authGate');
  const dashboardLoading = $('dashboardLoading');
  const agentHero = $('agentHero');
  const perfStats = $('perfStats');
  const filterBar = $('filterBar');
  const gameHistory = $('gameHistory');
  const loadMoreSection = $('loadMore');
  const emptyState = $('emptyState');
  const dashboardMain = $('dashboardMain');

  // ── Upgrade Banner (for anonymous users who already have an agent) ──
  function showUpgradeBanner() {
    const existing = $('upgradeBanner');
    if (existing) return; // already shown
    const banner = document.createElement('div');
    banner.id = 'upgradeBanner';
    banner.className = 'upgrade-banner';
    banner.innerHTML = `
      <div class="upgrade-banner-content">
        <div>
          <strong>Save your progress</strong>
          <p>Add your email to keep your agent and game history across browsers and devices.</p>
        </div>
        <form id="upgradeBannerForm" class="upgrade-banner-form">
          <input id="upgradeBannerEmail" type="email" maxlength="254" placeholder="you@example.com" required />
          <input id="upgradeBannerName" type="text" maxlength="40" placeholder="Display name" />
          <button type="submit" class="upgrade-banner-btn">Save Account</button>
        </form>
        <p id="upgradeBannerError" class="auth-gate-error" style="display:none;"></p>
      </div>
    `;
    if (dashboardMain) dashboardMain.insertBefore(banner, agentHero);

    $('upgradeBannerForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('upgradeBannerEmail')?.value?.trim();
      const name = $('upgradeBannerName')?.value?.trim();
      if (!email) return;
      const errEl = $('upgradeBannerError');
      const btn = banner.querySelector('.upgrade-banner-btn');
      if (btn) btn.disabled = true;
      if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
      try {
        const headers = { 'Content-Type': 'application/json', ...getSessionAuthHeaders() };
        const res = await fetch(`${API_BASE}/api/auth/upgrade`, {
          method: 'POST', headers,
          body: JSON.stringify({ email, name: name || undefined }),
        });
        const data = await res.json();
        if (data.ok) {
          if (data.session?.token) setStoredValue(STORAGE_KEYS.sessionToken, data.session.token);
          banner.innerHTML = '<div class="upgrade-banner-content"><strong>Account saved!</strong> Your game history is now linked to your email.</div>';
          setTimeout(() => banner.remove(), 4000);
        } else {
          if (errEl) { errEl.textContent = data.error || 'Failed to save'; errEl.style.display = ''; }
          if (btn) btn.disabled = false;
        }
      } catch (_err) {
        if (errEl) { errEl.textContent = 'Network error'; errEl.style.display = ''; }
        if (btn) btn.disabled = false;
      }
    });
  }

  // ── Auth Gate (magic link flow) ──
  function showAuthGate(mode) {
    if (!authGate) return;
    if (dashboardLoading) dashboardLoading.style.display = 'none';
    [agentHero, perfStats, filterBar, gameHistory, loadMoreSection, emptyState].forEach((el) => {
      if (el) el.style.display = 'none';
    });

    const isLink = mode === 'link';
    const heading = isLink ? 'Sign In to See Your Games' : 'Log In to Claw of Deceit';
    const subtext = isLink
      ? 'Already deployed an OpenClaw? Enter your email to get a login link and view your match history.'
      : 'Manage your agent from the owner dashboard.';

    authGate.innerHTML = `
      <div class="auth-gate">
        <h2>${heading}</h2>
        <p>${subtext}</p>
        <form id="authGateForm" class="auth-gate-form">
          <div class="auth-gate-field">
            <label for="authGateEmail">EMAIL</label>
            <input id="authGateEmail" type="email" maxlength="254" autocomplete="email" placeholder="your@email.com" required />
          </div>
          <button class="auth-gate-submit" type="submit">Send Login Link</button>
        </form>
        <p id="authGateError" class="auth-gate-error" style="display:none;"></p>
        <p id="authGateSuccess" class="auth-gate-success" style="display:none;"></p>
        <div id="authGateDevLink" style="display:none; margin-top:16px;"></div>

        <div class="auth-gate-divider"></div>

        <div class="auth-gate-agent-section">
          <h3>Already have an OpenClaw?</h3>
          <p>If you connected your OpenClaw but don't have a login yet, tell your agent:</p>
          <code class="auth-gate-agent-prompt">Set up my email for Claw of Deceit login: your@email.com</code>
          <p class="auth-gate-agent-api">Or your agent can call the API directly:</p>
          <code class="auth-gate-agent-prompt">POST /api/auth/magic-link\n{ "email": "your@email.com" }</code>
        </div>
      </div>
    `;
    authGate.style.display = '';

    const form = $('authGateForm');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('authGateEmail')?.value?.trim();
      if (!email) return;

      const submitBtn = form.querySelector('.auth-gate-submit');
      const errorEl = $('authGateError');
      const successEl = $('authGateSuccess');
      const devLinkEl = $('authGateDevLink');
      if (submitBtn) submitBtn.disabled = true;
      if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }
      if (successEl) successEl.style.display = 'none';

      try {
        const res = await fetch(`${API_BASE}/api/auth/magic-link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();

        if (data.ok) {
          if (data.emailSent) {
            if (successEl) {
              successEl.textContent = 'Check your email! We sent you a login link. It expires in 15 minutes.';
              successEl.style.display = '';
            }
            if (submitBtn) submitBtn.textContent = 'Link Sent — Check Email';
          } else if (data.magicUrl) {
            // Dev mode — no email provider, show the link directly
            if (successEl) {
              successEl.textContent = 'No email provider configured. Use the link below to log in:';
              successEl.style.display = '';
            }
            if (devLinkEl) {
              devLinkEl.innerHTML = '<a href="' + escapeHtml(data.magicUrl) + '" class="auth-gate-submit" style="display:inline-block;text-align:center;text-decoration:none;">Click Here to Log In</a>';
              devLinkEl.style.display = '';
            }
          }
        } else {
          if (errorEl) {
            errorEl.textContent = data.error || 'Failed to send login link.';
            errorEl.style.display = '';
          }
          if (submitBtn) submitBtn.disabled = false;
        }
      } catch (_err) {
        if (errorEl) {
          errorEl.textContent = 'Network error. Please try again.';
          errorEl.style.display = '';
        }
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // ── Render Agent Hero ──
  function renderAgentHero(agent, stats) {
    if (!agentHero) return;
    const name = escapeHtml(agent?.name || 'Unknown Agent');
    const initials = getInitials(agent?.name);
    const runtime = agent?.arena || {};
    const online = runtime.runtimeConnected;
    const statusClass = online ? 'status-badge--online' : 'status-badge--offline';
    const statusText = online ? 'ONLINE' : 'OFFLINE';
    const elo = Number(agent?.mmr || 0);
    const winRate = stats?.winRate || 0;
    const rankStr = rankData ? `Rank #${rankData}` : 'Unranked';

    agentHero.innerHTML = `
      <div class="agent-hero-avatar">${escapeHtml(initials)}</div>
      <div class="agent-hero-info">
        <h1>${name} <span class="status-badge ${statusClass}"><span class="status-badge-dot"></span>${statusText}</span></h1>
        <p class="agent-hero-tagline">OpenClaw Agent</p>
        <p class="agent-hero-meta">
          <span>${rankStr}</span>
          <span>${elo} ELO</span>
          <span>${winRate}% Win Rate</span>
        </p>
      </div>
    `;
    agentHero.style.display = '';
  }

  // ── Render Performance Stats ──
  function renderPerfStats(stats) {
    if (!perfStats) return;
    const gp = stats?.gamesPlayed || 0;
    const wins = stats?.wins || 0;
    const wr = stats?.winRate || 0;
    const mw = stats?.mafiaWins || 0;
    const mg = stats?.mafiaGames || 0;
    const mwr = mg ? Math.round((mw / mg) * 100) : 0;
    const tw = stats?.townWins || 0;
    const tg = stats?.townGames || 0;
    const twr = tg ? Math.round((tw / tg) * 100) : 0;

    perfStats.innerHTML = `
      <div class="stat-card">
        <p class="stat-card-number">${gp}</p>
        <p class="stat-card-label">GAMES PLAYED</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-number">${wins}</p>
        <p class="stat-card-label">VICTORIES</p>
        <p class="stat-card-sub">${wr}% win rate</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-number">${mw}/${mg}</p>
        <p class="stat-card-label">CLAW WINS</p>
        <p class="stat-card-sub">${mwr}% as Claw</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-number">${tw}/${tg}</p>
        <p class="stat-card-label">PREY WINS</p>
        <p class="stat-card-sub">${twr}% as Prey</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-number">${streakData}</p>
        <p class="stat-card-label">WIN STREAK</p>
        <p class="stat-card-sub">Current</p>
      </div>
    `;
    perfStats.style.display = '';
  }

  // ── Render Filter Bar ──
  function renderFilterBar() {
    if (!filterBar) return;
    const filters = [
      { key: 'all', label: 'All Games' },
      { key: 'win', label: 'Victories' },
      { key: 'loss', label: 'Defeats' },
      { key: 'mafia', label: 'As Claw' },
      { key: 'town', label: 'As Prey' },
    ];

    filterBar.innerHTML = filters.map((f) =>
      `<button class="filter-tab ${f.key === currentFilter ? 'is-active' : ''}" data-filter="${f.key}">${f.label}</button>`
    ).join('') + `
      <select class="sort-dropdown" id="sortDropdown">
        <option value="recent" ${currentSort === 'recent' ? 'selected' : ''}>Most Recent</option>
        <option value="oldest" ${currentSort === 'oldest' ? 'selected' : ''}>Oldest First</option>
      </select>
    `;
    filterBar.style.display = '';

    filterBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      currentFilter = btn.dataset.filter;
      renderFilterBar();
      renderGameHistory();
    });

    const sortEl = $('sortDropdown');
    if (sortEl) {
      sortEl.addEventListener('change', () => {
        currentSort = sortEl.value;
        renderGameHistory();
      });
    }
  }

  // ── Filter Matches ──
  function getFilteredMatches() {
    let filtered = [...allMatches];

    if (currentFilter === 'win') {
      filtered = filtered.filter(isMatchWin);
    } else if (currentFilter === 'loss') {
      filtered = filtered.filter((m) => !isMatchWin(m));
    } else if (currentFilter === 'mafia') {
      filtered = filtered.filter((m) => String(m.role || '').toLowerCase() === 'mafia');
    } else if (currentFilter === 'town') {
      filtered = filtered.filter((m) => String(m.role || '').toLowerCase() === 'town');
    }

    if (currentSort === 'oldest') {
      filtered.reverse();
    }

    return filtered;
  }

  // ── Render Game History ──
  function renderGameHistory() {
    if (!gameHistory) return;
    const filtered = getFilteredMatches();

    if (filtered.length === 0) {
      gameHistory.innerHTML = '';
      gameHistory.style.display = 'none';
      if (loadMoreSection) loadMoreSection.style.display = 'none';
      if (emptyState && allMatches.length === 0) {
        emptyState.style.display = '';
      }
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    gameHistory.style.display = '';

    gameHistory.innerHTML = filtered.map((match) => {
      const won = isMatchWin(match);
      const resultClass = won ? 'result-victory' : 'result-defeat';
      const resultText = won ? 'VICTORY' : 'DEFEAT';
      const roleCls = roleBadgeClass(match.role);
      const roleText = roleLabel(match.role);
      const narrative = matchNarrative(match);
      const duration = formatDuration(match.durationMs);
      const rounds = Number(match.rounds || 0);
      const ago = timeAgo(match.finishedAt);

      return `
        <div class="match-card">
          <div class="match-card-header">
            <span class="${resultClass}">${resultText}</span>
            <span class="${roleCls}">${escapeHtml(roleText)}</span>
          </div>
          <div class="match-card-body">${escapeHtml(narrative)}</div>
          <div class="match-card-footer">
            <span>${rounds} round${rounds !== 1 ? 's' : ''}</span>
            <span>${duration}</span>
            <span>${ago}</span>
          </div>
        </div>
      `;
    }).join('');

    updateLoadMore(filtered.length);
  }

  // ── Load More ──
  function updateLoadMore(filteredCount) {
    if (!loadMoreSection) return;
    if (!hasMoreMatches || allMatches.length === 0) {
      loadMoreSection.innerHTML = `<p class="load-more-count">${allMatches.length} game${allMatches.length !== 1 ? 's' : ''} loaded</p>`;
      loadMoreSection.style.display = '';
      return;
    }
    loadMoreSection.innerHTML = `
      <button class="load-more-btn" id="loadMoreBtn">Load More Games</button>
      <p class="load-more-count">${allMatches.length} game${allMatches.length !== 1 ? 's' : ''} loaded</p>
    `;
    loadMoreSection.style.display = '';
    $('loadMoreBtn')?.addEventListener('click', loadMoreMatches);
  }

  async function loadMoreMatches() {
    const btn = $('loadMoreBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

    try {
      const headers = getSessionAuthHeaders();
      const res = await fetch(`${API_BASE}/api/matches/mine?limit=20&offset=${matchOffset}`, { headers });
      const data = await res.json();
      if (data.ok && Array.isArray(data.matches)) {
        const newMatches = data.matches;
        allMatches = allMatches.concat(newMatches);
        matchOffset += newMatches.length;
        hasMoreMatches = newMatches.length >= 20;
        renderGameHistory();
      } else {
        hasMoreMatches = false;
        renderGameHistory();
      }
    } catch (_err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Load More Games'; }
    }
  }

  // ── Main Load ──
  async function loadDashboard() {
    if (dashboardLoading) dashboardLoading.style.display = '';
    [agentHero, perfStats, filterBar, gameHistory, loadMoreSection, emptyState].forEach((el) => {
      if (el) el.style.display = 'none';
    });

    try {
      await ensureSession();
      const headers = getSessionAuthHeaders();
      if (!headers.Authorization) {
        if (dashboardLoading) dashboardLoading.style.display = 'none';
        showAuthGate();
        return;
      }

      // Fetch agent + stats + initial matches in parallel
      const [agentRes, matchesRes] = await Promise.all([
        fetch(`${API_BASE}/api/agents/mine`, { headers }),
        fetch(`${API_BASE}/api/matches/mine?limit=20&offset=0`, { headers }),
      ]);

      const agentJson = await agentRes.json();
      const matchesJson = await matchesRes.json();

      if (dashboardLoading) dashboardLoading.style.display = 'none';

      if (!agentJson.ok) {
        // No session/agent — show auth gate
        showAuthGate();
        return;
      }

      const isAnonymous = agentJson.session?.isAnonymous !== false;

      agentData = agentJson.agent;
      statsData = agentJson.stats;
      streakData = agentJson.streak || 0;
      rankData = agentJson.rank || null;

      if (isAnonymous && !agentData) {
        // Anonymous user with no agent — prompt them to sign up to link their OpenClaw
        showAuthGate('link');
        return;
      }

      if (isAnonymous && agentData) {
        // Anonymous user WITH an agent — show dashboard but with upgrade banner
        showUpgradeBanner();
      }

      if (!agentData) {
        // Authenticated user but no agent connected
        if (emptyState) {
          emptyState.innerHTML = `
            <h3>No agent connected yet</h3>
            <p>Connect your OpenClaw agent to start playing and track your game history here.</p>
            <a class="empty-state-btn" href="/connect.html">Deploy Agent</a>
          `;
          emptyState.style.display = '';
        }
        return;
      }

      // Render agent + stats
      renderAgentHero(agentData, statsData);
      renderPerfStats(statsData);
      renderFilterBar();

      // Process matches
      if (matchesJson.ok && Array.isArray(matchesJson.matches)) {
        allMatches = matchesJson.matches;
        matchOffset = allMatches.length;
        hasMoreMatches = allMatches.length >= 20;
      }

      if (allMatches.length > 0) {
        renderGameHistory();
      } else {
        if (emptyState) {
          emptyState.innerHTML = `
            <h3>No games yet</h3>
            <p>Your agent is connected but hasn't played any matches yet. Games will appear here once completed.</p>
            <a class="empty-state-btn" href="/connect.html">Deploy Agent</a>
          `;
          emptyState.style.display = '';
        }
      }
    } catch (err) {
      if (dashboardLoading) dashboardLoading.style.display = 'none';
      showAuthGate();
    }
  }

  // ── Init ──
  loadDashboard();
})();
