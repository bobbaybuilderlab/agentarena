const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const connectorModuleUrl = pathToFileURL(
  path.join(__dirname, '..', 'extensions', 'clawofdeceit-connect', 'index.ts'),
).href;

async function loadConnectorTestApi() {
  const mod = await import(connectorModuleUrl);
  return mod.__test__;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function withConnectorState(run) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawofdeceit-isolation-'));
  const stateDir = path.join(tmpRoot, '.openclaw');
  fs.mkdirSync(stateDir, { recursive: true });

  const previousEnv = {
    HOME: process.env.HOME,
  };

  process.env.HOME = tmpRoot;

  try {
    const connector = await loadConnectorTestApi();
    await run({
      tmpRoot,
      stateDir,
      connector,
    });
  } finally {
    if (previousEnv.HOME == null) delete process.env.HOME;
    else process.env.HOME = previousEnv.HOME;

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function buildSavedBinding(overrides = {}) {
  return {
    agentId: 'agent-1',
    agentToken: 'runtime-secret',
    serverName: 'legacy-bot',
    presetId: 'pragmatic',
    style: 'pragmatic operator',
    status: 'idle',
    createdAt: '2026-03-19T08:41:17.000Z',
    lastConnectedAt: null,
    ...overrides,
  };
}

test('connector defaults new registries and bindings to manual startup', { concurrency: false }, async () => {
  const connector = await loadConnectorTestApi();

  assert.equal(connector.defaultRegistry('https://arena.example').defaultAgent, null);

  const binding = connector.normalizeSavedAgentBinding({
    agentId: 'agent-1',
    agentToken: 'runtime-secret',
    serverName: 'legacy-bot',
    autoStart: true,
    decisionCmd: 'node ./decision.js',
  });
  assert.ok(binding);
  assert.equal('autoStart' in binding, false);
  assert.equal('decisionCmd' in binding, false);
});

test('migrate-profile moves legacy main bindings into the dedicated profile and drops legacy automation fields', { concurrency: false }, async () => {
  await withConnectorState(async ({ connector }) => {
    const sourceRegistryPath = connector.getRegistryPath(connector.LEGACY_MIGRATION_SOURCE_PROFILE);

    writeJson(sourceRegistryPath, {
      version: 2,
      apiBase: 'https://arena.example',
      defaultAgent: 'legacy',
      agents: {
        legacy: buildSavedBinding(),
      },
    });

    const result = connector.migrateProfileBindings({
      fromProfileName: connector.LEGACY_MIGRATION_SOURCE_PROFILE,
      toProfileName: connector.ISOLATED_PROFILE_NAME,
      apiBase: 'https://arena.example',
    });

    assert.equal(result.movedBindings, 1);
    assert.match(result.note, /Migrated 1 saved Claw of Deceit agent binding/);

    const sourceRegistry = connector.readBindingRegistry(connector.LEGACY_MIGRATION_SOURCE_PROFILE, 'https://arena.example');
    assert.deepEqual(sourceRegistry.agents, {});
    assert.equal(sourceRegistry.defaultAgent, null);

    const targetRegistry = connector.readBindingRegistry(connector.ISOLATED_PROFILE_NAME, 'https://arena.example');
    assert.equal(targetRegistry.defaultAgent, 'legacy');
    assert.equal(targetRegistry.agents.legacy.agentId, 'agent-1');
    assert.equal('autoStart' in targetRegistry.agents.legacy, false);
    assert.equal('decisionCmd' in targetRegistry.agents.legacy, false);
  });
});

test('migrate-profile is a no-op when legacy main has nothing left to migrate', { concurrency: false }, async () => {
  await withConnectorState(async ({ connector }) => {
    const targetRegistryPath = connector.getRegistryPath(connector.ISOLATED_PROFILE_NAME);
    writeJson(targetRegistryPath, {
      version: 2,
      apiBase: 'https://arena.example',
      defaultAgent: 'existing',
      agents: {
        existing: buildSavedBinding({
          agentId: 'agent-2',
          serverName: 'existing-bot',
        }),
      },
    });

    const result = connector.migrateProfileBindings({
      fromProfileName: connector.LEGACY_MIGRATION_SOURCE_PROFILE,
      toProfileName: connector.ISOLATED_PROFILE_NAME,
      apiBase: 'https://arena.example',
    });

    assert.equal(result.movedBindings, 0);
    assert.match(result.note, /Nothing to migrate from profile main/);

    const targetRegistry = connector.readBindingRegistry(connector.ISOLATED_PROFILE_NAME, 'https://arena.example');
    assert.equal(targetRegistry.defaultAgent, 'existing');
    assert.equal(Object.keys(targetRegistry.agents).length, 1);
  });
});

test('migrate-profile rejects conflicting source and target bindings', { concurrency: false }, async () => {
  await withConnectorState(async ({ connector }) => {
    writeJson(connector.getRegistryPath(connector.LEGACY_MIGRATION_SOURCE_PROFILE), {
      version: 2,
      apiBase: 'https://arena.example',
      defaultAgent: 'legacy',
      agents: {
        legacy: buildSavedBinding(),
      },
    });
    writeJson(connector.getRegistryPath(connector.ISOLATED_PROFILE_NAME), {
      version: 2,
      apiBase: 'https://arena.example',
      defaultAgent: 'isolated',
      agents: {
        isolated: buildSavedBinding({
          agentId: 'agent-2',
          serverName: 'isolated-bot',
        }),
      },
    });

    assert.throws(() => connector.migrateProfileBindings({
      fromProfileName: connector.LEGACY_MIGRATION_SOURCE_PROFILE,
      toProfileName: connector.ISOLATED_PROFILE_NAME,
      apiBase: 'https://arena.example',
    }), /already contain saved Claw of Deceit bindings/);
  });
});

test('connect still starts the saved binding live immediately even when future startup stays manual', { concurrency: false }, async () => {
  const connector = await loadConnectorTestApi();
  const saved = {
    profileName: connector.ISOLATED_PROFILE_NAME,
    localName: 'fresh-bot',
    binding: buildSavedBinding({
      agentId: 'agent-3',
      serverName: 'fresh-bot',
    }),
    apiBase: 'https://arena.example',
    webBase: 'https://arena.example',
    startupNote: 'List saved agents with `openclaw --profile clawofdeceit clawofdeceit agents list`, then bring this one back with `openclaw --profile clawofdeceit clawofdeceit agents start fresh-bot`.',
  };

  const managedHostCalls = [];
  const logs = [];

  const startResult = await connector.keepBindingLiveAfterConnect(saved, {
    readActiveHostLock: () => null,
    runManagedHost: async (args) => {
      managedHostCalls.push(args);
    },
    log: (message) => {
      logs.push(message);
    },
  });

  assert.deepEqual(startResult, { started: true, activePid: null });
  assert.equal(managedHostCalls.length, 1);
  assert.equal(managedHostCalls[0].entries[0][0], 'fresh-bot');
  assert.equal('autoStart' in managedHostCalls[0].entries[0][1], false);
  assert.deepEqual(logs, []);

  const blockedLogs = [];
  const blockedResult = await connector.keepBindingLiveAfterConnect(saved, {
    readActiveHostLock: () => 4321,
    runManagedHost: async () => {
      throw new Error('runManagedHost should not be called when a host is already active');
    },
    log: (message) => {
      blockedLogs.push(message);
    },
  });

  assert.deepEqual(blockedResult, { started: false, activePid: 4321 });
  assert.match(blockedLogs[1], /agents start fresh-bot/);
  assert.doesNotMatch(blockedLogs[1], /agents start --all/);
});

test('connector surfaces owner live-agent cap failures with rotation guidance', async () => {
  const connector = await loadConnectorTestApi();
  const lines = connector.describeRuntimeRegistrationFailure({
    profileName: 'clawofdeceit',
    localName: 'fresh-bot',
    error: {
      code: 'OWNER_CONNECTED_AGENT_LIMIT_REACHED',
      message: 'Only one of your agents can be online at a time. Disconnect or archive the active agent before starting another.',
      activeAgentId: 'agent-1',
      activeAgentName: 'legacy-bot',
      limit: 1,
    },
  });

  assert.equal(lines.length, 3);
  assert.match(lines[0], /saved binding is ready, but it cannot come online yet while legacy-bot is already online/);
  assert.match(lines[1], /Only one Claw of Deceit agent per owner can be online at a time/);
  assert.match(lines[2], /agents start fresh-bot/);
  assert.doesNotMatch(lines.join('\n'), /agents start --all/);
});
