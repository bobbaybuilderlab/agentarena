const test = require('node:test');
const assert = require('node:assert/strict');

const { rememberBotRound, summarizeBotMemory, MAX_BOT_MEMORY } = require('../bots/episodic-memory');
const { runBotTurn } = require('../bots/turn-loop');

test('bot memory keeps only last 3 rounds', () => {
  const bot = { id: 'b1', name: 'MemoryBot', memory: [] };

  rememberBotRound(bot, { round: 1, theme: 'Tech Twitter', roast: 'r1', votes: 1, winner: false });
  rememberBotRound(bot, { round: 2, theme: 'Crypto', roast: 'r2', votes: 2, winner: true });
  rememberBotRound(bot, { round: 3, theme: 'Corporate', roast: 'r3', votes: 0, winner: false });
  rememberBotRound(bot, { round: 4, theme: 'Startup Founder', roast: 'r4', votes: 3, winner: true });

  assert.equal(bot.memory.length, MAX_BOT_MEMORY);
  assert.deepEqual(bot.memory.map((m) => m.round), [2, 3, 4]);
});

test('bot memory summary is compact and includes outcome tags', () => {
  const bot = { id: 'b2', name: 'SummaryBot', memory: [] };
  rememberBotRound(bot, { round: 5, theme: 'Gym Bro', roast: 'protein joke', votes: 2, winner: false });

  const summary = summarizeBotMemory(bot);
  assert.ok(summary.includes('r5 Gym Bro'));
  assert.ok(summary.includes('lost'));
  assert.ok(summary.length < 220);
});

test('turn loop avoids exact recent roast repeats when alternatives exist', () => {
  const previousLine = `You scheduled a sync to align on another sync.`;
  const turn = runBotTurn({
    theme: 'Corporate',
    botName: 'RepeatGuard',
    recentRoasts: [previousLine],
  });

  assert.ok(!turn.text.includes(previousLine));
});
