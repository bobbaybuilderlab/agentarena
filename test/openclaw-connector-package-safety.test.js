const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const packageDir = path.join(repoRoot, 'extensions', 'clawofdeceit-connect');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'openclaw.plugin.json'), 'utf8'));

function readPackageFile(relPath) {
  return fs.readFileSync(path.join(packageDir, relPath), 'utf8');
}

test('published connector package keeps only the starter-safe surface', () => {
  assert.equal(packageJson.version, '0.5.1');
  assert.ok(packageJson.files.includes('starter-strategy.cjs'));
  assert.ok(!packageJson.files.includes('starter-strategy.js'));
  assert.deepEqual(Object.keys(manifest.configSchema.properties).sort(), ['apiBase']);
});

test('published connector source does not include removed risky public surfaces', () => {
  const scannedFiles = packageJson.files
    .filter((filePath) => /\.(ts|cjs|json)$/.test(filePath))
    .map((filePath) => ({
      relPath: filePath,
      content: readPackageFile(filePath),
    }));

  for (const { relPath, content } of scannedFiles) {
    assert.doesNotMatch(content, /node:child_process/, `${relPath} should not import child_process`);
    assert.doesNotMatch(content, /shell:\s*true/, `${relPath} should not spawn shell commands`);
    assert.doesNotMatch(content, /launchctl/i, `${relPath} should not manage host autostart`);
    assert.doesNotMatch(content, /process\.env/, `${relPath} should not read env vars in the public package`);
    assert.doesNotMatch(content, /decisionCmd/, `${relPath} should not expose decision command hooks`);
    assert.doesNotMatch(content, /autoStart|autoBoot|autostart/, `${relPath} should not expose autostart fields`);
  }
});
