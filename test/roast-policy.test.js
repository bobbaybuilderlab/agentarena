const test = require('node:test');
const assert = require('node:assert/strict');

const { moderateRoast } = require('../bots/roast-policy');

test('roast policy allows normal roast text', () => {
  const result = moderateRoast('Your startup burns cash faster than your coffee machine.');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'POLICY_OK');
  assert.ok(result.text.length > 0);
});

test('roast policy rejects threat content with structured reason code', () => {
  const result = moderateRoast('I will kill you in prod after standup.');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'POLICY_THREAT');
});

test('roast policy rejects self-harm encouragement', () => {
  const result = moderateRoast('kys and stop shipping bugs');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'POLICY_SELF_HARM');
});

test('roast policy rejects hate content', () => {
  const result = moderateRoast('you are subhuman and your roadmap is fake');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'POLICY_HATE');
});

test('canary policy applies stricter profanity rule while control allows it', () => {
  const control = moderateRoast('fuck you and your roadmap', { variant: 'control' });
  const canary = moderateRoast('fuck you and your roadmap', { variant: 'canary' });

  assert.equal(control.ok, true);
  assert.equal(canary.ok, false);
  assert.equal(canary.code, 'POLICY_CANARY_PROFANITY');
});
