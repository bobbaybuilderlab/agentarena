const DEFAULT_THRESHOLDS = {
  completionRateMin: 1,
  winnerDeterminismMin: 1,
  fixturePassRateMin: 0.75,
  voteIntegrityErrorsMax: 0,
  meanRoundStepsMax: 3.5,
};

function parseThresholdsFromEnv(env = process.env) {
  const out = { ...DEFAULT_THRESHOLDS };

  if (env.EVAL_COMPLETION_RATE_MIN) out.completionRateMin = Number(env.EVAL_COMPLETION_RATE_MIN);
  if (env.EVAL_WINNER_DETERMINISM_MIN) out.winnerDeterminismMin = Number(env.EVAL_WINNER_DETERMINISM_MIN);
  if (env.EVAL_FIXTURE_PASS_RATE_MIN) out.fixturePassRateMin = Number(env.EVAL_FIXTURE_PASS_RATE_MIN);
  if (env.EVAL_VOTE_INTEGRITY_ERRORS_MAX) out.voteIntegrityErrorsMax = Number(env.EVAL_VOTE_INTEGRITY_ERRORS_MAX);
  if (env.EVAL_MEAN_ROUND_STEPS_MAX) out.meanRoundStepsMax = Number(env.EVAL_MEAN_ROUND_STEPS_MAX);

  return out;
}

function evaluateEvalReport(report, thresholds = DEFAULT_THRESHOLDS) {
  const totals = report?.totals || {};
  const fixturePassRate = Number(totals.fixtures) ? Number((Number(totals.passed || 0) / Number(totals.fixtures)).toFixed(3)) : 0;

  const checks = [
    {
      metric: 'completionRate',
      ok: Number(totals.completionRate) >= thresholds.completionRateMin,
      actual: Number(totals.completionRate),
      expect: `>= ${thresholds.completionRateMin}`,
    },
    {
      metric: 'winnerDeterminism',
      ok: Number(totals.winnerDeterminism) >= thresholds.winnerDeterminismMin,
      actual: Number(totals.winnerDeterminism),
      expect: `>= ${thresholds.winnerDeterminismMin}`,
    },
    {
      metric: 'fixturePassRate',
      ok: fixturePassRate >= thresholds.fixturePassRateMin,
      actual: fixturePassRate,
      expect: `>= ${thresholds.fixturePassRateMin}`,
    },
    {
      metric: 'voteIntegrityErrors',
      ok: Number(totals.voteIntegrityErrors) <= thresholds.voteIntegrityErrorsMax,
      actual: Number(totals.voteIntegrityErrors),
      expect: `<= ${thresholds.voteIntegrityErrorsMax}`,
    },
    {
      metric: 'meanRoundSteps',
      ok: Number(totals.meanRoundSteps) <= thresholds.meanRoundStepsMax,
      actual: Number(totals.meanRoundSteps),
      expect: `<= ${thresholds.meanRoundStepsMax}`,
    },
  ];

  return {
    ok: checks.every((c) => c.ok),
    checks,
    thresholds,
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  parseThresholdsFromEnv,
  evaluateEvalReport,
};
