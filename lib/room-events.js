const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createRoomEventLog(options = {}) {
  const maxPerRoom = Number(options.maxPerRoom || 1000);
  const dataDir = options.dataDir || path.join(process.cwd(), 'data');
  const file = options.file || path.join(dataDir, 'room-events.ndjson');
  const byRoom = new Map();

  function key(mode, roomId) {
    return `${mode}:${String(roomId || '').toUpperCase()}`;
  }

  function append(mode, roomId, type, payload = {}) {
    if (!mode || !roomId || !type) return null;
    const event = {
      id: randomUUID(),
      at: Date.now(),
      mode,
      roomId: String(roomId).toUpperCase(),
      type,
      ...payload,
    };

    const roomKey = key(mode, roomId);
    let list = byRoom.get(roomKey);
    if (!list) {
      list = [];
      byRoom.set(roomKey, list);
    }
    list.push(event);
    if (list.length > maxPerRoom) list.splice(0, list.length - maxPerRoom);

    try {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
    } catch (err) {
      // best effort logging only
    }

    return event;
  }

  function list(mode, roomId, limit = maxPerRoom) {
    const events = byRoom.get(key(mode, roomId)) || [];
    const safeLimit = Math.max(1, Math.min(maxPerRoom, Number(limit) || maxPerRoom));
    return events.slice(-safeLimit);
  }

  function replay(mode, roomId) {
    const events = list(mode, roomId, maxPerRoom);
    const state = {
      mode,
      roomId: String(roomId || '').toUpperCase(),
      createdAt: null,
      finishedAt: null,
      status: null,
      phase: null,
      winner: null,
      roundsPlayed: 0,
      events: events.length,
    };

    for (const event of events) {
      if (!state.createdAt) state.createdAt = event.at;
      if (event.status) state.status = event.status;
      if (event.phase) state.phase = event.phase;
      if (typeof event.round === 'number') state.roundsPlayed = Math.max(state.roundsPlayed, event.round);
      if (event.winner) state.winner = event.winner;
      if (event.type === 'BATTLE_FINISHED' || event.status === 'finished') state.finishedAt = event.at;
    }

    return {
      ok: events.length > 0,
      state,
      timeline: events,
    };
  }

  return {
    append,
    list,
    replay,
    clear() {
      byRoom.clear();
    },
  };
}

module.exports = {
  createRoomEventLog,
};
