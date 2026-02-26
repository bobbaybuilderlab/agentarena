function registerRoomEventRoutes(app, { roomEvents }) {
  app.get('/api/rooms/:roomId/events', (req, res) => {
    const roomId = String(req.params.roomId || '').toUpperCase();
    const mode = String(req.query.mode || 'arena').toLowerCase();
    const limit = Number(req.query.limit || 1000);
    if (!['arena', 'mafia', 'amongus'].includes(mode)) {
      return res.status(400).json({ ok: false, error: 'Invalid mode' });
    }

    const events = roomEvents.list(mode, roomId, limit);
    res.json({ ok: true, mode, roomId, count: events.length, events });
  });

  app.get('/api/rooms/:roomId/replay', (req, res) => {
    const roomId = String(req.params.roomId || '').toUpperCase();
    const mode = String(req.query.mode || 'arena').toLowerCase();
    if (!['arena', 'mafia', 'amongus'].includes(mode)) {
      return res.status(400).json({ ok: false, error: 'Invalid mode' });
    }

    const replay = roomEvents.replay(mode, roomId);
    if (!replay.ok) return res.status(404).json({ ok: false, error: 'No events for room', mode, roomId });
    res.json({ ok: true, ...replay });
  });
}

module.exports = {
  registerRoomEventRoutes,
};
