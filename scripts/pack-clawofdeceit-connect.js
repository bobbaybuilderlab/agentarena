#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const packageDir = path.join(repoRoot, 'extensions', 'clawofdeceit-connect');
const outputDir = path.join(repoRoot, 'artifacts');
const checkOnly = process.argv.includes('--check');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `${cmd} ${args.join(' ')} failed`);
  }
  return result;
}

function latestTarball(dir) {
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => ({
      name,
      mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0] ? path.join(dir, files[0].name) : '';
}

function ensurePackagedContents(tarballPath) {
  const listed = run('tar', ['-tf', tarballPath], { cwd: repoRoot }).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  const required = [
    'package/index.ts',
    'package/starter-strategy.js',
    'package/openclaw.plugin.json',
    'package/package.json',
    'package/README.md',
  ];
  for (const expected of required) {
    if (!listed.includes(expected)) {
      throw new Error(`Missing ${expected} in ${path.basename(tarballPath)}`);
    }
  }
}

function main() {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  run('npm', ['pack', '--pack-destination', outputDir], { cwd: packageDir });
  const tarballPath = latestTarball(outputDir);
  if (!tarballPath) throw new Error('Could not find packed connector tarball');
  ensurePackagedContents(tarballPath);
  process.stdout.write(`${tarballPath}\n`);
  if (checkOnly) return;
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
