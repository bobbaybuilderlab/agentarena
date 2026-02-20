const test = require('node:test');
const assert = require('node:assert/strict');

const {
  server,
  roomEvents,
  clearAllGameTimers,
  resetPlayTelemetry,
  seedPlayTelemetry,
} = require('../server');

async function withServer(fn) {
  roomEvents.clear();
  resetPlayTelemetry();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  try {
    await fn(url);
  } finally {
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('ops kpi endpoint returns activation/start/reconnect/rematch metrics', async () => {
  await withServer(async (url) => {
    roomEvents.append('mafia', 'ROOMA1', 'ROOM_CREATED', { status: 'lobby' });
    roomEvents.append('mafia', 'ROOMA1', 'PLAYER_JOINED', { status: 'lobby' });
    roomEvents.append('mafia', 'ROOMA1', 'GAME_STARTED', { status: 'in_progress' });
    roomEvents.append('amongus', 'ROOMB1', 'ROOM_CREATED', { status: 'lobby' });

    seedPlayTelemetry('mafia', 'ROOMA1', {
      quickMatchTickets: 4,
      quickMatchConversions: 2,
      reconnectAutoAttempts: 5,
      reconnectAutoSuccesses: 3,
      reconnectAutoFailures: 2,
      rematchCount: 1,
      telemetryEvents: { rematch_clicked: 1, party_streak_extended: 1 },
      joinAttempts: 6,
      socketSeatCapBlocked: 2,
    });
    seedPlayTelemetry('villa', 'ROOMV1', {
      joinAttempts: 4,
      socketSeatCapBlocked: 1,
    });

    await roomEvents.flush();

    const kpiRes = await fetch(`${url}/api/ops/kpis`);
    const kpi = await kpiRes.json();

    assert.equal(kpi.ok, true);
    assert.equal(kpi.funnel.created >= 2, true);
    assert.equal(kpi.funnel.started >= 1, true);
    assert.equal(kpi.reconnect.attempts, 5);
    assert.equal(kpi.reconnect.successes, 3);
    assert.equal(kpi.quickJoin.tickets, 4);
    assert.equal(kpi.quickJoin.conversions, 2);
    assert.equal(kpi.fairness.joinAttempts, 10);
    assert.equal(kpi.fairness.socketSeatCapBlocked, 3);
    assert.equal(kpi.fairness.byMode.villa.socketSeatCapBlocked, 1);

    const refreshRes = await fetch(`${url}/api/ops/kpis/refresh`, { method: 'POST' });
    const refresh = await refreshRes.json();
    assert.equal(refresh.ok, true);
    assert.equal(typeof refresh.metrics.kpi.roomStartRate, 'number');
    assert.equal(typeof refresh.metrics.kpi.fairnessSocketSeatCapBlockRate, 'number');
  });
});
