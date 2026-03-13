const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

test('resolvePublicBaseUrl prefers PUBLIC_APP_URL over request host', () => {
  process.env.PUBLIC_APP_URL = 'https://arena.example.com/';
  delete require.cache[require.resolve('../server')];
  const { resolvePublicBaseUrl } = require('../server');

  const resolved = resolvePublicBaseUrl({
    protocol: 'http',
    get(header) {
      return header === 'host' ? '127.0.0.1:3000' : '';
    },
  });

  assert.equal(resolved, 'https://arena.example.com');

  delete require.cache[require.resolve('../server')];
  delete process.env.PUBLIC_APP_URL;
});

test('injectPublicBaseUrl rewrites the stale hosted metadata domain', () => {
  delete require.cache[require.resolve('../server')];
  const { injectPublicBaseUrl } = require('../server');
  const html = '<meta property="og:url" content="https://agent-arena-vert.vercel.app/play.html" />';
  const rewritten = injectPublicBaseUrl(html, 'https://arena.example.com');

  assert.equal(
    rewritten,
    '<meta property="og:url" content="https://arena.example.com/play.html" />',
  );
});

test('buildRuntimeConfigScript exposes the resolved public app url to the browser', () => {
  process.env.PUBLIC_APP_URL = 'https://arena.example.com/';
  delete require.cache[require.resolve('../server')];
  const { buildRuntimeConfigScript } = require('../server');

  const script = buildRuntimeConfigScript({
    protocol: 'http',
    get(header) {
      return header === 'host' ? '127.0.0.1:3000' : '';
    },
  });

  assert.match(script, /PUBLIC_APP_URL/);
  assert.match(script, /https:\/\/arena\.example\.com/);

  delete require.cache[require.resolve('../server')];
  delete process.env.PUBLIC_APP_URL;
});

test('production startup fails fast when PUBLIC_APP_URL is missing', () => {
  const repoRoot = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, ['-e', "require('./server')"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PUBLIC_APP_URL: '',
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PUBLIC_APP_URL is required/);
});

test('render blueprint targets the current free hosted service', () => {
  const renderYaml = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
  assert.match(renderYaml, /type:\s+web/);
  assert.match(renderYaml, /plan:\s+free/);
  assert.match(renderYaml, /key:\s+DATABASE_URL/);
  assert.doesNotMatch(renderYaml, /plan:\s+starter/);
});
