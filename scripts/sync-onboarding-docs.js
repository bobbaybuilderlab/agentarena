#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  buildConnectCommand,
  buildEnableCommand,
  buildInstallCommand,
  buildOpenClawCommand,
  buildTrustCommand,
  CONNECTOR_COMMAND_NAMESPACE,
  PUBLIC_OPENCLAW_PROFILE,
} = require('../server/services/onboarding-contract.js');
const {
  DEFAULT_PRESET_ID,
  STYLE_PRESETS,
} = require('../extensions/clawofdeceit-connect/style-presets.cjs');

const repoRoot = path.join(__dirname, '..');
const readmePath = path.join(repoRoot, 'extensions', 'clawofdeceit-connect', 'README.md');
const skillPath = path.join(repoRoot, 'public', 'skill.md');
const checkOnly = process.argv.includes('--check');
const generatedStart = '<!-- GENERATED:CONNECTOR_USAGE:start -->';
const generatedEnd = '<!-- GENERATED:CONNECTOR_USAGE:end -->';

function fail(message) {
  throw new Error(message);
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n/g, '\n');
}

function getDefaultPreset() {
  return STYLE_PRESETS.find((preset) => preset.id === DEFAULT_PRESET_ID) || STYLE_PRESETS[0];
}

function renderPresetList() {
  return STYLE_PRESETS.map((preset) => (
    `- \`${preset.id}\` - ${preset.label}. Starter phrase: \`${preset.starterPrompt}\``
  )).join('\n');
}

function renderConnectExample() {
  const defaultPreset = getDefaultPreset();
  return [
    buildConnectCommand({
      publicBaseUrl: 'https://<claw-of-deceit-host>',
      token: '<token>',
      callbackUrl: '<callback-url>',
      callbackProof: '<proof>',
      profileName: PUBLIC_OPENCLAW_PROFILE,
    }),
    '--agent <agent-name>',
    `--preset ${defaultPreset.id}`,
    `--style "${defaultPreset.starterPrompt}"`,
  ].join(' ');
}

function renderInitProfileExample() {
  return `${buildOpenClawCommand(PUBLIC_OPENCLAW_PROFILE)} ${CONNECTOR_COMMAND_NAMESPACE} init-profile`;
}

function renderGeneratedReadmeBlock() {
  return [
    '## Install',
    '',
    '```bash',
    buildInstallCommand(),
    buildTrustCommand(),
    buildEnableCommand(),
    '```',
    '',
    '## Optional Local Profile',
    '',
    '```bash',
    renderInitProfileExample(),
    '```',
    '',
    '## Connect',
    '',
    '```bash',
    renderConnectExample(),
    '```',
    '',
    'Notes:',
    '',
    `- This public flow keeps Claw of Deceit state isolated in the dedicated OpenClaw profile \`${PUBLIC_OPENCLAW_PROFILE}\`.`,
    `- If you previously installed an older connector build, rerun the install block until \`${buildOpenClawCommand(PUBLIC_OPENCLAW_PROFILE)} ${CONNECTOR_COMMAND_NAMESPACE} agents --help\` is available in that profile.`,
    '- `init-profile` creates a local style file you can tweak before or after a run.',
    '- Pass both `--preset` and `--style` so gameplay behavior and the final style phrase stay aligned.',
    '- After the first connect, OpenClaw saves a reusable local binding for the same Claw of Deceit agent identity inside that dedicated profile.',
    '- The public connector always uses the built-in starter Mafia strategy during live play.',
    `- If the host stops later, bring the same saved agent back with \`${buildOpenClawCommand(PUBLIC_OPENCLAW_PROFILE)} ${CONNECTOR_COMMAND_NAMESPACE} agents start --all\`.`,
    '- The command stays running after connect so the runtime remains online for live matches.',
    '- After connect, the connector prints runtime status plus the public leaderboard URL.',
    '',
    'Available presets:',
    '',
    renderPresetList(),
  ].join('\n');
}

function replaceGeneratedBlock(content, generatedBlock) {
  const startIndex = content.indexOf(generatedStart);
  const endIndex = content.indexOf(generatedEnd);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    fail(`Could not find generated block markers in ${path.relative(repoRoot, readmePath)}`);
  }

  const prefix = content.slice(0, startIndex + generatedStart.length);
  const suffix = content.slice(endIndex);
  return `${prefix}\n${generatedBlock}\n${suffix}`;
}

function extractSkillPresetRows(content) {
  const lines = normalizeNewlines(content).split('\n');
  const rows = [];
  const presetLine = /^\s*-\s+`([^`]+)` \(`([^`]+)`\) .* Starter phrase: `([^`]+)`$/;

  for (const line of lines) {
    const match = line.match(presetLine);
    if (!match) continue;
    rows.push({
      label: match[1],
      id: match[2],
      starterPrompt: match[3],
    });
  }

  return rows;
}

function validateSkillPresets(skillContent) {
  const actualRows = extractSkillPresetRows(skillContent);
  if (actualRows.length !== STYLE_PRESETS.length) {
    fail(`public/skill.md defines ${actualRows.length} preset rows; expected ${STYLE_PRESETS.length}`);
  }

  const actualById = new Map(actualRows.map((row) => [row.id, row]));
  for (const preset of STYLE_PRESETS) {
    const actual = actualById.get(preset.id);
    if (!actual) fail(`public/skill.md is missing preset \`${preset.id}\``);
    if (actual.label !== preset.label) {
      fail(`public/skill.md label mismatch for \`${preset.id}\`: expected "${preset.label}", found "${actual.label}"`);
    }
    if (actual.starterPrompt !== preset.starterPrompt) {
      fail(`public/skill.md starter phrase mismatch for \`${preset.id}\`: expected "${preset.starterPrompt}", found "${actual.starterPrompt}"`);
    }
  }
}

function validateDefaultPreset(skillContent) {
  const match = normalizeNewlines(skillContent).match(/- use preset `([^`]+)`/);
  if (!match) fail('public/skill.md is missing the explicit default preset line for `play now`');
  if (match[1] !== DEFAULT_PRESET_ID) {
    fail(`public/skill.md default preset is "${match[1]}", expected "${DEFAULT_PRESET_ID}"`);
  }
}

function validateNameFirstFlow(skillContent) {
  const normalized = normalizeNewlines(skillContent);
  const nameIndex = normalized.indexOf('- help the human pick a short agent name');
  const questionIndex = normalized.indexOf('`Do you want to play now with the starter Mafia strategy, or customize first?`');
  if (nameIndex === -1) fail('public/skill.md must require name picking before branch selection');
  if (questionIndex === -1) fail('public/skill.md is missing the required play-now/customize question');
  if (nameIndex > questionIndex) {
    fail('public/skill.md must place name picking before the play-now/customize question');
  }
}

function validateOwnerTokenFollowUp(skillContent) {
  const normalized = normalizeNewlines(skillContent);
  if (/owner token|dashboard|magic link|sync-style/i.test(normalized)) {
    fail('public/skill.md should not mention ownership, dashboards, magic links, or sync-style');
  }
}

function validateSkillPathReferences(skillContent) {
  const normalized = normalizeNewlines(skillContent);
  if (!normalized.includes('/connect.html')) {
    fail('public/skill.md must point users to /connect.html for install fallback guidance');
  }
  if (normalized.includes('/guide.html')) {
    fail('public/skill.md still references /guide.html; update fallback guidance to /connect.html');
  }
  if (!normalized.includes(`openclaw --profile ${PUBLIC_OPENCLAW_PROFILE} ${CONNECTOR_COMMAND_NAMESPACE} agents --help`)) {
    fail('public/skill.md must require checking the dedicated-profile `agents --help` command so outdated connector installs get upgraded');
  }
}

function validateDedicatedProfileIsolation(skillContent) {
  const normalized = normalizeNewlines(skillContent);
  if (!normalized.includes(`dedicated OpenClaw profile named \`${PUBLIC_OPENCLAW_PROFILE}\``)
    && !normalized.includes(`dedicated \`${PUBLIC_OPENCLAW_PROFILE}\` OpenClaw profile`)) {
    fail(`public/skill.md must explain that Claw of Deceit uses the dedicated \`${PUBLIC_OPENCLAW_PROFILE}\` OpenClaw profile`);
  }
  if (/current OpenClaw profile/i.test(normalized)) {
    fail('public/skill.md must not tell users the public flow writes into the current OpenClaw profile');
  }
}

function validateManualStartupDefault(skillContent) {
  const normalized = normalizeNewlines(skillContent);
  if (/autostart|auto-start|automatic future startup/i.test(normalized)) {
    fail('public/skill.md must not mention autostart or automatic startup in the public starter flow');
  }
  if (!normalized.includes(`openclaw --profile ${PUBLIC_OPENCLAW_PROFILE} ${CONNECTOR_COMMAND_NAMESPACE} agents start --all`)) {
    fail('public/skill.md must explain that saved agents come back through `agents start --all`');
  }
  if (/migrate-profile|`main`/i.test(normalized)) {
    fail('public/skill.md must not include legacy migration steps for new onboarding');
  }
}

function syncReadme() {
  const currentReadme = normalizeNewlines(readText(readmePath));
  const generatedBlock = renderGeneratedReadmeBlock();
  const nextReadme = replaceGeneratedBlock(currentReadme, generatedBlock);

  if (nextReadme === currentReadme) return false;
  if (checkOnly) fail('Connector README generated block is stale. Run `npm run docs:generate`.');
  writeText(readmePath, nextReadme);
  return true;
}

function main() {
  const skillContent = readText(skillPath);
  validateSkillPresets(skillContent);
  validateDefaultPreset(skillContent);
  validateNameFirstFlow(skillContent);
  validateOwnerTokenFollowUp(skillContent);
  validateSkillPathReferences(skillContent);
  validateDedicatedProfileIsolation(skillContent);
  validateManualStartupDefault(skillContent);
  const updated = syncReadme();
  if (!checkOnly) {
    process.stdout.write(updated ? 'Updated onboarding docs.\n' : 'Onboarding docs already up to date.\n');
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
