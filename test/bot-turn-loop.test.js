const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MAX_LENGTH,
  planBotTurn,
  draftBotRoast,
  selfCheckBotTurn,
  runBotTurn,
} = require('../bots/turn-loop');

test('bot turn loop: plan includes enforced policy tags', () => {
  const plan = planBotTurn({ theme: 'Tech Twitter', botName: 'PolicyBot', intensity: 9, style: 'deadpan' });
  assert.deepEqual(plan.policyTags, ['humor', 'no-hate', 'no-threats']);
  assert.equal(plan.maxLength, DEFAULT_MAX_LENGTH);
});

test('bot turn loop: self-check clamps output to max length', () => {
  const plan = planBotTurn({ theme: 'Tech Twitter', botName: 'ClampBot' });
  const checked = selfCheckBotTurn({
    draft: `[ClampBot • spicy] ${'x'.repeat(500)}`,
    plan,
  });
  assert.equal(checked.text.length, DEFAULT_MAX_LENGTH);
  assert.equal(checked.checks.policyTags, true);
});

test('bot turn loop: run returns safe submitted roast with metadata', () => {
  const turn = runBotTurn({ theme: 'Startup Founder', botName: 'LoopBot', intensity: 7, style: 'witty' });
  assert.ok(turn.text.startsWith('[LoopBot'));
  assert.ok(turn.text.length <= DEFAULT_MAX_LENGTH);
  assert.deepEqual(turn.meta.policyTags, ['humor', 'no-hate', 'no-threats']);
});

test('bot turn loop: draft stage still generates themed copy', () => {
  const plan = planBotTurn({ theme: 'Corporate', botName: 'CorpBot', intensity: 5 });
  const draft = draftBotRoast(plan);
  assert.ok(draft.includes('CorpBot'));
  assert.ok(draft.length > 20);
});
