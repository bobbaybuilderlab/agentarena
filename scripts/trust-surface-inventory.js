#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PLAYBOOK_PATH = path.join(REPO_ROOT, 'docs', 'review-playbook.md');

const START = '<!-- TRUST_SURFACE:START -->';
const END = '<!-- TRUST_SURFACE:END -->';

function parseArgs(argv) {
  const out = {
    format: 'md',
    check: false,
    update: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--update') out.update = true;
    else if (a === '--format') out.format = argv[++i] || out.format;
    else if (a.startsWith('--format=')) out.format = a.slice('--format='.length);
    else if (a === '--help' || a === '-h') {
      printHelpAndExit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelpAndExit(2);
    }
  }

  if (out.check && out.update) {
    console.error('Use only one of --check or --update.');
    process.exit(2);
  }

  if (!['md', 'json'].includes(out.format)) {
    console.error(`Unsupported --format=${out.format} (expected md|json)`);
    process.exit(2);
  }

  return out;
}

function printHelpAndExit(code) {
  // Keep help short and stable since CI output is noisy.
  console.log(`trust-surface-inventory

Usage:
  node scripts/trust-surface-inventory.js [--format md|json] [--check|--update]

Modes:
  --check   Verifies docs/review-playbook.md inventory section matches generated output
  --update  Updates docs/review-playbook.md inventory section in-place
`);
  process.exit(code);
}

function isTextFile(p) {
  const ext = path.extname(p).toLowerCase();
  // Conservative allow-list. We only scan code-ish files.
  return ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.html'].includes(ext);
}

function walk(root, opts = {}) {
  const results = [];
  const ignoreDirs = new Set(opts.ignoreDirs || []);

  function rec(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name)) continue;
        rec(full);
      } else if (e.isFile()) {
        if (isTextFile(full)) results.push(full);
      }
    }
  }

  rec(root);
  return results;
}

function rel(p) {
  return path.relative(REPO_ROOT, p).replace(/\\/g, '/');
}

function lineNumberForIndex(text, idx) {
  // 1-based line numbers
  let line = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function scanRoutes(filePath, text) {
  const hits = [];

  const patterns = [
    // app.get('/x', ...), router.post("/x", ...), etc
    {
      kind: 'route',
      re: /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])([^'"`]+)\2\s*,/gi,
      mapper: (m) => ({ method: m[1].toUpperCase(), path: m[3] }),
    },
    // app.use('/x', ...)
    {
      kind: 'use',
      re: /\b(?:app|router)\s*\.\s*use\s*\(\s*(['"`])([^'"`]+)\1\s*,/gi,
      mapper: (m) => ({ method: 'USE', path: m[2] }),
    },
    // socket.io namespaces: io.of('/x')
    {
      kind: 'socket',
      re: /\bio\s*\.\s*of\s*\(\s*(['"`])([^'"`]+)\1\s*\)/gi,
      mapper: (m) => ({ method: 'SOCKET', path: m[2] }),
    },
  ];

  for (const p of patterns) {
    let match;
    while ((match = p.re.exec(text)) !== null) {
      const { method, path: routePath } = p.mapper(match);
      hits.push({
        kind: p.kind,
        method,
        path: routePath,
        file: rel(filePath),
        line: lineNumberForIndex(text, match.index),
      });
    }
  }

  return hits;
}

function scanRiskySinks(filePath, text) {
  const sinks = [];
  const patterns = [
    { id: 'innerHTML', re: /\.innerHTML\s*=/g },
    { id: 'insertAdjacentHTML', re: /\.insertAdjacentHTML\s*\(/g },
    { id: 'dangerouslySetInnerHTML', re: /dangerouslySetInnerHTML/g },
    { id: 'eval', re: /\beval\s*\(/g },
    { id: 'new Function', re: /\bnew\s+Function\s*\(/g },
  ];

  for (const p of patterns) {
    let match;
    while ((match = p.re.exec(text)) !== null) {
      sinks.push({
        sink: p.id,
        file: rel(filePath),
        line: lineNumberForIndex(text, match.index),
      });
    }
  }

  return sinks;
}

function generateInventory() {
  const scanTargets = [
    path.join(REPO_ROOT, 'server'),
    path.join(REPO_ROOT, 'public'),
    path.join(REPO_ROOT, 'games'),
    path.join(REPO_ROOT, 'lib'),
    path.join(REPO_ROOT, 'server.js'),
  ].filter((p) => fs.existsSync(p));

  const ignoreDirs = [
    'node_modules',
    'dist',
    'artifacts',
    'generated',
    'test-results',
    '.git',
    '.openclaw',
  ];

  const files = [];
  for (const t of scanTargets) {
    const st = fs.statSync(t);
    if (st.isFile()) files.push(t);
    else if (st.isDirectory()) files.push(...walk(t, { ignoreDirs }));
  }

  const routes = [];
  const sinks = [];

  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    routes.push(...scanRoutes(f, text));
    sinks.push(...scanRiskySinks(f, text));
  }

  // Normalize and dedupe (stable).
  const routeKey = (r) => `${r.method} ${r.path} @ ${r.file}:${r.line}`;
  const sinkKey = (s) => `${s.sink} @ ${s.file}:${s.line}`;

  const uniqRoutes = Array.from(new Map(routes.map((r) => [routeKey(r), r])).values()).sort((a, b) => {
    const ak = `${a.method}\n${a.path}\n${a.file}\n${a.line}`;
    const bk = `${b.method}\n${b.path}\n${b.file}\n${b.line}`;
    return ak.localeCompare(bk);
  });

  const uniqSinks = Array.from(new Map(sinks.map((s) => [sinkKey(s), s])).values()).sort((a, b) => {
    const ak = `${a.sink}\n${a.file}\n${a.line}`;
    const bk = `${b.sink}\n${b.file}\n${b.line}`;
    return ak.localeCompare(bk);
  });

  return {
    generatedAt: new Date().toISOString(),
    routes: uniqRoutes,
    riskySinks: uniqSinks,
  };
}

function toMarkdown(inv) {
  const lines = [];
  lines.push('<!-- Generated by scripts/trust-surface-inventory.js. Do not edit by hand. -->');
  lines.push('');
  lines.push('### HTTP / Socket Entry Points');
  lines.push('');
  lines.push('| Method | Path | Source |');
  lines.push('|---|---|---|');

  if (inv.routes.length === 0) {
    lines.push('| (none found) | | |');
  } else {
    for (const r of inv.routes) {
      lines.push(`| ${r.method} | \`${r.path}\` | \`${r.file}\` |`);
    }
  }

  lines.push('');
  lines.push('### Risky Sinks (Review Hotspots)');
  lines.push('');
  lines.push('| Sink | Source |');
  lines.push('|---|---|');

  if (inv.riskySinks.length === 0) {
    lines.push('| (none found) | |');
  } else {
    for (const s of inv.riskySinks) {
      lines.push(`| ${s.sink} | \`${s.file}\` |`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function extractBetweenMarkers(fileText) {
  const s = fileText.indexOf(START);
  const e = fileText.indexOf(END);
  if (s === -1 || e === -1 || e < s) return null;

  const before = fileText.slice(0, s + START.length);
  const after = fileText.slice(e);
  const middle = fileText.slice(s + START.length, e);
  return { before, middle, after };
}

function main() {
  const args = parseArgs(process.argv);
  const inv = generateInventory();

  if (args.format === 'json') {
    const json = JSON.stringify(inv, null, 2) + '\n';
    process.stdout.write(json);
    return;
  }

  const md = toMarkdown(inv);

  if (!args.check && !args.update) {
    process.stdout.write(md);
    return;
  }

  const playbook = fs.readFileSync(PLAYBOOK_PATH, 'utf8');
  const parts = extractBetweenMarkers(playbook);
  if (!parts) {
    console.error(`Missing markers in ${rel(PLAYBOOK_PATH)}. Expected ${START} ... ${END}.`);
    process.exit(2);
  }

  const expectedMiddle = '\n' + md + '\n';
  const currentMiddle = parts.middle.replace(/\r\n/g, '\n');

  if (args.check) {
    if (currentMiddle !== expectedMiddle) {
      console.error('Trust surface inventory is out of date.');
      console.error('Run: node scripts/trust-surface-inventory.js --update');
      process.exit(1);
    }
    return;
  }

  // update
  const next = parts.before + expectedMiddle + parts.after;
  fs.writeFileSync(PLAYBOOK_PATH, next, 'utf8');
  console.log(`Updated ${rel(PLAYBOOK_PATH)}`);
}

main();
