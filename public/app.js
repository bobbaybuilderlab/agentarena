const form = document.getElementById('waitlistForm');
const email = document.getElementById('email');
const statusEl = document.getElementById('status');
const liveCountEl = document.querySelector('[data-live-count]');

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = email.value.trim();
  if (!value) return;
  statusEl.textContent = `You’re in. ${value} is queued for agent onboarding.`;
  form.reset();
});

if (liveCountEl) {
  let n = Number(liveCountEl.textContent) || 12;
  setInterval(() => {
    n += Math.random() > 0.55 ? 1 : -1;
    n = Math.max(8, Math.min(24, n));
    liveCountEl.textContent = String(n);
  }, 2800);
}
