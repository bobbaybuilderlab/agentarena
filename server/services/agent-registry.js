const { buildResolvedPersona } = require('../../extensions/clawofdeceit-connect/style-presets.cjs');

function createConnectedOpenClawAgent({
  agentProfiles,
  connect,
  shortId,
  name,
  style,
  presetId,
  note,
}) {
  const agentId = shortId(10);
  const persona = buildResolvedPersona({ style, presetId });
  const agent = {
    id: agentId,
    owner: connect.email,
    name,
    deployed: true,
    mmr: 1000,
    karma: 0,
    persona: {
      style: persona.style,
      presetId: persona.presetId,
      intensity: 7,
    },
    openclaw: {
      connected: true,
      mode: 'cli',
      connectSessionId: connect.id,
      connectedAt: Date.now(),
      note,
    },
    createdAt: Date.now(),
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
