const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  resolveOpenClawConfigPath,
  resolveOpenClawProfilePath,
  resolveOpenClawStateDir,
} = require('../extensions/clawofdeceit-connect/state-paths.cjs');

test('connector state paths default to the standard openclaw home', () => {
  const homeDir = '/Users/example';
  const env = {};

  assert.equal(
    resolveOpenClawStateDir({ env, homeDir }),
    path.join(homeDir, '.openclaw'),
  );
  assert.equal(
    resolveOpenClawConfigPath({ env, homeDir }),
    path.join(homeDir, '.openclaw', 'openclaw.json'),
  );
  assert.equal(
    resolveOpenClawProfilePath('CLAWOFDECEIT.md', { env, homeDir }),
    path.join(homeDir, '.openclaw', 'CLAWOFDECEIT.md'),
  );
});

test('connector state paths prefer OPENCLAW_STATE_DIR when present', () => {
  const homeDir = '/Users/example';
  const env = {
    OPENCLAW_STATE_DIR: '~/custom-main',
  };

  assert.equal(
    resolveOpenClawStateDir({ env, homeDir }),
    path.join(homeDir, 'custom-main'),
  );
  assert.equal(
    resolveOpenClawConfigPath({ env, homeDir }),
    path.join(homeDir, 'custom-main', 'openclaw.json'),
  );
  assert.equal(
    resolveOpenClawProfilePath('CLAWOFDECEIT.md', { env, homeDir }),
    path.join(homeDir, 'custom-main', 'CLAWOFDECEIT.md'),
  );
});

test('connector state paths derive the state dir from OPENCLAW_CONFIG_PATH when needed', () => {
  const homeDir = '/Users/example';
  const env = {
    OPENCLAW_CONFIG_PATH: '~/profiles/founder/openclaw.json',
  };

  assert.equal(
    resolveOpenClawStateDir({ env, homeDir }),
    path.join(homeDir, 'profiles', 'founder'),
  );
  assert.equal(
    resolveOpenClawConfigPath({ env, homeDir }),
    path.join(homeDir, 'profiles', 'founder', 'openclaw.json'),
  );
  assert.equal(
    resolveOpenClawProfilePath('AGENTARENA.md', { env, homeDir }),
    path.join(homeDir, 'profiles', 'founder', 'AGENTARENA.md'),
  );
});
