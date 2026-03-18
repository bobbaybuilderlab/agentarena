const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function runProductionStartup(env = {}) {
  const repoRoot = path.join(__dirname, '..');
  return spawnSync(process.execPath, ['-e', "require('./server')"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PUBLIC_APP_URL: 'https://arena.example.com',
      DATABASE_URL: 'postgres://user:pass@db.example.com:5432/arena',
      RESEND_API_KEY: 're_test_key',
      MAGIC_LINK_FROM: 'Claw of Deceit <login@arena.example.com>',
      ...env,
    },
    encoding: 'utf8',
  });
}

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

test('production defaults disable public replay routes and file persistence', () => {
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_APP_URL = 'https://arena.example.com';
  process.env.DATABASE_URL = 'postgres://user:pass@db.example.com:5432/arena';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.MAGIC_LINK_FROM = 'Claw of Deceit <login@arena.example.com>';
  delete process.env.PUBLIC_ROOM_EVENT_ROUTES;
  delete process.env.ROOM_EVENT_FILE_PERSISTENCE;
  delete require.cache[require.resolve('../server')];
  const {
    PUBLIC_ROOM_EVENT_ROUTES_ENABLED,
    ROOM_EVENT_FILE_PERSISTENCE_ENABLED,
  } = require('../server');

  assert.equal(PUBLIC_ROOM_EVENT_ROUTES_ENABLED, false);
  assert.equal(ROOM_EVENT_FILE_PERSISTENCE_ENABLED, false);

  delete require.cache[require.resolve('../server')];
  delete process.env.NODE_ENV;
  delete process.env.PUBLIC_APP_URL;
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.MAGIC_LINK_FROM;
});

test('production startup fails fast when PUBLIC_APP_URL is missing', () => {
  const result = runProductionStartup({ PUBLIC_APP_URL: '' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PUBLIC_APP_URL is required/);
});

test('production startup fails fast when DATABASE_URL is missing', () => {
  const result = runProductionStartup({ DATABASE_URL: '' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL is required/);
});

test('production startup fails fast when RESEND_API_KEY is missing', () => {
  const result = runProductionStartup({ RESEND_API_KEY: '' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RESEND_API_KEY is required/);
});

test('production startup fails fast when MAGIC_LINK_FROM is missing', () => {
  const result = runProductionStartup({ MAGIC_LINK_FROM: '' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MAGIC_LINK_FROM is required/);
});

test('render blueprint targets the starter production service contract', () => {
  const renderYaml = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
  assert.match(renderYaml, /type:\s+web/);
  assert.match(renderYaml, /plan:\s+starter/);
  assert.match(renderYaml, /key:\s+DATABASE_URL/);
  assert.match(renderYaml, /key:\s+RESEND_API_KEY/);
  assert.match(renderYaml, /key:\s+MAGIC_LINK_FROM/);
  assert.doesNotMatch(renderYaml, /plan:\s+free/);
});

test('connector docs only describe the reduced install, profile, and connect flow', () => {
  const connectorReadme = fs.readFileSync(
    path.join(__dirname, '..', 'extensions', 'clawofdeceit-connect', 'README.md'),
    'utf8',
  );
  assert.match(connectorReadme, /openclaw clawofdeceit init-profile/);
  assert.match(connectorReadme, /openclaw clawofdeceit connect --api https:\/\/<claw-of-deceit-host>/);
  assert.doesNotMatch(connectorReadme, /auth --owner-token/);
  assert.doesNotMatch(connectorReadme, /sync-style/);
});
