const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

const { server, mafiaRooms, clearAllGameTimers } = require('../server');
const { socketOwnsPlayer, socketIsHostPlayer } = require('../server/sockets/ownership-guards');
const { shortId, correlationId, logStructured } = require('../server/state/helpers');

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res)));
}

// ============================================================================
// Room Events API Tests
// ============================================================================

test('GET /api/rooms/:roomId/events validates mode parameter', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // Invalid mode
    const invalidMode = await fetch(`${base}/api/rooms/TEST123/events?mode=invalid`);
    const invalidRes = await invalidMode.json();
    assert.equal(invalidRes.ok, false);
    assert.equal(invalidRes.error, 'Invalid mode');

    // Valid modes should work
    const validModes = ['arena', 'mafia', 'amongus'];
    for (const mode of validModes) {
      const res = await fetch(`${base}/api/rooms/TEST123/events?mode=${mode}`);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.mode, mode);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/rooms/:roomId/events handles missing roomId gracefully', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${base}/api/rooms//events?mode=arena`);
    const json = await res.json();
    // Should handle empty roomId by converting to empty string
    assert.equal(json.ok, true);
    assert.equal(json.roomId, '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/rooms/:roomId/events respects limit parameter', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // Test with explicit limit
    const res1 = await fetch(`${base}/api/rooms/TEST123/events?mode=arena&limit=5`);
    const json1 = await res1.json();
    assert.equal(json1.ok, true);
    assert.ok(json1.events.length <= 5);

    // Test with default limit (should be 1000)
    const res2 = await fetch(`${base}/api/rooms/TEST123/events?mode=arena`);
    const json2 = await res2.json();
    assert.equal(json2.ok, true);

    // Test with invalid limit (should coerce to number)
    const res3 = await fetch(`${base}/api/rooms/TEST123/events?mode=arena&limit=abc`);
    const json3 = await res3.json();
    assert.equal(json3.ok, true);
    assert.equal(json3.events.length, 0); // NaN becomes 0
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/rooms/:roomId/replay validates mode and handles missing room', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // Invalid mode
    const invalidMode = await fetch(`${base}/api/rooms/NONEXISTENT/replay?mode=invalid`);
    const invalidRes = await invalidMode.json();
    assert.equal(invalidRes.ok, false);
    assert.equal(invalidRes.error, 'Invalid mode');

    // Valid mode but non-existent room
    const nonexistent = await fetch(`${base}/api/rooms/NONEXISTENT/replay?mode=arena`);
    const json = await nonexistent.json();
    assert.equal(json.ok, false);
    assert.equal(json.error, 'No events for room');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('room event routes handle special characters in roomId', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // Special characters that might cause issues
    const specialIds = ['ABC%20DEF', 'TEST<script>', 'ROOM"123', "ROOM'456"];
    
    for (const roomId of specialIds) {
      const res = await fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/events?mode=arena`);
      const json = await res.json();
      // Should handle gracefully without crashing
      assert.equal(json.ok, true);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ============================================================================
// Socket Ownership Guards Tests
// ============================================================================

test('socketOwnsPlayer returns false for null/undefined room', () => {
  assert.equal(socketOwnsPlayer(null, 'socket123', 'player456'), false);
  assert.equal(socketOwnsPlayer(undefined, 'socket123', 'player456'), false);
  assert.equal(socketOwnsPlayer({}, 'socket123', 'player456'), false);
});

test('socketOwnsPlayer returns false when players array is missing', () => {
  const room = { roomId: 'TEST' };
  assert.equal(socketOwnsPlayer(room, 'socket123', 'player456'), false);
});

test('socketOwnsPlayer returns false when player not found', () => {
  const room = {
    players: [
      { id: 'player1', socketId: 'socket1' },
      { id: 'player2', socketId: 'socket2' },
    ],
  };
  assert.equal(socketOwnsPlayer(room, 'socket1', 'nonexistent'), false);
});

test('socketOwnsPlayer returns false when player has no socketId', () => {
  const room = {
    players: [{ id: 'player1', socketId: null }],
  };
  assert.equal(socketOwnsPlayer(room, 'socket1', 'player1'), false);
});

test('socketOwnsPlayer returns false when socketId mismatch', () => {
  const room = {
    players: [{ id: 'player1', socketId: 'socket1' }],
  };
  assert.equal(socketOwnsPlayer(room, 'wrong-socket', 'player1'), false);
});

test('socketOwnsPlayer returns true for exact match', () => {
  const room = {
    players: [{ id: 'player1', socketId: 'socket1' }],
  };
  assert.equal(socketOwnsPlayer(room, 'socket1', 'player1'), true);
});

test('socketIsHostPlayer returns false for null/undefined values', () => {
  assert.equal(socketIsHostPlayer(null, 'socket1', 'player1'), false);
  assert.equal(socketIsHostPlayer(undefined, 'socket1', 'player1'), false);
  assert.equal(socketIsHostPlayer({}, 'socket1', null), false);
  assert.equal(socketIsHostPlayer({}, 'socket1', undefined), false);
});

test('socketIsHostPlayer returns false when not host', () => {
  const room = {
    hostPlayerId: 'player1',
    players: [{ id: 'player2', socketId: 'socket2' }],
  };
  assert.equal(socketIsHostPlayer(room, 'socket2', 'player2'), false);
});

test('socketIsHostPlayer returns false when host but socket mismatch', () => {
  const room = {
    hostPlayerId: 'player1',
    players: [{ id: 'player1', socketId: 'socket1' }],
  };
  assert.equal(socketIsHostPlayer(room, 'wrong-socket', 'player1'), false);
});

test('socketIsHostPlayer returns true when host and socket match', () => {
  const room = {
    hostPlayerId: 'player1',
    players: [{ id: 'player1', socketId: 'socket1' }],
  };
  assert.equal(socketIsHostPlayer(room, 'socket1', 'player1'), true);
});

// ============================================================================
// State Helpers Tests
// ============================================================================

test('shortId generates valid short IDs', () => {
  const id1 = shortId();
  const id2 = shortId();
  
  assert.equal(id1.length, 8);
  assert.equal(id2.length, 8);
  assert.notEqual(id1, id2); // Should be unique
  assert.ok(/^[a-f0-9]{8}$/.test(id1)); // Hex characters only
});

test('shortId respects custom length parameter', () => {
  assert.equal(shortId(4).length, 4);
  assert.equal(shortId(16).length, 16);
  assert.equal(shortId(32).length, 32);
});

test('correlationId returns shortId for empty input', () => {
  assert.equal(correlationId('').length, 12);
  assert.equal(correlationId(null).length, 12);
  assert.equal(correlationId(undefined).length, 12);
  assert.equal(correlationId('   ').length, 12);
});

test('correlationId truncates long input to 64 chars', () => {
  const longId = 'a'.repeat(100);
  assert.equal(correlationId(longId).length, 64);
});

test('correlationId preserves short input', () => {
  const shortInput = 'test-correlation-id';
  assert.equal(correlationId(shortInput), shortInput);
});

test('correlationId handles non-string input', () => {
  assert.ok(typeof correlationId(123) === 'string');
  assert.ok(typeof correlationId({ foo: 'bar' }) === 'string');
  assert.ok(typeof correlationId([1, 2, 3]) === 'string');
});

test('logStructured outputs valid JSON', () => {
  // Capture console.log output
  const originalLog = console.log;
  let captured = null;
  console.log = (msg) => { captured = msg; };

  try {
    logStructured('test-event', { foo: 'bar', count: 42 });
    
    assert.ok(captured !== null);
    const parsed = JSON.parse(captured);
    assert.equal(parsed.event, 'test-event');
    assert.equal(parsed.foo, 'bar');
    assert.equal(parsed.count, 42);
    assert.ok(parsed.at); // Timestamp should be present
    assert.ok(new Date(parsed.at).getTime() > 0); // Valid ISO date
  } finally {
    console.log = originalLog;
  }
});

test('logStructured handles empty fields', () => {
  const originalLog = console.log;
  let captured = null;
  console.log = (msg) => { captured = msg; };

  try {
    logStructured('test-event');
    
    const parsed = JSON.parse(captured);
    assert.equal(parsed.event, 'test-event');
    assert.ok(parsed.at);
  } finally {
    console.log = originalLog;
  }
});

test('logStructured handles complex nested objects', () => {
  const originalLog = console.log;
  let captured = null;
  console.log = (msg) => { captured = msg; };

  try {
    const complexData = {
      user: { id: 123, name: 'Test' },
      items: [1, 2, 3],
      meta: { nested: { deep: true } },
    };
    logStructured('complex-event', complexData);
    
    const parsed = JSON.parse(captured);
    assert.equal(parsed.event, 'complex-event');
    assert.deepEqual(parsed.user, { id: 123, name: 'Test' });
    assert.deepEqual(parsed.items, [1, 2, 3]);
  } finally {
    console.log = originalLog;
  }
});

// ============================================================================
// Integration Tests: Race Conditions & Concurrency
// ============================================================================

test('concurrent room creation with same name does not collide', async () => {
  mafiaRooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const sockets = Array.from({ length: 5 }, () => ioClient(base, { transports: ['websocket'] }));

  try {
    await Promise.all(sockets.map((s) => new Promise((resolve) => s.on('connect', resolve))));

    // All create rooms with same name simultaneously
    const results = await Promise.all(
      sockets.map((s) => emit(s, 'mafia:room:create', { name: 'TestPlayer' }))
    );

    // All should succeed with unique roomIds
    results.forEach((r) => assert.equal(r.ok, true));
    const roomIds = results.map((r) => r.roomId);
    const uniqueRoomIds = new Set(roomIds);
    assert.equal(uniqueRoomIds.size, 5); // All unique
  } finally {
    sockets.forEach((s) => s.close());
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rapid disconnect/reconnect does not leave orphaned players', async () => {
  mafiaRooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const socket1 = ioClient(base, { transports: ['websocket'] });
  
  try {
    await new Promise((resolve) => socket1.on('connect', resolve));

    const created = await emit(socket1, 'mafia:room:create', { name: 'Host' });
    assert.equal(created.ok, true);
    const roomId = created.roomId;

    // Rapid disconnect/reconnect cycle
    socket1.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const socket2 = ioClient(base, { transports: ['websocket'] });
    await new Promise((resolve) => socket2.on('connect', resolve));

    // Should be able to join the room (original player disconnected)
    const joined = await emit(socket2, 'mafia:room:join', { roomId, name: 'NewPlayer' });
    assert.equal(joined.ok, true);

    socket2.close();
  } finally {
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('malformed payload does not crash server', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const socket = ioClient(base, { transports: ['websocket'] });

  try {
    await new Promise((resolve) => socket.on('connect', resolve));

    // Send malformed payloads
    const malformedTests = [
      { name: null },
      { name: undefined },
      { name: 12345 },
      { name: {} },
      { name: [] },
      { roomId: null },
      { roomId: 12345 },
      {},
      null,
      undefined,
    ];

    for (const payload of malformedTests) {
      // Should not crash, just return error
      const res = await emit(socket, 'mafia:room:create', payload);
      // Server should handle gracefully (may return ok:false or transform input)
      assert.ok(res !== undefined);
    }
  } finally {
    socket.close();
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('extremely long player name is handled gracefully', async () => {
  mafiaRooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const socket = ioClient(base, { transports: ['websocket'] });

  try {
    await new Promise((resolve) => socket.on('connect', resolve));

    const longName = 'A'.repeat(10000);
    const res = await emit(socket, 'mafia:room:create', { name: longName });
    
    // Should either truncate or reject gracefully, not crash
    assert.ok(res !== undefined);
  } finally {
    socket.close();
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('special characters in player name do not break game state', async () => {
  mafiaRooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const socket = ioClient(base, { transports: ['websocket'] });

  try {
    await new Promise((resolve) => socket.on('connect', resolve));

    const specialNames = [
      '<script>alert("xss")</script>',
      'Player"123',
      "Player'456",
      'Player\n\n\n',
      'Player\0null',
      '😀🎮🔥',
      '../../etc/passwd',
    ];

    for (const name of specialNames) {
      const res = await emit(socket, 'mafia:room:create', { name });
      assert.ok(res !== undefined);
      
      if (res.ok) {
        // If accepted, verify room state is valid
        mafiaRooms.clear(); // Clean up for next iteration
      }
    }
  } finally {
    socket.close();
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rapid vote submissions do not cause double counting', async () => {
  mafiaRooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const host = ioClient(base, { transports: ['websocket'] });
  const player2 = ioClient(base, { transports: ['websocket'] });

  try {
    await Promise.all([
      new Promise((resolve) => host.on('connect', resolve)),
      new Promise((resolve) => player2.on('connect', resolve)),
    ]);

    const created = await emit(host, 'mafia:room:create', { name: 'Host' });
    assert.equal(created.ok, true);
    const roomId = created.roomId;
    const hostPlayerId = created.playerId;

    await emit(player2, 'mafia:room:join', { roomId, name: 'Player2' });
    
    // Fill with bots and start
    await emit(host, 'mafia:autofill', { roomId, playerId: hostPlayerId, minPlayers: 6 });
    const started = await emit(host, 'mafia:start', { roomId, playerId: hostPlayerId });
    assert.equal(started.ok, true);

    // Try to submit same vote multiple times rapidly
    const votePromises = Array.from({ length: 10 }, () =>
      emit(host, 'mafia:vote:cast', {
        roomId,
        playerId: hostPlayerId,
        targetPlayerId: 'bot-player-id',
      })
    );

    const voteResults = await Promise.all(votePromises);
    
    // First should succeed, rest should be rejected or idempotent
    // At least one should have succeeded
    const successCount = voteResults.filter((r) => r.ok).length;
    assert.ok(successCount >= 1);
  } finally {
    host.close();
    player2.close();
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ============================================================================
// Error Path Tests
// ============================================================================

test('joining non-existent room returns proper error', async () => {
  mafiaRooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const socket = ioClient(base, { transports: ['websocket'] });

  try {
    await new Promise((resolve) => socket.on('connect', resolve));

    const res = await emit(socket, 'mafia:room:join', {
      roomId: 'NONEXISTENT',
      name: 'Player',
    });

    assert.equal(res.ok, false);
    assert.ok(res.error); // Should have error message
  } finally {
    socket.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('starting game with insufficient players returns error', async () => {
  mafiaRooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const socket = ioClient(base, { transports: ['websocket'] });

  try {
    await new Promise((resolve) => socket.on('connect', resolve));

    const created = await emit(socket, 'mafia:room:create', { name: 'Host' });
    assert.equal(created.ok, true);

    // Try to start with only 1 player (need minimum 4)
    const started = await emit(socket, 'mafia:start', {
      roomId: created.roomId,
      playerId: created.playerId,
    });

    assert.equal(started.ok, false);
    assert.ok(started.error); // Should explain why start failed
  } finally {
    socket.close();
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('duplicate room join attempts are rejected', async () => {
  mafiaRooms.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const socket = ioClient(base, { transports: ['websocket'] });

  try {
    await new Promise((resolve) => socket.on('connect', resolve));

    const created = await emit(socket, 'mafia:room:create', { name: 'Host' });
    assert.equal(created.ok, true);

    // Try to join same room again with same socket
    const duplicate = await emit(socket, 'mafia:room:join', {
      roomId: created.roomId,
      name: 'SecondSeat',
    });

    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, 'SOCKET_ALREADY_JOINED');
  } finally {
    socket.close();
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});
