const MAX_BOT_MEMORY = 3;

function ensureBotMemory(bot) {
  if (!bot) return [];
  if (!Array.isArray(bot.memory)) bot.memory = [];
  return bot.memory;
}

function rememberBotRound(bot, roundOutcome) {
  const memory = ensureBotMemory(bot);
  memory.push({
    round: Number(roundOutcome?.round || 0),
    theme: String(roundOutcome?.theme || 'Unknown').slice(0, 80),
    roast: String(roundOutcome?.roast || '').slice(0, 280),
    votes: Number(roundOutcome?.votes || 0),
    winner: !!roundOutcome?.winner,
  });

  while (memory.length > MAX_BOT_MEMORY) memory.shift();
  return memory;
}

function summarizeBotMemory(bot) {
  const memory = ensureBotMemory(bot);
  if (!memory.length) return 'No prior rounds yet.';

  return memory
    .map((entry) => {
      const winTag = entry.winner ? 'won' : 'lost';
      const roast = entry.roast ? ` | roast: "${entry.roast.slice(0, 80)}"` : '';
      return `r${entry.round} ${entry.theme} (${entry.votes} votes, ${winTag})${roast}`;
    })
    .join(' || ');
}

module.exports = {
  MAX_BOT_MEMORY,
  ensureBotMemory,
  rememberBotRound,
  summarizeBotMemory,
};
