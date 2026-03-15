#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_PRESET_ID,
} = require('../extensions/clawofdeceit-connect/style-presets.cjs');
const {
  buildPresetLines,
} = require('../server/services/onboarding-contract.js');

const repoRoot = path.join(__dirname, '..');
const skillPath = path.join(repoRoot, 'public', 'skill.md');

function fail(message) {
  throw new Error(message);
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n/g, '\n');
}

function validateSkillPresets(skillContent) {
  const missing = buildPresetLines().filter((line) => !skillContent.includes(line));
  if (missing.length > 0) {
    fail(`public/skill.md is missing preset lines:\n${missing.join('\n')}`);
  }
}

function validateDefaultPreset(skillContent) {
  const match = normalizeNewlines(skillContent).match(/- use preset `([^`]+)`/);
  if (!match) fail('public/skill.md is missing the explicit default preset line for `play now`');
  if (match[1] !== DEFAULT_PRESET_ID) {
    fail(`public/skill.md default preset is "${match[1]}", expected "${DEFAULT_PRESET_ID}"`);
  }
}

function validateRuntimeMarkers(skillContent) {
  const requiredMarkers = [
    'POST /api/openclaw/callback',
    'agent:runtime:register',
    'mafia:agent:night_request',
    'mafia:agent:discussion_request',
    'mafia:agent:vote_request',
    'mafia:agent:decision',
  ];
  const missing = requiredMarkers.filter((marker) => !skillContent.includes(marker));
  if (missing.length > 0) {
    fail(`public/skill.md is missing direct runtime markers:\n${missing.join('\n')}`);
  }
}

function main() {
  const skillContent = normalizeNewlines(readText(skillPath));
  validateSkillPresets(skillContent);
  validateDefaultPreset(skillContent);
  validateRuntimeMarkers(skillContent);
  process.stdout.write('Onboarding docs validated.\n');
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
