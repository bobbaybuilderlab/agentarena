const os = require('node:os');
const path = require('node:path');

function resolveOpenClawStateDir(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  return path.join(homeDir, '.openclaw');
}

function resolveOpenClawConfigPath(options = {}) {
  return path.join(resolveOpenClawStateDir(options), 'openclaw.json');
}

function resolveOpenClawProfilePath(fileName, options = {}) {
  return path.join(resolveOpenClawStateDir(options), String(fileName || '').trim());
}

module.exports = {
  resolveOpenClawConfigPath,
  resolveOpenClawProfilePath,
  resolveOpenClawStateDir,
};
