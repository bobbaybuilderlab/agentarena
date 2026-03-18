const { randomUUID } = require('crypto');
const { buildResolvedPersona } = require('../../extensions/clawofdeceit-connect/style-presets.cjs');
const { buildDefaultRatingSnapshot } = require('./mafia-elo');
const { getAgentRecordByName, upsertAgentRecord } = require('../db');

async function createConnectedOpenClawAgent({
  agentProfiles,
  connect,
  name,
  style,
  presetId,
  note,
  preferredAgentId,
  owner,
  ownerEmail,
  ownerUserId,
}) {
  const existingByName = await getAgentRecordByName(name);
  if (existingByName) {
    const error = new Error('agent name already taken');
    error.code = 'AGENT_NAME_TAKEN';
    throw error;
  }

  const agentId = randomUUID();
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
    owner: connect.email === 'anonymous' ? null : connect.email,
    ownerUserId: connect.ownerUserId || null,
    name,
    nameNormalized: String(name || '').trim().toLowerCase(),
    deployed: true,
    lifecycleState: 'active',
    archivedAt: null,
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

  await upsertAgentRecord(agent);

  return agent;
}

module.exports = {
  createConnectedOpenClawAgent,
};
