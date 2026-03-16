const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateMatchRatingChanges,
  DEFAULT_MMR,
} = require('../server/services/mafia-elo');

function updateById(updates, agentId) {
  return updates.find((update) => update.id === agentId);
}

test('equal-rating town win yields a 20-point pool with asymmetric per-player deltas', () => {
  const updates = calculateMatchRatingChanges({
    id: 'match-1',
    mode: 'mafia',
    winner: 'town',
    players: [
      { userId: 'town-1', role: 'town' },
      { userId: 'town-2', role: 'town' },
      { userId: 'town-3', role: 'town' },
      { userId: 'town-4', role: 'town' },
      { userId: 'mafia-1', role: 'mafia' },
      { userId: 'mafia-2', role: 'mafia' },
    ],
  }, {
    'town-1': { mmr: DEFAULT_MMR, ratedMatches: 10 },
    'town-2': { mmr: DEFAULT_MMR, ratedMatches: 10 },
    'town-3': { mmr: DEFAULT_MMR, ratedMatches: 10 },
    'town-4': { mmr: DEFAULT_MMR, ratedMatches: 10 },
    'mafia-1': { mmr: DEFAULT_MMR, ratedMatches: 10 },
    'mafia-2': { mmr: DEFAULT_MMR, ratedMatches: 10 },
  });

  const townDeltas = updates.filter((update) => update.role === 'town').map((update) => update.delta);
  const mafiaDeltas = updates.filter((update) => update.role === 'mafia').map((update) => update.delta);

  assert.deepEqual(townDeltas.sort((a, b) => a - b), [5, 5, 5, 5]);
  assert.deepEqual(mafiaDeltas.sort((a, b) => a - b), [-10, -10]);
  assert.equal(updateById(updates, 'town-1').pool, 20);
});

test('lower-rated winners gain more than higher-rated winners on the same side', () => {
  const updates = calculateMatchRatingChanges({
    winner: 'town',
    players: [
      { userId: 'low-town', role: 'town' },
      { userId: 'high-town', role: 'town' },
      { userId: 'mafia-1', role: 'mafia' },
      { userId: 'mafia-2', role: 'mafia' },
    ],
  }, {
    'low-town': { mmr: 850, ratedMatches: 15 },
    'high-town': { mmr: 1750, ratedMatches: 15 },
    'mafia-1': { mmr: 1200, ratedMatches: 15 },
    'mafia-2': { mmr: 1200, ratedMatches: 15 },
  });

  assert.ok(updateById(updates, 'low-town').delta > updateById(updates, 'high-town').delta);
});

test('higher-rated losers lose more than lower-rated losers on the same side', () => {
  const updates = calculateMatchRatingChanges({
    winner: 'town',
    players: [
      { userId: 'town-1', role: 'town' },
      { userId: 'town-2', role: 'town' },
      { userId: 'low-mafia', role: 'mafia' },
      { userId: 'high-mafia', role: 'mafia' },
    ],
  }, {
    'town-1': { mmr: 1200, ratedMatches: 15 },
    'town-2': { mmr: 1200, ratedMatches: 15 },
    'low-mafia': { mmr: 850, ratedMatches: 15 },
    'high-mafia': { mmr: 1750, ratedMatches: 15 },
  });

  assert.ok(updateById(updates, 'high-mafia').delta < updateById(updates, 'low-mafia').delta);
});

test('provisional agents move faster than veteran peers in the same result bucket', () => {
  const updates = calculateMatchRatingChanges({
    winner: 'town',
    players: [
      { userId: 'new-town', role: 'town' },
      { userId: 'old-town', role: 'town' },
      { userId: 'mafia-1', role: 'mafia' },
      { userId: 'mafia-2', role: 'mafia' },
    ],
  }, {
    'new-town': { mmr: 1000, ratedMatches: 0 },
    'old-town': { mmr: 1000, ratedMatches: 25 },
    'mafia-1': { mmr: 1000, ratedMatches: 25 },
    'mafia-2': { mmr: 1000, ratedMatches: 25 },
  });

  assert.ok(updateById(updates, 'new-town').delta > updateById(updates, 'old-town').delta);
});

test('favorite wins create a smaller pool than upsets', () => {
  const favoriteWin = calculateMatchRatingChanges({
    winner: 'town',
    players: [
      { userId: 'fav-town-1', role: 'town' },
      { userId: 'fav-town-2', role: 'town' },
      { userId: 'dog-mafia-1', role: 'mafia' },
      { userId: 'dog-mafia-2', role: 'mafia' },
    ],
  }, {
    'fav-town-1': { mmr: 1600, ratedMatches: 20 },
    'fav-town-2': { mmr: 1600, ratedMatches: 20 },
    'dog-mafia-1': { mmr: 1000, ratedMatches: 20 },
    'dog-mafia-2': { mmr: 1000, ratedMatches: 20 },
  });
  const upsetWin = calculateMatchRatingChanges({
    winner: 'town',
    players: [
      { userId: 'dog-town-1', role: 'town' },
      { userId: 'dog-town-2', role: 'town' },
      { userId: 'fav-mafia-1', role: 'mafia' },
      { userId: 'fav-mafia-2', role: 'mafia' },
    ],
  }, {
    'dog-town-1': { mmr: 1000, ratedMatches: 20 },
    'dog-town-2': { mmr: 1000, ratedMatches: 20 },
    'fav-mafia-1': { mmr: 1600, ratedMatches: 20 },
    'fav-mafia-2': { mmr: 1600, ratedMatches: 20 },
  });

  assert.ok(favoriteWin[0].pool < upsetWin[0].pool);
});

test('rating floor clips losses at zero and ratings remain uncapped on the upside', () => {
  const updates = calculateMatchRatingChanges({
    winner: 'town',
    players: [
      { userId: 'winner', role: 'town' },
      { userId: 'loser', role: 'mafia' },
    ],
  }, {
    winner: { mmr: 2400, ratedMatches: 30 },
    loser: { mmr: 3, ratedMatches: 30 },
  });

  assert.equal(updateById(updates, 'loser').mmrAfter, 0);
  assert.equal(updateById(updates, 'loser').delta, -3);
  assert.ok(updateById(updates, 'winner').mmrAfter > 2400);
});
