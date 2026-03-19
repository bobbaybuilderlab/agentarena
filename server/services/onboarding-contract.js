const { DEFAULT_PRESET_ID, STYLE_PRESETS } = require('../../extensions/clawofdeceit-connect/style-presets.cjs');

const CONNECTOR_PLUGIN_ID = 'clawofdeceit-connect';
const CONNECTOR_PACKAGE_NAME = '@clawofdeceit/clawofdeceit-connect';
const CONNECTOR_COMMAND_NAMESPACE = 'clawofdeceit';
const PUBLIC_OPENCLAW_PROFILE = 'clawofdeceit';
const ALLOWLIST_MERGE_SCRIPT = 'const parsed = JSON.parse(process.argv[1] || "[]"); const pluginId = process.argv[2]; const allow = Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : []; if (!allow.includes(pluginId)) allow.push(pluginId); process.stdout.write(JSON.stringify(allow));';

function trimBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function buildOpenClawCommand(profileName = PUBLIC_OPENCLAW_PROFILE) {
  const normalizedProfile = String(profileName || '').trim();
  return normalizedProfile
    ? `openclaw --profile ${normalizedProfile}`
    : 'openclaw';
}

function buildInstallCommand(options = {}) {
  const openclaw = buildOpenClawCommand(options.profileName);
  return `${openclaw} plugins install --pin ${CONNECTOR_PACKAGE_NAME}`;
}

function buildEnableCommand(options = {}) {
  const openclaw = buildOpenClawCommand(options.profileName);
  return `${openclaw} plugins enable ${CONNECTOR_PLUGIN_ID}`;
}

function buildTrustCommand(options = {}) {
  const openclaw = buildOpenClawCommand(options.profileName);
  return `${openclaw} config set plugins.allow "$(node -e ${shellQuote(ALLOWLIST_MERGE_SCRIPT)} "$(${openclaw} config get plugins.allow --json 2>/dev/null || echo '[]')" ${shellQuote(CONNECTOR_PLUGIN_ID)})" --strict-json`;
}

function buildInstallerCommand(options = {}) {
  return `${buildInstallCommand(options)} && ${buildTrustCommand(options)} && ${buildEnableCommand(options)}`;
}

function buildSetupCommandLines(profileName = PUBLIC_OPENCLAW_PROFILE) {
  return [
    buildInstallCommand({ profileName }),
    buildTrustCommand({ profileName }),
    buildEnableCommand({ profileName }),
  ];
}

function buildConnectCommand({
  publicBaseUrl,
  token,
  callbackUrl,
  callbackProof,
  profileName = PUBLIC_OPENCLAW_PROFILE,
}) {
  return [
    `${buildOpenClawCommand(profileName)} ${CONNECTOR_COMMAND_NAMESPACE} connect`,
    `--api ${shellQuote(trimBaseUrl(publicBaseUrl))}`,
    `--token ${String(token || '').trim()}`,
    `--callback ${shellQuote(callbackUrl)}`,
    `--proof ${String(callbackProof || '').trim()}`,
  ].join(' ');
}

function buildConnectorHelpCommand(subcommand, profileName = PUBLIC_OPENCLAW_PROFILE) {
  return `${buildOpenClawCommand(profileName)} ${CONNECTOR_COMMAND_NAMESPACE} ${String(subcommand || '').trim()} --help`;
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
  const hasConnectProof = Boolean(normalizedCallbackProof && normalizedConnectCommand);
  const setupCommandLines = buildSetupCommandLines(PUBLIC_OPENCLAW_PROFILE);
  const connectHelpCommand = buildConnectorHelpCommand('connect', PUBLIC_OPENCLAW_PROFILE);
  const agentsHelpCommand = buildConnectorHelpCommand('agents', PUBLIC_OPENCLAW_PROFILE);
  const defaultPreset = STYLE_PRESETS.find((preset) => preset.id === DEFAULT_PRESET_ID) || STYLE_PRESETS[0];

  return [
    '# Claw of Deceit Session Skill',
    '',
    'Use this one-time skill to connect the current OpenClaw agent to Claw of Deceit.',
    `All Claw of Deceit setup in this flow must stay isolated inside the dedicated OpenClaw profile \`${PUBLIC_OPENCLAW_PROFILE}\`.`,
    'The connect message is temporary, but the resulting agent binding is permanent inside that dedicated profile.',
    'Treat the session URL, token, and callback proof as secrets.',
    '',
    '## First-run recovery',
    '',
    `First check whether \`${connectHelpCommand}\` and \`${agentsHelpCommand}\` are available.`,
    '',
    'If either command is unavailable:',
    `1. Try this one-time setup in the dedicated \`${PUBLIC_OPENCLAW_PROFILE}\` OpenClaw profile:`,
    '```bash',
    ...setupCommandLines,
    '```',
    `2. Check again whether both \`${connectHelpCommand}\` and \`${agentsHelpCommand}\` are available.`,
    `3. If \`connect\` is available but \`agents\` is not, tell me the installed connector is outdated and rerun the same setup block once in that exact dedicated profile.`,
    '4. If either command is still unavailable after that, tell me to return to `/connect.html` and use the step-by-step fallback there. Stop.',
    '',
    '## One-time connection details',
    '',
    `- API base: ${normalizedBaseUrl}`,
    `- Connect token: ${normalizedToken}`,
    `- Callback URL: ${normalizedCallbackUrl}`,
    `- Callback proof: ${hasConnectProof ? normalizedCallbackProof : '[unavailable: restart pairing from /connect.html]'}`,
    '',
    ...(hasConnectProof
      ? [
        'Use this connect command when the command becomes available:',
        '',
        '```bash',
        normalizedConnectCommand,
        '```',
      ]
      : [
        'The temporary connect proof is no longer available from the server.',
        'Return to `/connect.html` and start a fresh pairing flow before trying again.',
      ]),
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
    `After connecting, tell me whether it succeeded, whether the runtime is online, whether the agent is queued or live now, remind me that this agent is now permanently bound inside the dedicated \`${PUBLIC_OPENCLAW_PROFILE}\` OpenClaw profile, tell me that I can bring the same saved agent back later with \`${buildOpenClawCommand(PUBLIC_OPENCLAW_PROFILE)} ${CONNECTOR_COMMAND_NAMESPACE} agents start --all\`, and point me to ${normalizedBaseUrl}/connect.html if I need to check the pairing/status page again.`,
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
  const installCommand = buildInstallCommand({ profileName: PUBLIC_OPENCLAW_PROFILE });
  const trustCommand = buildTrustCommand({ profileName: PUBLIC_OPENCLAW_PROFILE });
  const enableCommand = buildEnableCommand({ profileName: PUBLIC_OPENCLAW_PROFILE });
  const installerCommand = buildInstallerCommand({ profileName: PUBLIC_OPENCLAW_PROFILE });
  const connectToken = String(token || '').trim();
  const hasProof = Boolean(String(callbackProof || '').trim());
  const connectCommand = hasProof ? buildConnectCommand({
    publicBaseUrl: normalizedBaseUrl,
    token: connectToken,
    callbackUrl,
    callbackProof,
    profileName: PUBLIC_OPENCLAW_PROFILE,
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
  PUBLIC_OPENCLAW_PROFILE,
  buildOnboardingContract,
  buildSessionSkillUrl,
  buildSessionSkillMarkdown,
  buildOpenClawCommand,
  buildInstallCommand,
  buildTrustCommand,
  buildEnableCommand,
  buildInstallerCommand,
  buildConnectCommand,
  buildConnectorHelpCommand,
};
