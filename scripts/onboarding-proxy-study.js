#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');

const {
  DEFAULT_OUTPUT_ROOT,
  buildCurrentFlowStudyPacket,
  formatStudySummaryMarkdown,
  summarizeStudyDirectory,
  writeStudyBundle,
} = require('../lib/onboarding-proxy-study.js');

function printHelpAndExit(code = 0) {
  console.log(`onboarding-proxy-study

Usage:
  node scripts/onboarding-proxy-study.js build [--output-dir DIR] [--baseline FILE] [--base-url URL]
  node scripts/onboarding-proxy-study.js baseline [--output FILE] -- [coldstart args...]
  node scripts/onboarding-proxy-study.js summarize [--input-dir DIR] [--format md|json] [--output FILE]

Notes:
  - \`build\` creates the study packet, reviewer prompts, and blank result templates.
  - \`baseline\` wraps scripts/run-openclaw-coldstart.js and writes structured JSON to the requested file.
  - \`summarize\` reads reviewer-result-*.json files from the study directory and emits a summary report.
`);
  process.exit(code);
}

function readArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return '';
  return args[idx + 1] || '';
}

function splitAtDoubleDash(args) {
  const idx = args.indexOf('--');
  if (idx === -1) {
    return {
      localArgs: args.slice(),
      forwardedArgs: [],
    };
  }
  return {
    localArgs: args.slice(0, idx),
    forwardedArgs: args.slice(idx + 1),
  };
}

function resolveOutputDir(value) {
  if (value) return path.resolve(process.cwd(), value);
  const stamp = new Date().toISOString().slice(0, 10);
  return path.join(DEFAULT_OUTPUT_ROOT, `current-flow-${stamp}`);
}

function writeOutputFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${String(content || '').replace(/\s+$/, '')}\n`, 'utf8');
}

function runBuild(localArgs) {
  const outputDir = resolveOutputDir(readArg(localArgs, '--output-dir'));
  const baselinePath = readArg(localArgs, '--baseline');
  const publicBaseUrl = readArg(localArgs, '--base-url') || undefined;

  const packet = buildCurrentFlowStudyPacket({
    publicBaseUrl,
    baselinePath: baselinePath ? path.resolve(process.cwd(), baselinePath) : '',
  });
  const files = writeStudyBundle(outputDir, packet);

  console.log(JSON.stringify({
    ok: true,
    command: 'build',
    outputDir,
    files: files.map((filePath) => path.relative(repoRoot, filePath).replace(/\\/g, '/')),
  }, null, 2));
}

function runBaseline(localArgs, forwardedArgs) {
  const outputFile = path.resolve(
    process.cwd(),
    readArg(localArgs, '--output') || path.join(resolveOutputDir(''), 'baseline.json'),
  );
  const coldstartScript = path.join(repoRoot, 'scripts', 'run-openclaw-coldstart.js');
  const invocationArgs = [coldstartScript, '--json-file', outputFile, ...forwardedArgs];

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const result = spawnSync(process.execPath, invocationArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  console.log(JSON.stringify({
    ok: true,
    command: 'baseline',
    outputFile,
  }, null, 2));
}

function runSummarize(localArgs) {
  const inputDir = path.resolve(process.cwd(), readArg(localArgs, '--input-dir') || resolveOutputDir(''));
  const format = readArg(localArgs, '--format') || 'md';
  if (!['md', 'json'].includes(format)) {
    throw new Error(`Unsupported format "${format}". Use md or json.`);
  }

  const summary = summarizeStudyDirectory(inputDir);
  const rendered = format === 'json'
    ? JSON.stringify(summary, null, 2)
    : formatStudySummaryMarkdown(summary);

  const outputPath = readArg(localArgs, '--output');
  if (outputPath) {
    writeOutputFile(path.resolve(process.cwd(), outputPath), rendered);
  }

  process.stdout.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    printHelpAndExit(0);
  }

  const { localArgs, forwardedArgs } = splitAtDoubleDash(args.slice(1));

  if (command === 'build') {
    runBuild(localArgs);
    return;
  }
  if (command === 'baseline') {
    runBaseline(localArgs, forwardedArgs);
    return;
  }
  if (command === 'summarize') {
    runSummarize(localArgs);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelpAndExit(2);
}

main();
