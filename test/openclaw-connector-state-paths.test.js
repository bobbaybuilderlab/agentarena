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

  assert.equal(
    resolveOpenClawStateDir({ homeDir }),
    path.join(homeDir, '.openclaw'),
  );
  assert.equal(
    resolveOpenClawConfigPath({ homeDir }),
    path.join(homeDir, '.openclaw', 'openclaw.json'),
  );
  assert.equal(
    resolveOpenClawProfilePath('CLAWOFDECEIT.md', { homeDir }),
    path.join(homeDir, '.openclaw', 'CLAWOFDECEIT.md'),
  );
});

test('connector state paths stay in the standard local openclaw layout', () => {
  const homeDir = '/Users/example';

  assert.equal(
    resolveOpenClawStateDir({ homeDir }),
    path.join(homeDir, '.openclaw'),
  );
  assert.equal(
    resolveOpenClawConfigPath({ homeDir }),
    path.join(homeDir, '.openclaw', 'openclaw.json'),
  );
  assert.equal(
    resolveOpenClawProfilePath('AGENTARENA.md', { homeDir }),
    path.join(homeDir, '.openclaw', 'AGENTARENA.md'),
  );
});
