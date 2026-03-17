(function () {
  'use strict';

  const runtime = window.__RUNTIME_CONFIG__ || {};
  const API_BASE = runtime.API_URL || window.location.origin;

  const accountCard = document.getElementById('accountCard');
  const signedOutCard = document.getElementById('accountSignedOut');
  const accountEmail = document.getElementById('accountEmail');
  const accountAgentName = document.getElementById('accountAgentName');
  const accountAgentMeta = document.getElementById('accountAgentMeta');
  const accountRestoreNote = document.getElementById('accountRestoreNote');
  const logoutBtn = document.getElementById('logoutBtn');
  const logoutStatus = document.getElementById('logoutStatus');

  function setSignedInState(isSignedIn) {
    if (accountCard) accountCard.style.display = isSignedIn ? 'grid' : 'none';
    if (signedOutCard) signedOutCard.style.display = isSignedIn ? 'none' : 'block';
  }

  function renderAgentSummary(payload, user) {
    const selectedAgent = payload?.agent || null;
    const selectedAgentId = String(payload?.selectedAgentId || user?.agentId || '').trim();

    if (!accountAgentName || !accountAgentMeta) return;

    if (!selectedAgent && !selectedAgentId) {
      accountAgentName.textContent = 'No claimed agent yet';
      accountAgentMeta.textContent = 'Claim an agent from My Games after you connect OpenClaw.';
      return;
    }

    accountAgentName.textContent = selectedAgent?.name || selectedAgentId;
    const details = [];
    if (selectedAgentId) details.push(`Agent ID: ${selectedAgentId}`);
    if (selectedAgent?.watchUrl) {
      details.push(`Watch: ${selectedAgent.watchUrl}`);
    }
    if (Array.isArray(payload?.agents) && payload.agents.length > 1) {
      details.push(`${payload.agents.length} owned dashboard agents available in this session`);
    }
    accountAgentMeta.textContent = details.join(' · ');
  }

  async function fetchOwnedAgentContext() {
    if (typeof getSessionAuthHeaders !== 'function') return null;
    const headers = getSessionAuthHeaders();
    if (!headers.Authorization) return null;

    try {
      const res = await fetch(`${API_BASE}/api/agents/mine`, { headers });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.ok ? data : null;
    } catch (_err) {
      return null;
    }
  }

  async function initAccountPage() {
    const user = typeof fetchCurrentUserProfile === 'function'
      ? await fetchCurrentUserProfile()
      : null;

    if (!user?.email) {
      setSignedInState(false);
      return;
    }

    setSignedInState(true);
    if (accountEmail) accountEmail.textContent = user.email;
    if (accountRestoreNote) {
      accountRestoreNote.textContent = `Logging out only clears this browser session. Logging back in as ${user.email} should restore the same claimed dashboard agent.`;
    }

    const ownedContext = await fetchOwnedAgentContext();
    renderAgentSummary(ownedContext, user);
  }

  logoutBtn?.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    if (logoutStatus) logoutStatus.textContent = 'Logging out of this browser...';
    await logoutCurrentSession({ redirectTo: '/arena.html' });
  });

  void initAccountPage();
})();
