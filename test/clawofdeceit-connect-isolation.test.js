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
  const stateDir = path.join(tmpRoot, 'state');
  const launchAgentsDir = path.join(tmpRoot, 'LaunchAgents');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(launchAgentsDir, { recursive: true });

  const previousEnv = {
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    CLAWOFDECEIT_LAUNCH_AGENTS_DIR: process.env.CLAWOFDECEIT_LAUNCH_AGENTS_DIR,
    CLAWOFDECEIT_SKIP_LAUNCHCTL: process.env.CLAWOFDECEIT_SKIP_LAUNCHCTL,
  };

  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.CLAWOFDECEIT_LAUNCH_AGENTS_DIR = launchAgentsDir;
  process.env.CLAWOFDECEIT_SKIP_LAUNCHCTL = '1';

  try {
    const connector = await loadConnectorTestApi();
    await run({
      tmpRoot,
      stateDir,
      launchAgentsDir,
      connector,
    });
  } finally {
    if (previousEnv.OPENCLAW_STATE_DIR == null) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousEnv.OPENCLAW_STATE_DIR;

    if (previousEnv.CLAWOFDECEIT_LAUNCH_AGENTS_DIR == null) delete process.env.CLAWOFDECEIT_LAUNCH_AGENTS_DIR;
    else process.env.CLAWOFDECEIT_LAUNCH_AGENTS_DIR = previousEnv.CLAWOFDECEIT_LAUNCH_AGENTS_DIR;

    if (previousEnv.CLAWOFDECEIT_SKIP_LAUNCHCTL == null) delete process.env.CLAWOFDECEIT_SKIP_LAUNCHCTL;
    else process.env.CLAWOFDECEIT_SKIP_LAUNCHCTL = previousEnv.CLAWOFDECEIT_SKIP_LAUNCHCTL;

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
    decisionCmd: 'node ./decision.js',
    autoStart: true,
    status: 'idle',
    createdAt: '2026-03-19T08:41:17.000Z',
    lastConnectedAt: null,
    ...overrides,
  };
}

test('connector defaults new registries and bindings to manual startup', { concurrency: false }, async () => {
  const connector = await loadConnectorTestApi();

  assert.equal(connector.defaultRegistry('https://arena.example').autoBoot, false);

  const binding = connector.normalizeSavedAgentBinding({
    agentId: 'agent-1',
    agentToken: 'runtime-secret',
    serverName: 'legacy-bot',
  });
  assert.ok(binding);
  assert.equal(binding.autoStart, false);
});

test('migrate-profile moves legacy main bindings into the dedicated profile and disables autostart ownership', { concurrency: false }, async () => {
  await withConnectorState(async ({ connector }) => {
    const sourceRegistryPath = connector.getRegistryPath(connector.LEGACY_MIGRATION_SOURCE_PROFILE);
    const sourceLaunchAgentPath = connector.getLaunchAgentPath(connector.LEGACY_MIGRATION_SOURCE_PROFILE);

    writeJson(sourceRegistryPath, {
      version: 2,
      apiBase: 'https://arena.example',
      defaultAgent: 'legacy',
      autoBoot: true,
      agents: {
        legacy: buildSavedBinding(),
      },
    });
    fs.mkdirSync(path.dirname(sourceLaunchAgentPath), { recursive: true });
    fs.writeFileSync(sourceLaunchAgentPath, '<plist />\n', 'utf8');

    const result = connector.migrateProfileBindings({
      fromProfileName: connector.LEGACY_MIGRATION_SOURCE_PROFILE,
      toProfileName: connector.ISOLATED_PROFILE_NAME,
      apiBase: 'https://arena.example',
    });

    assert.equal(result.movedBindings, 1);
    assert.match(result.note, /Migrated 1 saved Claw of Deceit agent binding/);
    assert.equal(fs.existsSync(sourceLaunchAgentPath), false);

    const sourceRegistry = connector.readBindingRegistry(connector.LEGACY_MIGRATION_SOURCE_PROFILE, 'https://arena.example');
    assert.equal(sourceRegistry.autoBoot, false);
    assert.deepEqual(sourceRegistry.agents, {});
    assert.equal(sourceRegistry.defaultAgent, null);

    const targetRegistry = connector.readBindingRegistry(connector.ISOLATED_PROFILE_NAME, 'https://arena.example');
    assert.equal(targetRegistry.autoBoot, false);
    assert.equal(targetRegistry.defaultAgent, 'legacy');
    assert.equal(targetRegistry.agents.legacy.autoStart, false);
    assert.equal(targetRegistry.agents.legacy.agentId, 'agent-1');
  });
});

test('migrate-profile is a no-op when legacy main has nothing left to migrate', { concurrency: false }, async () => {
  await withConnectorState(async ({ connector }) => {
    const targetRegistryPath = connector.getRegistryPath(connector.ISOLATED_PROFILE_NAME);
    writeJson(targetRegistryPath, {
      version: 2,
      apiBase: 'https://arena.example',
      defaultAgent: 'existing',
      autoBoot: false,
      agents: {
        existing: buildSavedBinding({
          agentId: 'agent-2',
          serverName: 'existing-bot',
          autoStart: false,
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
      autoBoot: false,
      agents: {
        legacy: buildSavedBinding(),
      },
    });
    writeJson(connector.getRegistryPath(connector.ISOLATED_PROFILE_NAME), {
      version: 2,
      apiBase: 'https://arena.example',
      defaultAgent: 'isolated',
      autoBoot: false,
      agents: {
        isolated: buildSavedBinding({
          agentId: 'agent-2',
          serverName: 'isolated-bot',
          autoStart: false,
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
      autoStart: false,
    }),
    apiBase: 'https://arena.example',
    webBase: 'https://arena.example',
    autoBootNote: 'This agent is saved as manual-start only.',
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
  assert.equal(managedHostCalls[0].entries[0][1].autoStart, false);
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
