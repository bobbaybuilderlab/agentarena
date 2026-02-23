const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');

process.env.ROUND_MS = '2000';
process.env.VOTE_MS = '1200';

const { server, clearAllGameTimers } = require('../server');

function onceEvent(socket, name, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${name}`)), timeoutMs);
    socket.once(name, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

test('autonomous agents can roast and finish a battle', async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  const host = ioc(url, { reconnection: false, autoUnref: true });
  const watcher = ioc(url, { reconnection: false, autoUnref: true });

  let finished = false;

  try {
    const created = await new Promise((resolve) => {
      host.emit('room:create', { name: 'Host', type: 'human' }, resolve);
    });
    assert.equal(created.ok, true);

    await new Promise((resolve) => {
      watcher.emit('room:watch', { roomId: created.roomId }, resolve);
    });

    await new Promise((resolve) => {
      host.emit('bot:add', { roomId: created.roomId, name: 'SavageBot', persona: { style: 'savage', intensity: 8 } }, resolve);
    });
    await new Promise((resolve) => {
      host.emit('bot:add', { roomId: created.roomId, name: 'WittyBot', persona: { style: 'witty', intensity: 6 } }, resolve);
    });

    await new Promise((resolve) => {
      host.emit('battle:start', { roomId: created.roomId }, resolve);
    });

    let submittedHostRoast = false;
    const deadline = Date.now() + 9000;

    while (!finished && Date.now() < deadline) {
      const update = await onceEvent(watcher, 'room:update', 5000);

      if (update.status === 'round' && !submittedHostRoast) {
        submittedHostRoast = true;
        await new Promise((resolve) => host.emit('roast:submit', {
          roomId: update.id,
          text: 'Host roast: your roadmap has more pivots than a fidget spinner.',
        }, resolve));
      }

      if (update.status === 'voting') {
        const withRoasts = update.players.find((p) => update.roastsByRound?.[update.round]?.[p.id]);
        const target = withRoasts?.id || update.players[0]?.id;
        if (target) {
          await new Promise((resolve) => watcher.emit('vote:cast', { roomId: update.id, playerId: target }, resolve));
        }
      }

      if (update.status === 'lobby' && update.round === 1) {
        finished = true;
        assert.ok(update.lastWinner?.name);
        assert.ok(update.lastWinner?.quote);
      }
    }

    assert.equal(finished, true);
  } finally {
    host.disconnect();
    watcher.disconnect();
    clearAllGameTimers();
    await new Promise((resolve) => server.close(resolve));
  }
});
