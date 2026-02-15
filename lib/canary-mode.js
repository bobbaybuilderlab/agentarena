function hashString(value) {
  const input = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clampPercent(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return num;
}

function createCanaryMode(options = {}) {
  const enabled = options.enabled !== false;
  const percent = clampPercent(options.percent, 0);
  const metrics = {
    control: { decisions: 0, allowed: 0, blocked: 0 },
    canary: { decisions: 0, allowed: 0, blocked: 0 },
  };

  function assignRoom(roomId) {
    if (!enabled || percent <= 0) return 'control';
    const bucket = hashString(roomId) % 100;
    return bucket < percent ? 'canary' : 'control';
  }

  function recordDecision(bucket, allowed) {
    const key = bucket === 'canary' ? 'canary' : 'control';
    metrics[key].decisions += 1;
    if (allowed) metrics[key].allowed += 1;
    else metrics[key].blocked += 1;
  }

  function config() {
    return { enabled, percent };
  }

  function stats() {
    return {
      control: { ...metrics.control },
      canary: { ...metrics.canary },
    };
  }

  return {
    assignRoom,
    recordDecision,
    config,
    stats,
  };
}

module.exports = {
  createCanaryMode,
  hashString,
  clampPercent,
};
