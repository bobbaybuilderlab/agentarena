#!/usr/bin/env node

const { runEval } = require('./eval-harness');
const { parseThresholdsFromEnv, evaluateEvalReport } = require('./eval-thresholds');

const report = runEval();
const thresholds = parseThresholdsFromEnv();
const gate = evaluateEvalReport(report, thresholds);

const payload = {
  ok: gate.ok,
  thresholds: gate.thresholds,
  checks: gate.checks,
  totals: report.totals,
  failedFixtures: report.failures.map((f) => f.id),
};

console.log(JSON.stringify(payload, null, 2));
process.exit(gate.ok ? 0 : 1);
