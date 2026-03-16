const DEFAULT_MMR = 1000;
const DEFAULT_PEAK_MMR = 1000;
const DEFAULT_RATED_MATCHES = 0;
const DEFAULT_LAST_DELTA = 0;
const MMR_FLOOR = 0;
const PROVISIONAL_MATCH_COUNT = 10;
const MAFIA_ELO_MODE = 'mafia';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundToInt(value, fallback = 0) {
  return Math.round(toNumber(value, fallback));
}

function resolveParticipantId(player) {
  if (!player) return '';
  return String(player.userId || player.agentId || player.playerId || player.name || '').trim();
}

function buildDefaultRatingSnapshot(overrides = {}) {
  const mmr = Math.max(MMR_FLOOR, roundToInt(overrides.mmr, DEFAULT_MMR));
  const peakMmr = Math.max(mmr, roundToInt(overrides.peakMmr, overrides.peak_mmr != null ? overrides.peak_mmr : DEFAULT_PEAK_MMR));
  const ratedMatches = Math.max(0, toNumber(
    overrides.ratedMatches != null ? overrides.ratedMatches : overrides.rated_matches,
    DEFAULT_RATED_MATCHES,
  ));
  const lastRatingDelta = roundToInt(
    overrides.lastRatingDelta != null ? overrides.lastRatingDelta : overrides.last_delta,
    DEFAULT_LAST_DELTA,
  );

  return {
    mmr,
    peakMmr,
    ratedMatches,
    lastRatingDelta,
    isProvisional: ratedMatches < PROVISIONAL_MATCH_COUNT,
  };
}

function normalizeRatingSnapshot(snapshot = {}) {
  return buildDefaultRatingSnapshot(snapshot);
}

function expectedScore(ownRating, opponentRating) {
  return 1 / (1 + (10 ** ((opponentRating - ownRating) / 400)));
}

function weightBandForWin(mmr) {
  if (mmr < 900) return 1.4;
  if (mmr < 1100) return 1.2;
  if (mmr < 1400) return 1.0;
  if (mmr < 1700) return 0.8;
  return 0.6;
}

function weightBandForLoss(mmr) {
  if (mmr < 900) return 0.6;
  if (mmr < 1100) return 0.8;
  if (mmr < 1400) return 1.0;
  if (mmr < 1700) return 1.2;
  return 1.4;
}

function provisionalModifier(snapshot) {
  return snapshot.ratedMatches < PROVISIONAL_MATCH_COUNT ? 1.5 : 1;
}

function normalizeSideWeights(players, getBaseWeight) {
  const weighted = players.map((player) => {
    const snapshot = normalizeRatingSnapshot(player.rating);
    const rawWeight = getBaseWeight(snapshot.mmr) * provisionalModifier(snapshot);
    return {
      ...player,
      rating: snapshot,
      rawWeight,
    };
  });
  const totalWeight = weighted.reduce((sum, player) => sum + player.rawWeight, 0) || 1;
  return weighted.map((player) => ({
    ...player,
    normalizedWeight: player.rawWeight / totalWeight,
  }));
}

function allocatePool(totalPool, players) {
  if (!players.length || totalPool <= 0) return [];
  const rawShares = players.map((player) => ({
    ...player,
    rawShare: totalPool * player.normalizedWeight,
  }));
  const flooredTotal = rawShares.reduce((sum, player) => sum + Math.floor(player.rawShare), 0);
  let remainder = Math.max(0, totalPool - flooredTotal);
  const ordered = [...rawShares].sort((a, b) => {
    const fracDelta = (b.rawShare - Math.floor(b.rawShare)) - (a.rawShare - Math.floor(a.rawShare));
    if (fracDelta !== 0) return fracDelta;
    const mmrDelta = Number(a.rating?.mmr || 0) - Number(b.rating?.mmr || 0);
    if (mmrDelta !== 0) return mmrDelta;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  const bonusById = new Map();
  for (const player of ordered) {
    if (remainder <= 0) break;
    bonusById.set(player.id, (bonusById.get(player.id) || 0) + 1);
    remainder -= 1;
  }
  return rawShares.map((player) => ({
    ...player,
    share: Math.floor(player.rawShare) + (bonusById.get(player.id) || 0),
  }));
}

function calculateMatchRatingChanges(match = {}, currentRatings = {}) {
  const mode = String(match.mode || MAFIA_ELO_MODE).trim().toLowerCase() || MAFIA_ELO_MODE;
  const winnerRole = String(match.winner || '').trim().toLowerCase();
  if (!winnerRole) return [];

  const participants = (Array.isArray(match.players) ? match.players : [])
    .filter((player) => player && !player.isBot)
    .map((player) => {
      const id = resolveParticipantId(player);
      if (!id) return null;
      return {
        id,
        role: String(player.role || '').trim().toLowerCase(),
        name: player.name || id,
        rating: normalizeRatingSnapshot(currentRatings[id] || {}),
      };
    })
    .filter(Boolean);

  if (!participants.length) return [];

  const winners = participants.filter((player) => player.role && player.role === winnerRole);
  const losers = participants.filter((player) => player.role && player.role !== winnerRole);
  if (!winners.length || !losers.length) return [];

  const winnerAverage = winners.reduce((sum, player) => sum + player.rating.mmr, 0) / winners.length;
  const loserAverage = losers.reduce((sum, player) => sum + player.rating.mmr, 0) / losers.length;
  const winnerExpectation = expectedScore(winnerAverage, loserAverage);
  const loserExpectation = 1 - winnerExpectation;
  const pool = Math.max(4, Math.round(40 * (1 - winnerExpectation)));

  const weightedWinners = allocatePool(pool, normalizeSideWeights(winners, weightBandForWin));
  const weightedLosers = allocatePool(pool, normalizeSideWeights(losers, weightBandForLoss));

  return [
    ...weightedWinners.map((player) => {
      const before = player.rating.mmr;
      const delta = player.share;
      const after = before + delta;
      return {
        id: player.id,
        name: player.name,
        mode,
        role: player.role,
        matchId: match.id || null,
        mmrBefore: before,
        mmrAfter: after,
        delta,
        expectedScore: winnerExpectation,
        pool,
        ratedMatchesBefore: player.rating.ratedMatches,
        ratedMatchesAfter: player.rating.ratedMatches + 1,
        peakMmrBefore: player.rating.peakMmr,
        peakMmrAfter: Math.max(player.rating.peakMmr, after),
        isProvisional: player.rating.ratedMatches < PROVISIONAL_MATCH_COUNT,
      };
    }),
    ...weightedLosers.map((player) => {
      const before = player.rating.mmr;
      const requestedLoss = player.share;
      const after = Math.max(MMR_FLOOR, before - requestedLoss);
      const delta = after - before;
      return {
        id: player.id,
        name: player.name,
        mode,
        role: player.role,
        matchId: match.id || null,
        mmrBefore: before,
        mmrAfter: after,
        delta,
        expectedScore: loserExpectation,
        pool,
        ratedMatchesBefore: player.rating.ratedMatches,
        ratedMatchesAfter: player.rating.ratedMatches + 1,
        peakMmrBefore: player.rating.peakMmr,
        peakMmrAfter: Math.max(player.rating.peakMmr, after),
        isProvisional: player.rating.ratedMatches < PROVISIONAL_MATCH_COUNT,
      };
    }),
  ].sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
}

module.exports = {
  DEFAULT_MMR,
  DEFAULT_PEAK_MMR,
  DEFAULT_RATED_MATCHES,
  DEFAULT_LAST_DELTA,
  MMR_FLOOR,
  PROVISIONAL_MATCH_COUNT,
  MAFIA_ELO_MODE,
  resolveParticipantId,
  buildDefaultRatingSnapshot,
  normalizeRatingSnapshot,
  expectedScore,
  calculateMatchRatingChanges,
};
