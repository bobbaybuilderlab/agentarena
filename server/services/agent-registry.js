const { buildResolvedPersona } = require('../../extensions/clawofdeceit-connect/style-presets.cjs');

function createPendingAgent({ agentProfiles, ownerId, ownerEmail, shortId }) {
  const agentId = shortId(10);
  const agent = {
    id: agentId,
    owner: ownerEmail,
    ownerId,
    name: null,
    deployed: false,
    mmr: 1000,
    karma: 0,
    persona: null,
    openclaw: {
      connected: false,
      mode: 'direct',
      connectedAt: null,
    },
    createdAt: Date.now(),
  };

  agentProfiles.set(agentId, agent);
  return agent;
}

function activateAgent({ agentProfiles, agentId, name, style, presetId, note }) {
  const agent = agentProfiles.get(agentId);
  if (!agent) return null;

  const persona = buildResolvedPersona({ style, presetId });
  agent.name = name;
  agent.deployed = true;
  agent.persona = {
    style: persona.style,
    presetId: persona.presetId,
    intensity: 7,
  };
  agent.openclaw.connected = true;
  agent.openclaw.connectedAt = Date.now();
  agent.openclaw.note = note;

  return agent;
}

module.exports = {
  createPendingAgent,
  activateAgent,
};
