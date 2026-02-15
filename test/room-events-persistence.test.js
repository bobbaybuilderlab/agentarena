const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createRoomEventLog } = require('../lib/room-events');

test('room event log writes NDJSON in async batches and stays parseable across reopen', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-events-'));
  const file = path.join(dir, 'events.ndjson');

  const logA = createRoomEventLog({ dataDir: dir, file, flushIntervalMs: 80 });
  logA.append('arena', 'abc123', 'ROOM_CREATED', { status: 'lobby' });
  logA.append('arena', 'abc123', 'ROUND_STARTED', { round: 1, status: 'round' });
  await logA.close();

  const logB = createRoomEventLog({ dataDir: dir, file, flushIntervalMs: 80 });
  logB.append('arena', 'abc123', 'BATTLE_FINISHED', { status: 'finished', round: 1 });
  await logB.close();

  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  const parsed = lines.map((line) => JSON.parse(line));

  assert.equal(parsed.length, 3);
  assert.ok(parsed.every((event) => event.id && event.at && event.mode && event.roomId && event.type));
  assert.deepEqual(parsed.map((event) => event.type), ['ROOM_CREATED', 'ROUND_STARTED', 'BATTLE_FINISHED']);
});
