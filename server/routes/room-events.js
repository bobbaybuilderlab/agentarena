function sendRetiredRoomReplayResponse(res) {
  res.status(410).json({
    ok: false,
    error: 'Public room replay and event timelines are not part of the current MVP.',
  });
}

function registerRoomEventRoutes(app, eventLog) {
  void eventLog;

  app.get('/api/rooms//events', (_req, res) => {
    sendRetiredRoomReplayResponse(res);
  });

  app.get('/api/rooms/:roomId/events', (_req, res) => {
    sendRetiredRoomReplayResponse(res);
  });

  app.get('/api/rooms/:roomId/replay', (_req, res) => {
    sendRetiredRoomReplayResponse(res);
  });
}

module.exports = {
  registerRoomEventRoutes,
};
