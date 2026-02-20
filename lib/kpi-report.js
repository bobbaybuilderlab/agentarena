const fs = require('fs');

const PLAY_MODES = ['mafia', 'amongus', 'villa'];

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toRate(numerator, denominator, digits = 3) {
  const den = Math.max(0, safeNumber(denominator));
  if (!den) return 0;
  return Number((safeNumber(numerator) / den).toFixed(digits));
}

function loadEvents(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function createModeRow() {
  return {
    created: 0,
    joined: 0,
    started: 0,
    joinedThenStarted: 0,
    rematchStarted: 0,
    startReady: 0,
    autofilled: 0,
  };
}

function buildKpiReport({ events = [], playRoomTelemetry = new Map() } = {}) {
  const roomBuckets = new Map();

  for (const event of events) {
    const mode = String(event.mode || '').toLowerCase();
    const roomId = String(event.roomId || '').toUpperCase();
    if (!mode || !roomId) continue;
    const key = `${mode}:${roomId}`;
    if (!roomBuckets.has(key)) roomBuckets.set(key, { mode, roomId, events: [] });
    roomBuckets.get(key).events.push(event);
  }

  const perMode = Object.fromEntries(PLAY_MODES.map((mode) => [mode, createModeRow()]));

  for (const bucket of roomBuckets.values()) {
    if (!PLAY_MODES.includes(bucket.mode)) continue;
    const row = perMode[bucket.mode];
    const types = new Set(bucket.events.map((e) => e.type));
    const hasCreated = types.has('ROOM_CREATED');
    const hasJoined = types.has('PLAYER_JOINED');
    const hasStarted = types.has('GAME_STARTED');

    if (hasCreated) row.created += 1;
    if (hasJoined) row.joined += 1;
    if (hasStarted) row.started += 1;
    if (hasJoined && hasStarted) row.joinedThenStarted += 1;
    if (types.has('REMATCH_STARTED')) row.rematchStarted += 1;
    if (types.has('LOBBY_START_READY')) row.startReady += 1;
    if (types.has('LOBBY_AUTOFILLED')) row.autofilled += 1;
  }

  const reconnect = {
    attempts: 0,
    successes: 0,
    failures: 0,
    reclaim_clicked: 0,
    quick_recover_clicked: 0,
  };
  const rematch = { clicked: 0, partyStreakExtended: 0 };
  const quickJoin = { tickets: 0, conversions: 0 };
  const fairness = {
    joinAttempts: 0,
    socketSeatCapBlocked: 0,
    byMode: Object.fromEntries(PLAY_MODES.map((mode) => [mode, { joinAttempts: 0, socketSeatCapBlocked: 0 }])),
  };

  for (const telemetry of playRoomTelemetry.values()) {
    const mode = PLAY_MODES.includes(String(telemetry.mode || '').toLowerCase())
      ? String(telemetry.mode || '').toLowerCase()
      : null;

    reconnect.attempts += safeNumber(telemetry.reconnectAutoAttempts);
    reconnect.successes += safeNumber(telemetry.reconnectAutoSuccesses);
    reconnect.failures += safeNumber(telemetry.reconnectAutoFailures);
    reconnect.reclaim_clicked += safeNumber(telemetry.reclaimClicked);
    reconnect.quick_recover_clicked += safeNumber(telemetry.quickRecoverClicked);
    rematch.clicked += safeNumber(telemetry.telemetryEvents?.rematch_clicked || telemetry.rematchCount);
    rematch.partyStreakExtended += safeNumber(telemetry.telemetryEvents?.party_streak_extended || telemetry.partyStreakExtended);
    quickJoin.tickets += safeNumber(telemetry.quickMatchTickets);
    quickJoin.conversions += safeNumber(telemetry.quickMatchConversions);

    fairness.joinAttempts += safeNumber(telemetry.joinAttempts);
    fairness.socketSeatCapBlocked += safeNumber(telemetry.socketSeatCapBlocked);

    if (mode) {
      fairness.byMode[mode].joinAttempts += safeNumber(telemetry.joinAttempts);
      fairness.byMode[mode].socketSeatCapBlocked += safeNumber(telemetry.socketSeatCapBlocked);
    }
  }

  for (const mode of PLAY_MODES) {
    fairness.byMode[mode].socketSeatCapBlockRate = toRate(
      fairness.byMode[mode].socketSeatCapBlocked,
      fairness.byMode[mode].joinAttempts,
    );
  }

  fairness.socketSeatCapBlockRate = toRate(fairness.socketSeatCapBlocked, fairness.joinAttempts);

  const created = PLAY_MODES.reduce((sum, mode) => sum + perMode[mode].created, 0);
  const started = PLAY_MODES.reduce((sum, mode) => sum + perMode[mode].started, 0);
  const activationJoined = PLAY_MODES.reduce((sum, mode) => sum + perMode[mode].joined, 0);
  const joinedThenStarted = PLAY_MODES.reduce((sum, mode) => sum + perMode[mode].joinedThenStarted, 0);

  return {
    updatedAt: new Date().toISOString(),
    sample: {
      roomsObserved: roomBuckets.size,
      eventsObserved: events.length,
      telemetryRoomsObserved: playRoomTelemetry.size,
    },
    funnel: {
      created,
      activationJoined,
      started,
      joinedThenStarted,
      activationRate: toRate(activationJoined, created),
      roomStartRate: toRate(started, created),
      joinToStartRate: toRate(joinedThenStarted, activationJoined),
    },
    reconnect: {
      ...reconnect,
      successRate: toRate(reconnect.successes, reconnect.attempts),
    },
    rematch: {
      ...rematch,
      rematchRate: toRate(rematch.clicked, started),
      retentionProxy: toRate(rematch.partyStreakExtended, started),
    },
    quickJoin: {
      ...quickJoin,
      conversionRate: toRate(quickJoin.conversions, quickJoin.tickets),
    },
    fairness,
    byMode: Object.fromEntries(PLAY_MODES.map((mode) => [
      mode,
      {
        ...perMode[mode],
        activationRate: toRate(perMode[mode].joined, perMode[mode].created),
        roomStartRate: toRate(perMode[mode].started, perMode[mode].created),
        joinToStartRate: toRate(perMode[mode].joinedThenStarted, perMode[mode].joined),
        rematchRate: toRate(perMode[mode].rematchStarted, perMode[mode].started),
      },
    ])),
  };
}

module.exports = {
  loadEvents,
  buildKpiReport,
};
