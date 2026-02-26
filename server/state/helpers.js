const { randomUUID } = require('crypto');

function shortId(len = 8) {
  return randomUUID().replace(/-/g, '').slice(0, len);
}

function correlationId(seed) {
  const raw = String(seed || '').trim();
  if (!raw) return shortId(12);
  return raw.slice(0, 64);
}

function logStructured(event, fields = {}) {
  const payload = {
    at: new Date().toISOString(),
    event,
    ...fields,
  };
  console.log(JSON.stringify(payload));
}

module.exports = {
  shortId,
  correlationId,
  logStructured,
};
