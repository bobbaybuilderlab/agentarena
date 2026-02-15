const DEFAULT_MAX_LENGTH = 280;

const BASE_RULES = [
  {
    code: 'POLICY_HATE',
    test: (text) => /\b(subhuman|nazi\s*scum|go\s+back\s+to\s+your\s+country)\b/i.test(text),
    message: 'hate content is not allowed',
  },
  {
    code: 'POLICY_THREAT',
    test: (text) => /\b(i\s*(will|am\s+gonna)\s*(kill|murder|hurt)\s+you|you\s+deserve\s+to\s+die)\b/i.test(text),
    message: 'threatening content is not allowed',
  },
  {
    code: 'POLICY_SELF_HARM',
    test: (text) => /\b(kill\s+yourself|kys|go\s+die)\b/i.test(text),
    message: 'self-harm encouragement is not allowed',
  },
  {
    code: 'POLICY_EXPLICIT',
    test: (text) => /\b(suck\s+my\s+d\w*|f\w*\s+you\s+hard|explicit\s+sexual)\b/i.test(text),
    message: 'explicit sexual content is not allowed',
  },
];

function normalizeRoast(text, maxLength = DEFAULT_MAX_LENGTH) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

const CANARY_RULES = [
  {
    code: 'POLICY_CANARY_PROFANITY',
    test: (text) => /\b(fuck\s+you|piece\s+of\s+shit|dumbass)\b/i.test(text),
    message: 'profanity-heavy content is blocked in canary policy',
  },
];

function moderateRoast(text, options = {}) {
  const maxLength = Number(options.maxLength || DEFAULT_MAX_LENGTH);
  const variant = options.variant === 'canary' ? 'canary' : 'control';
  const normalized = normalizeRoast(text, maxLength);

  if (!normalized) {
    return {
      ok: false,
      code: 'POLICY_EMPTY',
      message: 'roast required',
      text: '',
      variant,
    };
  }

  const rules = variant === 'canary' ? [...BASE_RULES, ...CANARY_RULES] : BASE_RULES;

  for (const rule of rules) {
    if (rule.test(normalized)) {
      return {
        ok: false,
        code: rule.code,
        message: rule.message,
        text: normalized,
        variant,
      };
    }
  }

  return {
    ok: true,
    code: 'POLICY_OK',
    message: 'allowed',
    text: normalized,
    variant,
  };
}

module.exports = {
  DEFAULT_MAX_LENGTH,
  moderateRoast,
};
