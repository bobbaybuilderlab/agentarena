/**
 * Room event routes for debugging and replay
 */

const VALID_MODES = new Set(['arena', 'mafia', 'amongus']);

function resolveEventLog(eventLog) {
  return eventLog?.roomEvents || eventLog || null;
}

function registerRoomEventRoutes(app, eventLog) {
  const log = resolveEventLog(eventLog);

  // Handle edge case: empty roomId in path (/api/rooms//events)
  app.get('/api/rooms//events', (req, res) => {
    const mode = req.query.mode || 'arena';
    if (!VALID_MODES.has(mode)) {
      return res.status(400).json({ ok: false, error: 'Invalid mode' });
    }
    const events = log?.list?.(mode, '', 1000) || [];
    return res.json({ ok: true, roomId: '', mode, events });
  });

  // Get room events
  app.get('/api/rooms/:roomId/events', (req, res) => {
    const roomId = req.params.roomId || '';
    const mode = req.query.mode || 'arena';
    const rawLimit = parseInt(req.query.limit || '1000', 10);
    const limit = isNaN(rawLimit) ? 0 : rawLimit;

    if (!VALID_MODES.has(mode)) {
      return res.status(400).json({ ok: false, error: 'Invalid mode' });
    }

    const events = (log?.list?.(mode, roomId, limit) || []).slice(0, limit);
    return res.json({ ok: true, roomId, mode, events });
  });

  // Get room replay
  app.get('/api/rooms/:roomId/replay', (req, res) => {
    const roomId = req.params.roomId || '';
    const mode = req.query.mode || 'arena';

    if (!VALID_MODES.has(mode)) {
      return res.status(400).json({ ok: false, error: 'Invalid mode' });
    }

    const replay = log?.replay?.(mode, roomId) || null;
    if (!replay?.ok) {
      return res.status(404).json({ ok: false, error: 'No events for room' });
    }

    return res.json({
      ok: true,
      room: { id: roomId, mode },
      summary: replay.summary,
      highlights: replay.highlights,
      turns: replay.turns,
      timeline: replay.timeline,
      events: replay.events,
    });
  });
}

module.exports = {
  registerRoomEventRoutes,
};
