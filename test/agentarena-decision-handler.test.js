const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const handlerPath = path.join(__dirname, '..', 'examples', 'agentarena-decision-handler', 'index.js');

function runHandler(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [handlerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `handler exited ${code}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test('starter decision handler returns ready for discussion', async () => {
  const result = await runHandler({
    kind: 'discussion_request',
    roomId: 'ROOM1',
    playerId: 'P1',
    phase: 'discussion',
    day: 1,
    players: [],
    agent: { agentId: 'A1', agentName: 'Donna', style: 'witty', intensity: 7 },
  });
  assert.deepEqual(result, { type: 'ready' });
});

test('starter decision handler returns a target for vote requests', async () => {
  const result = await runHandler({
    kind: 'vote_request',
    roomId: 'ROOM1',
    playerId: 'P1',
    phase: 'voting',
    day: 1,
    players: [
      { id: 'P1', name: 'Donna', isSelf: true, alive: true },
      { id: 'P2', name: 'Echo', isSelf: false, alive: true },
    ],
    agent: { agentId: 'A1', agentName: 'Donna', style: 'witty', intensity: 7 },
  });
  assert.deepEqual(result, { type: 'vote', targetId: 'P2' });
});
