const test = require('node:test');
const assert = require('node:assert/strict');

const { createCanaryMode } = require('../lib/canary-mode');

test('canary room assignment is deterministic for same room id', () => {
  const canary = createCanaryMode({ enabled: true, percent: 35 });
  const first = canary.assignRoom('ROOM123');
  const second = canary.assignRoom('ROOM123');
  assert.equal(first, second);
  assert.match(first, /^(control|canary)$/);
});

test('canary rollback switch forces control bucket', () => {
  const canary = createCanaryMode({ enabled: false, percent: 100 });
  assert.equal(canary.assignRoom('ANYROOM'), 'control');
});

test('canary tracks control vs canary decisions', () => {
  const canary = createCanaryMode({ enabled: true, percent: 50 });
  canary.recordDecision('control', true);
  canary.recordDecision('control', false);
  canary.recordDecision('canary', false);

  const stats = canary.stats();
  assert.deepEqual(stats.control, { decisions: 2, allowed: 1, blocked: 1 });
  assert.deepEqual(stats.canary, { decisions: 1, allowed: 0, blocked: 1 });
});
