const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

function createRoomEventLog(options = {}) {
  const maxPerRoom = Number(options.maxPerRoom || 1000);
  const dataDir = options.dataDir || path.join(process.cwd(), 'data');
  const file = options.file || path.join(dataDir, 'room-events.ndjson');
  const flushIntervalMs = Math.max(50, Number(options.flushIntervalMs || 250));
  const byRoom = new Map();

  let queue = [];
  let flushTimer = null;
  let flushing = null;

  function key(mode, roomId) {
    return `${mode}:${String(roomId || '').toUpperCase()}`;
  }

  function ensureFlushScheduled() {
    if (flushTimer || flushing) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushIntervalMs);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  async function flush() {
    if (flushing) return flushing;
    if (!queue.length) return null;

    const batch = queue;
    queue = [];

    flushing = (async () => {
      try {
        await fs.mkdir(dataDir, { recursive: true });
        const payload = batch.map((event) => `${JSON.stringify(event)}\n`).join('');
        await fs.appendFile(file, payload, 'utf8');
      } catch (err) {
        // best effort logging only; restore batch to avoid data loss if write fails
        queue = batch.concat(queue);
      } finally {
        flushing = null;
        if (queue.length) ensureFlushScheduled();
      }
    })();

    return flushing;
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

    queue.push(event);
    ensureFlushScheduled();
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

  async function close() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flush();
    if (flushing) await flushing;
  }

  function pendingByMode() {
    const byMode = {};
    for (const event of queue) {
      const mode = event.mode || 'unknown';
      byMode[mode] = (byMode[mode] || 0) + 1;
    }
    return byMode;
  }

  return {
    append,
    list,
    replay,
    flush,
    close,
    pending() {
      return queue.length;
    },
    pendingByMode,
    clear() {
      byRoom.clear();
      queue = [];
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    },
  };
}

module.exports = {
  createRoomEventLog,
};
