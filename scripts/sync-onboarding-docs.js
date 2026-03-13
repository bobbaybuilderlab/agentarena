#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  buildEnableCommand,
  buildInstallCommand,
  buildTrustCommand,
  CONNECTOR_COMMAND_NAMESPACE,
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
    `openclaw ${CONNECTOR_COMMAND_NAMESPACE} connect`,
    '--api https://<claw-of-deceit-host>',
    '--token <token>',
    '--callback <callback-url>',
    '--proof <proof>',
    '--agent <agent-name>',
    `--preset ${defaultPreset.id}`,
    `--style "${defaultPreset.starterPrompt}"`,
  ].join(' ');
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
    '## Connect',
    '',
    '```bash',
    renderConnectExample(),
    '```',
    '',
    'Notes:',
    '',
    '- Pass both `--preset` and `--style` so gameplay behavior and the final style phrase stay aligned.',
    '- The command stays running after connect so the runtime remains online for live matches.',
    '- After connect, the connector prints arena status plus watch and leaderboard URLs.',
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
