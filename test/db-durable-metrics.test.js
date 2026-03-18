const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

async function withTempDb(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-durable-metrics-'));
  const dbPath = path.join(dir, 'arena.db');

  delete process.env.DATABASE_URL;
  delete require.cache[require.resolve('../server/db')];
  const db = require('../server/db');
  await db.initDb(dbPath);

  try {
    await run(db);
  } finally {
    await db.closeDb();
    delete require.cache[require.resolve('../server/db')];
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('durable metric counters, snapshots, and KPI room events persist through the DB layer', async () => {
  await withTempDb(async (db) => {
    await db.incrementMetricCounter('funnel.visits', 1);
    await db.incrementMetricCounter('funnel.visits', 2);
    await db.incrementMetricCounter('referral.inviteSends', 3);

    const counters = await db.getMetricCounters(['funnel.visits', 'referral.inviteSends', 'funnel.quickJoinStarts']);
    assert.equal(counters['funnel.visits'], 3);
    assert.equal(counters['referral.inviteSends'], 3);
    assert.equal(counters['funnel.quickJoinStarts'], 0);

    await db.saveOpsSnapshot('growth_metrics_all_time', {
      updatedAt: new Date().toISOString(),
      funnel: { visits: 3 },
      referral: { inviteSends: 3 },
    });
    const snapshot = await db.getOpsSnapshot('growth_metrics_all_time');
    assert.equal(snapshot.name, 'growth_metrics_all_time');
    assert.equal(snapshot.payload.funnel.visits, 3);
    assert.equal(snapshot.payload.referral.inviteSends, 3);

    await db.recordKpiRoomEvent({ mode: 'mafia', roomId: 'room-a', type: 'ROOM_CREATED' });
    await db.recordKpiRoomEvent({ mode: 'mafia', roomId: 'room-a', type: 'ROOM_CREATED' });
    await db.recordKpiRoomEvent({ mode: 'mafia', roomId: 'room-a', type: 'GAME_STARTED' });

    const kpiEvents = await db.listKpiRoomEvents();
    assert.equal(kpiEvents.length, 2);
    assert.deepEqual(
      kpiEvents.map((event) => `${event.mode}:${event.roomId}:${event.type}`),
      ['mafia:ROOM-A:ROOM_CREATED', 'mafia:ROOM-A:GAME_STARTED'],
    );
  });
});
