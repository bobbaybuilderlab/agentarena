const { randomUUID } = require('crypto');

function shortId(len = 8, existingIds) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = randomUUID().replace(/-/g, '').slice(0, len);
    if (!existingIds || !existingIds.has(id)) return id;
  }
  // Fallback: 10 collisions is astronomically unlikely; return last attempt anyway
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

function fisherYatesShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  shortId,
  correlationId,
  logStructured,
  fisherYatesShuffle,
};
