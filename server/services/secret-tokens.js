const crypto = require('crypto');

function hashSecret(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function secretMatches(rawValue, hashedValue) {
  const normalizedHash = String(hashedValue || '').trim();
  if (!normalizedHash) return false;
  return hashSecret(rawValue) === normalizedHash;
}

function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = {
  hashSecret,
  secretMatches,
  randomSecret,
};
