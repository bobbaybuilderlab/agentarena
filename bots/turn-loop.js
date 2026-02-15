const DEFAULT_MAX_LENGTH = 280;

const ROAST_POOLS = {
  'Yo Mama So Fast': [
    `Yo mama so old her startup pitch deck was chiselled into stone tablets.`,
    `Yo mama so dramatic she puts a CTA at the end of every sentence.`,
    `Yo mama so slow she still thinks dial-up is a growth channel.`,
  ],
  'Tech Twitter': [
    `You tweet 'building in public' but your only shipped feature is vibes.`,
    `Your thread starts with 1/27 and still says nothing by tweet 27.`,
    `You're not a founder, you're a screenshot curator with Wi‑Fi.`,
  ],
  'Startup Founder': [
    `Your runway is shorter than your attention span.`,
    `You've pivoted so often your cap table needs a chiropractor.`,
    `Your MVP is just a waitlist with confidence issues.`,
  ],
  'Gym Bro': [
    `You count macros but can't count to profitability.`,
    `Your pre-workout has more substance than your business plan.`,
    `You benched 225 but folded under one customer support ticket.`,
  ],
  Crypto: [
    `You call it 'volatility'; your wallet calls it emotional damage.`,
    `You bought every dip and still found new lows.`,
    `Your alpha is just recycled copium with emojis.`,
  ],
  Corporate: [
    `You scheduled a sync to align on another sync.`,
    `Your calendar has more blockers than your product roadmap.`,
    `You say 'circle back' because moving forward scares you.`,
  ],
};

function pickSpice(intensity = 6) {
  if (intensity >= 8) return 'nuclear';
  if (intensity >= 5) return 'spicy';
  return 'light';
}

function planBotTurn({ theme, botName, intensity = 6, style = 'witty' }) {
  return {
    theme: theme || 'Tech Twitter',
    botName: String(botName || 'Bot').slice(0, 24),
    intensity: Number(intensity || 6),
    style: String(style || 'witty').slice(0, 20),
    maxLength: DEFAULT_MAX_LENGTH,
    policyTags: ['humor', 'no-hate', 'no-threats'],
  };
}

function draftBotRoast(plan) {
  const lines = ROAST_POOLS[plan.theme] || ROAST_POOLS['Tech Twitter'];
  const line = lines[Math.floor(Math.random() * lines.length)];
  return `[${plan.botName} • ${pickSpice(plan.intensity)}] ${line}`;
}

function selfCheckBotTurn({ draft, plan }) {
  const checks = {
    maxLength: draft.length <= plan.maxLength,
    policyTags: Array.isArray(plan.policyTags) && plan.policyTags.length >= 2,
  };

  const normalized = String(draft || '').replace(/\s+/g, ' ').trim();
  const text = normalized.slice(0, plan.maxLength);

  return {
    ok: checks.maxLength && checks.policyTags && text.length > 0,
    checks,
    text,
    policyTags: plan.policyTags,
  };
}

function submitBotTurn({ plan, checked }) {
  return {
    text: checked.text,
    meta: {
      theme: plan.theme,
      style: plan.style,
      policyTags: checked.policyTags,
      checks: checked.checks,
    },
  };
}

function runBotTurn(input) {
  const plan = planBotTurn(input);
  const draft = draftBotRoast(plan);
  const checked = selfCheckBotTurn({ draft, plan });

  if (!checked.ok) {
    const fallback = `[${plan.botName} • light] Your pitch deck has side effects.`.slice(0, plan.maxLength);
    return submitBotTurn({
      plan,
      checked: {
        ...checked,
        text: fallback,
      },
    });
  }

  return submitBotTurn({ plan, checked });
}

module.exports = {
  DEFAULT_MAX_LENGTH,
  planBotTurn,
  draftBotRoast,
  selfCheckBotTurn,
  submitBotTurn,
  runBotTurn,
};
