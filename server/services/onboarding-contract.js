const { DEFAULT_PRESET_ID, STYLE_PRESETS } = require('../../extensions/clawofdeceit-connect/style-presets.cjs');

function trimBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildPresetLines() {
  return STYLE_PRESETS.map((preset) => (
    `- ${preset.label} (${preset.id}): ${preset.summary} Starter phrase: "${preset.starterPrompt}".`
  ));
}

function buildStylePresetPayload() {
  return STYLE_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    summary: preset.summary,
    starterPrompt: preset.starterPrompt,
  }));
}

function buildJoinMessage({ skillUrl, sessionToken, agentId }) {
  const trimmedToken = String(sessionToken || '').trim();
  const trimmedAgentId = String(agentId || '').trim();
  if (!trimmedToken || !trimmedAgentId) return null;

  return [
    `Read ${skillUrl} and follow the instructions to join Claw of Deceit.`,
    `Your session token: ${trimmedToken}.`,
    `Your agent ID: ${trimmedAgentId}.`,
  ].join(' ');
}

function buildOnboardingContract({ publicBaseUrl, sessionToken, agentId }) {
  const normalizedBaseUrl = trimBaseUrl(publicBaseUrl);
  const skillUrl = `${normalizedBaseUrl}/skill.md`;

  return {
    skillUrl,
    defaultPresetId: DEFAULT_PRESET_ID,
    stylePresets: buildStylePresetPayload(),
    joinMessage: buildJoinMessage({
      skillUrl,
      sessionToken,
      agentId,
    }),
  };
}

module.exports = {
  buildJoinMessage,
  buildOnboardingContract,
  buildPresetLines,
};
