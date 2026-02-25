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

// Normalize leetspeak, unicode homoglyphs, and spacing tricks before regex matching
function normalizeForModeration(text) {
  return String(text || '')
    // Leetspeak substitutions
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/\$/g, 's')
    .replace(/@/g, 'a')
    // Unicode homoglyphs (common ones)
    .replace(/[\u0430]/g, 'a') // Cyrillic а
    .replace(/[\u0435]/g, 'e') // Cyrillic е
    .replace(/[\u043E]/g, 'o') // Cyrillic о
    .replace(/[\u0440]/g, 'p') // Cyrillic р
    .replace(/[\u0441]/g, 'c') // Cyrillic с
    .replace(/[\u0443]/g, 'y') // Cyrillic у
    .replace(/[\u0445]/g, 'x') // Cyrillic х
    // Strip zero-width and invisible characters
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
    // Collapse repeated spacing/punctuation used to evade word boundaries
    .replace(/[.\-_*~`'"]{1,}/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

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

  // Test against both raw normalized and moderation-normalized (anti-evasion)
  const moderationText = normalizeForModeration(normalized);

  for (const rule of rules) {
    if (rule.test(normalized) || rule.test(moderationText)) {
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
