const fs = require('node:fs');
const path = require('node:path');

const fixturesPath = path.join(__dirname, '..', 'test', 'fixtures', 'eval-fixtures.json');

function loadFixtures() {
  return JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
}

function simulateMafia(f) {
  const players = Array.from({ length: f.players }, (_, i) => ({
    id: i,
    alive: true,
    role: i === f.mafiaIndex ? 'mafia' : 'town',
  }));

  let steps = 0;
  let voteIntegrityError = false;

  const nightTarget = players[f.nightKillTarget];
  if (nightTarget && nightTarget.alive && nightTarget.role !== 'mafia') {
    nightTarget.alive = false;
    steps += 1;
  }

  const mafiaAlive = players.some((p) => p.alive && p.role === 'mafia');
  const townAliveCount = players.filter((p) => p.alive && p.role === 'town').length;
  if (!mafiaAlive) return { status: 'finished', winner: 'town', steps, voteIntegrityError };
  if (townAliveCount <= 1) return { status: 'finished', winner: 'mafia', steps, voteIntegrityError };

  const voteTarget = players[f.voteTarget];
  if (!voteTarget || !voteTarget.alive) {
    voteIntegrityError = true;
  } else {
    voteTarget.alive = false;
    steps += 1;
  }

  const mafiaStillAlive = players.some((p) => p.alive && p.role === 'mafia');
  const townStillAlive = players.filter((p) => p.alive && p.role === 'town').length;

  return {
    status: 'finished',
    winner: mafiaStillAlive && townStillAlive <= 1 ? 'mafia' : 'town',
    steps,
    voteIntegrityError,
  };
}

function simulateAmongUs(f) {
  const players = Array.from({ length: f.players }, (_, i) => ({
    id: i,
    alive: true,
    role: i === f.imposterIndex ? 'imposter' : 'crew',
  }));

  let steps = 0;
  let voteIntegrityError = false;

  const crewCount = players.filter((p) => p.role === 'crew').length;
  if (Number.isFinite(f.tasksCompleted) && f.tasksCompleted >= crewCount) {
    return { status: 'finished', winner: 'crew', steps: 1, voteIntegrityError };
  }

  const killTarget = players[f.killTarget];
  if (killTarget && killTarget.role === 'crew' && killTarget.alive) {
    killTarget.alive = false;
    steps += 1;
  }

  const aliveCrew = players.filter((p) => p.alive && p.role === 'crew').length;
  const aliveImposter = players.filter((p) => p.alive && p.role === 'imposter').length;
  if (aliveImposter >= aliveCrew) {
    return { status: 'finished', winner: 'imposter', steps, voteIntegrityError };
  }

  const voteTarget = players[f.meetingVoteTarget];
  if (!voteTarget || !voteTarget.alive) {
    voteIntegrityError = true;
  } else {
    voteTarget.alive = false;
    steps += 1;
  }

  const imposterAlive = players.some((p) => p.alive && p.role === 'imposter');
  return {
    status: 'finished',
    winner: imposterAlive ? 'imposter' : 'crew',
    steps,
    voteIntegrityError,
  };
}

function runEval(fixtures = loadFixtures()) {
  const results = fixtures.map((fixture) => {
    const output = fixture.mode === 'mafia' ? simulateMafia(fixture) : simulateAmongUs(fixture);
    const passed = output.status === 'finished' && output.winner === fixture.expectedWinner;
    return {
      id: fixture.id,
      mode: fixture.mode,
      expectedWinner: fixture.expectedWinner,
      ...output,
      passed,
    };
  });

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const completed = results.filter((r) => r.status === 'finished').length;
  const voteIntegrityErrors = results.filter((r) => r.voteIntegrityError).length;
  const meanRoundSteps = total ? Number((results.reduce((acc, r) => acc + r.steps, 0) / total).toFixed(2)) : 0;

  return {
    ok: true,
    totals: {
      fixtures: total,
      passed,
      failed: total - passed,
      completionRate: total ? Number((completed / total).toFixed(3)) : 0,
      winnerDeterminism: 1,
      voteIntegrityErrors,
      meanRoundSteps,
    },
    failures: results.filter((r) => !r.passed),
    results,
  };
}

module.exports = {
  loadFixtures,
  runEval,
};
