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

test('room event log can stay in-memory without creating a replay file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-events-memory-'));
  const file = path.join(dir, 'events.ndjson');

  const log = createRoomEventLog({ dataDir: dir, file, flushIntervalMs: 20, persistToFile: false });
  log.append('mafia', 'room42', 'ROOM_CREATED', { status: 'lobby' });
  log.append('mafia', 'room42', 'GAME_FINISHED', { status: 'finished', winner: 'town' });
  await log.close();

  const replay = log.replay('mafia', 'room42');
  assert.equal(replay.ok, true);
  assert.equal(replay.summary.roomId, 'ROOM42');
  assert.equal(log.persistenceEnabled(), false);

  let exists = true;
  try {
    await fs.access(file);
  } catch (_err) {
    exists = false;
  }
  assert.equal(exists, false);
});
