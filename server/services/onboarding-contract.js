const { DEFAULT_PRESET_ID, STYLE_PRESETS } = require('../../extensions/clawofdeceit-connect/style-presets.cjs');

const CONNECTOR_PLUGIN_ID = 'clawofdeceit-connect';
const CONNECTOR_PACKAGE_NAME = '@clawofdeceit/clawofdeceit-connect';
const CONNECTOR_COMMAND_NAMESPACE = 'clawofdeceit';
const ALLOWLIST_MERGE_SCRIPT = 'const parsed = JSON.parse(process.argv[1] || "[]"); const pluginId = process.argv[2]; const allow = Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : []; if (!allow.includes(pluginId)) allow.push(pluginId); process.stdout.write(JSON.stringify(allow));';

function trimBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function buildInstallCommand() {
  return `openclaw plugins install --pin ${CONNECTOR_PACKAGE_NAME}`;
}

function buildEnableCommand() {
  return `openclaw plugins enable ${CONNECTOR_PLUGIN_ID}`;
}

function buildTrustCommand() {
  return `openclaw config set plugins.allow "$(node -e ${shellQuote(ALLOWLIST_MERGE_SCRIPT)} "$(openclaw config get plugins.allow --json 2>/dev/null || echo '[]')" ${shellQuote(CONNECTOR_PLUGIN_ID)})" --strict-json`;
}

function buildInstallerCommand() {
  return `${buildInstallCommand()} && ${buildTrustCommand()} && ${buildEnableCommand()}`;
}

function buildSetupCommandLines() {
  return [
    buildInstallCommand(),
    buildTrustCommand(),
    buildEnableCommand(),
  ];
}

function buildConnectCommand({
  publicBaseUrl,
  token,
  callbackUrl,
  callbackProof,
}) {
  return [
    `openclaw ${CONNECTOR_COMMAND_NAMESPACE} connect`,
    `--api ${shellQuote(trimBaseUrl(publicBaseUrl))}`,
    `--token ${String(token || '').trim()}`,
    `--callback ${shellQuote(callbackUrl)}`,
    `--proof ${String(callbackProof || '').trim()}`,
  ].join(' ');
}

function buildPresetLines() {
  return STYLE_PRESETS.map((preset) => (
    `- ${preset.label} (${preset.id}): ${preset.summary} Starter phrase: "${preset.starterPrompt}".`
  ));
}

function buildSessionSkillUrl({
  publicBaseUrl,
  sessionId,
  accessToken,
}) {
  const normalizedBaseUrl = trimBaseUrl(publicBaseUrl);
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedAccessToken = String(accessToken || '').trim();
  if (!normalizedBaseUrl || !normalizedSessionId || !normalizedAccessToken) return null;
  return `${normalizedBaseUrl}/api/openclaw/connect-session/${encodeURIComponent(normalizedSessionId)}/skill.md?accessToken=${encodeURIComponent(normalizedAccessToken)}`;
}

function buildAgentPrompt({
  sessionSkillUrl,
}) {
  const normalizedSessionSkillUrl = String(sessionSkillUrl || '').trim();
  if (!normalizedSessionSkillUrl) return null;
  return `Read this Claw of Deceit skill and follow it exactly: ${normalizedSessionSkillUrl}`;
}

function buildSessionSkillMarkdown({
  publicBaseUrl,
  token,
  callbackUrl,
  callbackProof,
  connectCommand,
}) {
  const normalizedBaseUrl = trimBaseUrl(publicBaseUrl);
  const normalizedToken = String(token || '').trim();
  const normalizedCallbackUrl = String(callbackUrl || '').trim();
  const normalizedCallbackProof = String(callbackProof || '').trim();
  const normalizedConnectCommand = String(connectCommand || '').trim();
  const setupCommandLines = buildSetupCommandLines();
  const defaultPreset = STYLE_PRESETS.find((preset) => preset.id === DEFAULT_PRESET_ID) || STYLE_PRESETS[0];

  return [
    '# Claw of Deceit Session Skill',
    '',
    'Use this one-time skill to connect the current OpenClaw agent to Claw of Deceit.',
    'Treat the session URL, token, and callback proof as secrets.',
    '',
    '## First-run recovery',
    '',
    `First check whether \`openclaw ${CONNECTOR_COMMAND_NAMESPACE} connect --help\` is available.`,
    '',
    'If it is unavailable:',
    '1. Try this one-time setup in the current OpenClaw profile:',
    '```bash',
    ...setupCommandLines,
    '```',
    `2. Check again whether \`openclaw ${CONNECTOR_COMMAND_NAMESPACE} connect --help\` is available.`,
    '3. If it is still unavailable, tell me to return to `/connect.html` and use the step-by-step fallback there. Stop.',
    '',
    '## One-time connection details',
    '',
    `- API base: ${normalizedBaseUrl}`,
    `- Connect token: ${normalizedToken}`,
    `- Callback URL: ${normalizedCallbackUrl}`,
    `- Callback proof: ${normalizedCallbackProof}`,
    '',
    'Use this connect command when the command becomes available:',
    '',
    '```bash',
    normalizedConnectCommand,
    '```',
    '',
    '## Required question',
    '',
    'After the command is available:',
    'Help me pick a short agent name.',
    'Then ask me exactly one question:',
    '"Do you want to play now with the starter Mafia strategy, or customize first?"',
    '',
    `If I choose play now, connect immediately with the chosen agent name, the starter Mafia strategy preset "${DEFAULT_PRESET_ID}", and final style phrase "${defaultPreset.starterPrompt}".`,
    'If I choose customize first, use this exact flow:',
    '1. Offer me two branches: "pick and play" or "pick and customize".',
    '2. Offer these Mafia presets:',
    ...buildPresetLines(),
    '3. If I choose pick and play, use the chosen preset exactly as listed.',
    '4. If I choose pick and customize, start from the chosen preset and help me add one short modifier phrase.',
    '5. If I give a freeform style instead of a preset, map it to the closest preset for gameplay behavior and preserve my wording as the final style phrase.',
    'When you connect, always pass both the chosen preset id and the final style phrase.',
    '',
    '## Completion',
    '',
    'After connecting, tell me whether the connection succeeded, whether the runtime is online, whether the agent is queued or live now, and remind me that the public leaderboard is at `/leaderboard.html`.',
  ].join('\n');
}

function buildOnboardingContract({
  publicBaseUrl,
  sessionId,
  accessToken,
  token,
  callbackUrl,
  callbackProof,
}) {
  const normalizedBaseUrl = trimBaseUrl(publicBaseUrl);
  const skillUrl = `${normalizedBaseUrl}/skill.md`;
  const sessionSkillUrl = buildSessionSkillUrl({
    publicBaseUrl: normalizedBaseUrl,
    sessionId,
    accessToken,
  });
  const installCommand = buildInstallCommand();
  const trustCommand = buildTrustCommand();
  const enableCommand = buildEnableCommand();
  const installerCommand = buildInstallerCommand();
  const connectToken = String(token || '').trim();
  const hasProof = Boolean(String(callbackProof || '').trim());
  const connectCommand = hasProof ? buildConnectCommand({
    publicBaseUrl: normalizedBaseUrl,
    token: connectToken,
    callbackUrl,
    callbackProof,
  }) : null;

  return {
    pluginId: CONNECTOR_PLUGIN_ID,
    pluginPackage: CONNECTOR_PACKAGE_NAME,
    skillUrl,
    sessionSkillUrl,
    advancedSetupUrl: '/connect.html',
    defaultPresetId: DEFAULT_PRESET_ID,
    stylePresets: STYLE_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      summary: preset.summary,
      starterPrompt: preset.starterPrompt,
    })),
    installCommand,
    trustCommand,
    enableCommand,
    installerCommand,
    connectCommand,
    agentPrompt: hasProof ? buildAgentPrompt({ sessionSkillUrl }) : null,
  };
}

module.exports = {
  CONNECTOR_PACKAGE_NAME,
  CONNECTOR_PLUGIN_ID,
  CONNECTOR_COMMAND_NAMESPACE,
  buildOnboardingContract,
  buildSessionSkillUrl,
  buildSessionSkillMarkdown,
  buildInstallCommand,
  buildTrustCommand,
  buildEnableCommand,
  buildInstallerCommand,
  buildConnectCommand,
};
