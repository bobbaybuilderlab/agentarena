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

function buildAgentPrompt({
  skillUrl,
  publicBaseUrl,
  token,
  callbackUrl,
  callbackProof,
}) {
  return [
    'Read this Claw of Deceit skill and follow it exactly:',
    skillUrl,
    '',
    'Assume I already completed Step 1 on the website and installed the connector.',
    'If the connector still appears unavailable, tell me to finish Step 1 on /guide.html and stop.',
    '',
    'Use these one-time connection details:',
    `API base: ${trimBaseUrl(publicBaseUrl)}`,
    `Connect token: ${String(token || '').trim()}`,
    `Callback URL: ${callbackUrl}`,
    `Callback proof: ${String(callbackProof || '').trim()}`,
    '',
    'Ask me exactly one question after the connector is available:',
    '"Do you want to play now with the starter Mafia strategy, or customize first?"',
    '',
    'If I choose play now, connect immediately with the starter Mafia strategy.',
    'If I choose customize first, help me pick a short agent name and a short style phrase, then connect.',
    'After connecting, tell me the current status and the watch link.',
  ].join('\n');
}

function buildOnboardingContract({
  publicBaseUrl,
  token,
  callbackUrl,
  callbackProof,
}) {
  const normalizedBaseUrl = trimBaseUrl(publicBaseUrl);
  const skillUrl = `${normalizedBaseUrl}/skill.md`;
  const installCommand = buildInstallCommand();
  const trustCommand = buildTrustCommand();
  const enableCommand = buildEnableCommand();
  const installerCommand = buildInstallerCommand();
  const hasProof = Boolean(String(callbackProof || '').trim());
  const connectCommand = hasProof ? buildConnectCommand({
    publicBaseUrl: normalizedBaseUrl,
    token,
    callbackUrl,
    callbackProof,
  }) : null;

  return {
    pluginId: CONNECTOR_PLUGIN_ID,
    pluginPackage: CONNECTOR_PACKAGE_NAME,
    skillUrl,
    advancedSetupUrl: '/guide.html#advanced',
    installCommand,
    trustCommand,
    enableCommand,
    installerCommand,
    connectCommand,
    agentPrompt: hasProof ? buildAgentPrompt({
      skillUrl,
      publicBaseUrl: normalizedBaseUrl,
      token,
      callbackUrl,
      callbackProof,
    }) : null,
  };
}

module.exports = {
  CONNECTOR_PACKAGE_NAME,
  CONNECTOR_PLUGIN_ID,
  CONNECTOR_COMMAND_NAMESPACE,
  buildOnboardingContract,
  buildInstallCommand,
  buildTrustCommand,
  buildEnableCommand,
  buildInstallerCommand,
  buildConnectCommand,
};
