const { randomUUID } = require('crypto');

function shortId(len = 8) {
  return randomUUID().replace(/-/g, '').slice(0, len);
}

function correlationId(input) {
  if (input === null || input === undefined) return shortId(12);
  const str = typeof input === 'string' ? input : String(input);
  const trimmed = str.trim();
  if (!trimmed) return shortId(12);
  if (trimmed.length > 64) return trimmed.slice(0, 64);
  return trimmed;
}

function logStructured(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

module.exports = {
  shortId,
  correlationId,
  logStructured,
};
