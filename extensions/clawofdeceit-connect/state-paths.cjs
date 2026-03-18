const os = require('node:os');
const path = require('node:path');

function trimEnv(value) {
  return String(value || '').trim();
}

function resolveMaybeHome(target, homeDir) {
  const value = trimEnv(target);
  if (!value) return '';
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return path.resolve(value);
}

function resolveOpenClawStateDir(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const stateDir = resolveMaybeHome(env.OPENCLAW_STATE_DIR, homeDir);
  if (stateDir) return stateDir;

  const configPath = resolveMaybeHome(env.OPENCLAW_CONFIG_PATH, homeDir);
  if (configPath) return path.dirname(configPath);

  return path.join(homeDir, '.openclaw');
}

function resolveOpenClawConfigPath(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const configPath = resolveMaybeHome(env.OPENCLAW_CONFIG_PATH, homeDir);
  if (configPath) return configPath;
  return path.join(resolveOpenClawStateDir({ env, homeDir }), 'openclaw.json');
}

function resolveOpenClawProfilePath(fileName, options = {}) {
  return path.join(resolveOpenClawStateDir(options), String(fileName || '').trim());
}

module.exports = {
  resolveOpenClawConfigPath,
  resolveOpenClawProfilePath,
  resolveOpenClawStateDir,
};
