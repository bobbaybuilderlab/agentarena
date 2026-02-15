const test = require('node:test');
const assert = require('node:assert/strict');

const { runEval, loadFixtures } = require('../lib/eval-harness');
const { evaluateEvalReport, DEFAULT_THRESHOLDS } = require('../lib/eval-thresholds');
const { server, clearAllGameTimers } = require('../server');

test('eval harness loads >=20 fixtures and computes baseline metrics', () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.length >= 20);

  const report = runEval(fixtures);
  assert.equal(report.ok, true);
  assert.equal(report.totals.fixtures, fixtures.length);
  assert.equal(report.totals.completionRate, 1);
  assert.equal(report.totals.winnerDeterminism, 1);
  assert.ok(Number.isFinite(report.totals.meanRoundSteps));
});

test('eval threshold gate passes current baseline defaults', () => {
  const report = runEval(loadFixtures());
  const gate = evaluateEvalReport(report, DEFAULT_THRESHOLDS);
  assert.equal(gate.ok, true);
  assert.equal(gate.checks.length, 5);
});

test('GET /api/evals/run returns eval totals payload', async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/evals/run`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.totals.fixtures >= 20);
    assert.equal(typeof body.totals.voteIntegrityErrors, 'number');
  } finally {
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/evals/ci returns CI gate payload', async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/evals/ci`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(typeof body.ok, 'boolean');
    assert.ok(Array.isArray(body.checks));
    assert.ok(body.checks.length >= 4);
    assert.equal(typeof body.totals.meanRoundSteps, 'number');
  } finally {
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});
