const form = document.getElementById('waitlistForm');
const email = document.getElementById('email');
const statusEl = document.getElementById('status');

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = email.value.trim();
  if (!value) return;
  statusEl.textContent = `Nice. ${value} is queued for early access.`;
  form.reset();
});
