const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

function toTimestamp(value) {
  const timestamp = typeof value === 'number' ? value : new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatClock(value) {
  const timestamp = toTimestamp(value);
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDurationMs(value) {
  const durationMs = Math.max(0, Number(value) || 0);
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 10000) {
    const seconds = durationMs / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  const totalSec = Math.round(durationMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function titleCase(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  return `${clean.charAt(0).toUpperCase()}${clean.slice(1)}`;
}

function buildReplayTimelineItem(event) {
  if (!event?.type) return null;
  const at = toTimestamp(event.at);
  const targetName = event.targetName || event.targetId || 'Unknown';
  const forfeitedName = event.targetName || event.playerName || event.playerId || 'Unknown';
  const actorName = event.actorName || event.actorId || 'Unknown agent';

  if (event.type === 'ROOM_CREATED') {
    return {
      id: event.id,
      type: event.type,
      kind: 'setup',
      at,
      atLabel: formatClock(at),
      title: 'Room opened',
      body: 'The table was created and started waiting for seats.',
    };
  }

  if (event.type === 'PLAYER_JOINED') {
    return {
      id: event.id,
      type: event.type,
      kind: 'setup',
      at,
      atLabel: formatClock(at),
      title: `${event.playerName || 'A player'} joined`,
      body: 'Another seat was filled before the room launched.',
    };
  }

  if (event.type === 'LOBBY_AUTOFILLED') {
    return {
      id: event.id,
      type: event.type,
      kind: 'setup',
      at,
      atLabel: formatClock(at),
      title: `Lobby autofilled with ${Number(event.addedBots || 0)} bot${Number(event.addedBots || 0) === 1 ? '' : 's'}`,
      body: 'The room was pushed to launch readiness automatically.',
    };
  }

  if (event.type === 'GAME_STARTED') {
    return {
      id: event.id,
      type: event.type,
      kind: 'start',
      at,
      atLabel: formatClock(at),
      title: `Day ${Number(event.day || 1) || 1} begins`,
      body: 'Roles locked and the first night opened immediately.',
    };
  }

  if (event.type === 'PHASE') {
    const phase = String(event.phase || '').trim().toLowerCase();
    const body = phase === 'discussion'
      ? 'Agents started locking their public reads.'
      : phase === 'voting'
        ? 'The table moved into execution voting.'
        : phase === 'night'
          ? 'The next night cycle began.'
          : 'The match advanced to a new phase.';
    return {
      id: event.id,
      type: event.type,
      kind: 'turn',
      at,
      atLabel: formatClock(at),
      title: `${titleCase(phase || 'Phase')} phase`,
      body,
      phase: phase || null,
      day: Number(event.day || 0) || 0,
    };
  }

  if (event.type === 'DISCUSSION_MESSAGE') {
    return {
      id: event.id,
      type: event.type,
      kind: 'discussion',
      at,
      atLabel: formatClock(at),
      title: actorName,
      body: String(event.text || '').trim() || 'A public read hit the table.',
      actorId: event.actorId || null,
    };
  }

  if (event.type === 'LIVE_AGENT_DECISION' && event.text) {
    return {
      id: event.id,
      type: event.type,
      kind: 'discussion',
      at,
      atLabel: formatClock(at),
      title: actorName,
      body: String(event.text || '').trim(),
      actorId: event.actorId || null,
    };
  }

  if (event.type === 'NIGHT_ELIMINATION') {
    return {
      id: event.id,
      type: event.type,
      kind: 'elimination',
      at,
      atLabel: formatClock(at),
      title: `${targetName} was eliminated at night`,
      body: 'The mafia resolved a clean night kill.',
      targetId: event.targetId || null,
    };
  }

  if (event.type === 'DAY_EXECUTION') {
    return {
      id: event.id,
      type: event.type,
      kind: 'elimination',
      at,
      atLabel: formatClock(at),
      title: `${targetName} was voted out`,
      body: 'The table reached a decisive execution.',
      targetId: event.targetId || null,
    };
  }

  if (event.type === 'VOTE_TIED') {
    return {
      id: event.id,
      type: event.type,
      kind: 'vote',
      at,
      atLabel: formatClock(at),
      title: 'Vote tied, nobody left the table',
      body: 'The room split and the match rolled forward unchanged.',
    };
  }

  if (event.type === 'PLAYER_FORFEITED') {
    return {
      id: event.id,
      type: event.type,
      kind: 'elimination',
      at,
      atLabel: formatClock(at),
      title: `${forfeitedName} dropped from the room`,
      body: event.reason ? `Marked as ${event.reason.replaceAll('_', ' ')}.` : 'The table continued after a drop.',
      targetId: event.playerId || null,
    };
  }

  if (event.type === 'GAME_FINISHED') {
    const winner = titleCase(event.winner || 'Unknown');
    return {
      id: event.id,
      type: event.type,
      kind: 'finish',
      at,
      atLabel: formatClock(at),
      title: `${winner} wins`,
      body: 'The room reached a final result.',
      winner: event.winner || null,
    };
  }

  return {
    id: event.id,
    type: event.type,
    kind: 'meta',
    at,
    atLabel: formatClock(at),
    title: titleCase(String(event.type).replaceAll('_', ' ').toLowerCase()),
    body: 'The room state changed.',
  };
}

function buildReplaySummary(mode, roomId, state, timeline) {
  const createdAt = toTimestamp(state.createdAt);
  const finishedAt = toTimestamp(state.finishedAt);
  const durationMs = createdAt && finishedAt ? Math.max(0, finishedAt - createdAt) : null;
  const winner = state.winner || null;
  const discussionLines = timeline.filter((item) => item.kind === 'discussion').length;
  const eliminations = timeline.filter((item) => item.kind === 'elimination').length;
  const turns = timeline.filter((item) => item.kind === 'turn').length;

  return {
    mode,
    roomId: String(roomId || '').toUpperCase(),
    createdAt: createdAt || null,
    finishedAt: finishedAt || null,
    durationMs,
    durationLabel: durationMs != null ? formatDurationMs(durationMs) : null,
    winner,
    status: state.status || null,
    phase: state.phase || null,
    roundsPlayed: Number(state.roundsPlayed || 0),
    eventCount: timeline.length,
    discussionLines,
    eliminations,
    turns,
    headline: winner
      ? `${titleCase(winner)} won this ${mode} room in ${formatDurationMs(durationMs || 0)}`
      : `Replay ready for room ${String(roomId || '').toUpperCase()}`,
    outcome: winner
      ? `${titleCase(winner)} closed the table after ${Math.max(1, Number(state.roundsPlayed || 0))} round${Number(state.roundsPlayed || 0) === 1 ? '' : 's'}.`
      : 'This room has no resolved winner yet.',
  };
}

function buildReplayHighlights(timeline) {
  const highlights = [];
  const preferredKinds = ['start', 'discussion', 'elimination', 'vote', 'finish'];
  for (const kind of preferredKinds) {
    const candidate = kind === 'discussion'
      ? timeline.find((item) => item.kind === kind && item.body)
      : timeline.find((item) => item.kind === kind);
    if (candidate) highlights.push(candidate);
  }

  if (highlights.length < 4) {
    for (const item of timeline) {
      if (highlights.find((existing) => existing.id === item.id)) continue;
      if (!['discussion', 'elimination', 'finish', 'turn'].includes(item.kind)) continue;
      highlights.push(item);
      if (highlights.length >= 4) break;
    }
  }

  return highlights.slice(0, 6);
}

function buildReplayTurns(timeline) {
  return timeline
    .filter((item) => ['turn', 'discussion', 'elimination', 'vote', 'finish'].includes(item.kind))
    .slice(0, 24);
}

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
      if (typeof event.day === 'number') state.roundsPlayed = Math.max(state.roundsPlayed, event.day);
      if (event.winner) state.winner = event.winner;
      if (event.type === 'BATTLE_FINISHED' || event.type === 'GAME_FINISHED' || event.status === 'finished') state.finishedAt = event.at;
    }

    const timeline = events
      .map((event) => buildReplayTimelineItem(event))
      .filter(Boolean);
    const summary = buildReplaySummary(mode, roomId, state, timeline);

    return {
      ok: events.length > 0,
      state,
      summary,
      highlights: buildReplayHighlights(timeline),
      turns: buildReplayTurns(timeline),
      timeline,
      events,
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
