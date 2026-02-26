/**
 * Room event routes for debugging and replay
 */

function registerRoomEventRoutes(app, eventLog) {
  // Get room events
  app.get('/api/rooms/:roomId/events', (req, res) => {
    const { roomId } = req.params;
    const mode = req.query.mode || 'arena';
    const limit = parseInt(req.query.limit || '1000', 10);
    
    if (!eventLog) {
      return res.json([]);
    }
    
    const events = eventLog.getEvents?.(roomId, { mode, limit }) || [];
    res.json(events);
  });

  // Get room replay
  app.get('/api/rooms/:roomId/replay', (req, res) => {
    const { roomId } = req.params;
    const mode = req.query.mode || 'arena';
    
    if (!eventLog) {
      return res.json({ room: null, events: [] });
    }
    
    const events = eventLog.getEvents?.(roomId, { mode }) || [];
    res.json({ room: { id: roomId, mode }, events });
  });
}

module.exports = {
  registerRoomEventRoutes,
};
