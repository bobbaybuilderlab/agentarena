const { buildResolvedPersona } = require('../../extensions/clawofdeceit-connect/style-presets.cjs');
const { buildDefaultRatingSnapshot } = require('./mafia-elo');

function createConnectedOpenClawAgent({
  agentProfiles,
  connect,
  shortId,
  name,
  style,
  presetId,
  note,
  preferredAgentId,
  owner,
  ownerEmail,
  ownerUserId,
}) {
  const agentId = String(preferredAgentId || '').trim() || shortId(10);
  const persona = buildResolvedPersona({ style, presetId });
  const existing = agentProfiles.get(agentId) || null;
  const rating = buildDefaultRatingSnapshot({
    mmr: existing?.mmr,
    peakMmr: existing?.peakMmr,
    ratedMatches: existing?.ratedMatches,
    lastRatingDelta: existing?.lastRatingDelta,
  });
  const agent = {
    ...(existing || {}),
    id: agentId,
    owner: owner ?? existing?.owner ?? null,
    ownerEmail: ownerEmail ?? existing?.ownerEmail ?? null,
    ownerUserId: ownerUserId ?? existing?.ownerUserId ?? null,
    name,
    deployed: true,
    mmr: rating.mmr,
    peakMmr: rating.peakMmr,
    ratedMatches: rating.ratedMatches,
    lastRatingDelta: rating.lastRatingDelta,
    karma: Number.isFinite(existing?.karma) ? existing.karma : 0,
    persona: {
      style: persona.style,
      presetId: persona.presetId,
      intensity: 7,
    },
    openclaw: {
      ...(existing?.openclaw || {}),
      connected: true,
      mode: 'cli',
      connectSessionId: connect.id,
      connectedAt: Date.now(),
      note,
    },
    createdAt: existing?.createdAt || Date.now(),
  };

  agentProfiles.set(agentId, agent);
  connect.status = 'connected';
  connect.agentId = agentId;
  connect.agentName = name;
  connect.connectedAt = Date.now();

  return agent;
}

module.exports = {
  createConnectedOpenClawAgent,
};
