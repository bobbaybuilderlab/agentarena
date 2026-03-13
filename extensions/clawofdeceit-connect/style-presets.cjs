const DEFAULT_PRESET_ID = 'pragmatic';

const STYLE_PRESETS = Object.freeze([
  {
    id: 'pragmatic',
    label: 'Pragmatic',
    summary: 'Outcome-first pressure with clean, low-drama solves.',
    starterPrompt: 'pragmatic operator',
    keywords: ['pragmatic', 'practical', 'operator', 'outcome first', 'efficient', 'clean solve'],
  },
  {
    id: 'serious',
    label: 'Serious',
    summary: 'Formal, disciplined pressure that stays focused on evidence.',
    starterPrompt: 'serious prosecutor',
    keywords: ['serious', 'formal', 'disciplined', 'stoic', 'prosecutor', 'strict'],
  },
  {
    id: 'patient',
    label: 'Patient',
    summary: 'Observant, late-committing reads that wait for contradictions.',
    starterPrompt: 'patient observer',
    keywords: ['patient', 'cautious', 'careful', 'observant', 'steady', 'wait and see'],
  },
  {
    id: 'chaotic',
    label: 'Chaotic',
    summary: 'High-variance pressure that chases reactions and destabilizes the table.',
    starterPrompt: 'chaotic preacher',
    keywords: ['chaotic', 'wild', 'unhinged', 'gremlin', 'preacher', 'unpredictable'],
  },
  {
    id: 'arrogant',
    label: 'Arrogant',
    summary: 'Overconfident table control with forceful, commanding reads.',
    starterPrompt: 'arrogant shot-caller',
    keywords: ['arrogant', 'cocky', 'dominant', 'aggressive', 'alpha', 'shot caller'],
  },
  {
    id: 'analytical',
    label: 'Analytical',
    summary: 'Pattern-tracking, vote-reading play grounded in logic.',
    starterPrompt: 'analytical tactician',
    keywords: ['analytical', 'analyst', 'methodical', 'logical', 'thoughtful', 'tactician'],
  },
  {
    id: 'charming',
    label: 'Charming',
    summary: 'Warm, alliance-building pressure with soft redirection.',
    starterPrompt: 'friendly manipulator',
    keywords: ['charming', 'friendly', 'warm', 'charmer', 'social', 'manipulator'],
  },
  {
    id: 'paranoid',
    label: 'Paranoid',
    summary: 'Suspicion-heavy play that hunts hidden coordination.',
    starterPrompt: 'paranoid detective',
    keywords: ['paranoid', 'suspicious', 'detective', 'conspiracy', 'alarm bell', 'watch everyone'],
  },
]);

const STYLE_PRESET_MAP = Object.freeze(
  Object.fromEntries(STYLE_PRESETS.map((preset) => [preset.id, preset])),
);

const LEGACY_STYLE_ALIASES = Object.freeze({
  witty: 'pragmatic',
  deadpan: 'serious',
  cold: 'serious',
  cautious: 'patient',
  aggressive: 'arrogant',
  thoughtful: 'analytical',
  paranoid: 'paranoid',
  chaotic: 'chaotic',
  stoic: 'serious',
  analyst: 'analytical',
  charmer: 'charming',
});

function normalizePresetToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function normalizeStyleText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getStyleWords(value) {
  const normalized = normalizeStyleText(value);
  return normalized ? normalized.split(' ') : [];
}

function findPresetById(presetId) {
  return STYLE_PRESET_MAP[normalizePresetToken(presetId)] || null;
}

function inferPresetFromStyle(style) {
  const normalizedStyle = normalizeStyleText(style);
  if (!normalizedStyle) return null;
  if (STYLE_PRESET_MAP[normalizePresetToken(normalizedStyle)]) {
    return normalizePresetToken(normalizedStyle);
  }
  if (LEGACY_STYLE_ALIASES[normalizedStyle]) {
    return LEGACY_STYLE_ALIASES[normalizedStyle];
  }

  const styleWords = new Set(getStyleWords(style));
  let bestMatch = null;
  let bestScore = 0;

  for (const preset of STYLE_PRESETS) {
    let score = 0;
    for (const keyword of preset.keywords || []) {
      const normalizedKeyword = normalizeStyleText(keyword);
      if (!normalizedKeyword) continue;
      const keywordWords = normalizedKeyword.split(' ');
      if (normalizedStyle === normalizedKeyword) score += 5;
      if (normalizedStyle.includes(normalizedKeyword)) score += 3;
      if (keywordWords.every((word) => styleWords.has(word))) score += 2;
    }

    if (score > bestScore) {
      bestMatch = preset.id;
      bestScore = score;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

function resolvePresetId({ presetId, style, fallbackId = DEFAULT_PRESET_ID } = {}) {
  const directPreset = findPresetById(presetId);
  if (directPreset) return directPreset.id;

  const inferredPresetId = inferPresetFromStyle(style);
  if (inferredPresetId) return inferredPresetId;

  const fallbackPreset = findPresetById(fallbackId) || findPresetById(DEFAULT_PRESET_ID);
  return fallbackPreset.id;
}

function cleanStylePhrase(style) {
  return String(style || '').replace(/\s+/g, ' ').trim().slice(0, 48);
}

function buildResolvedPersona({ presetId, style, fallbackPresetId = DEFAULT_PRESET_ID } = {}) {
  const resolvedPresetId = resolvePresetId({
    presetId,
    style,
    fallbackId: fallbackPresetId,
  });
  const preset = findPresetById(resolvedPresetId) || findPresetById(DEFAULT_PRESET_ID);
  return {
    presetId: resolvedPresetId,
    style: cleanStylePhrase(style) || preset.starterPrompt,
    preset,
  };
}

module.exports = {
  DEFAULT_PRESET_ID,
  LEGACY_STYLE_ALIASES,
  STYLE_PRESETS,
  buildResolvedPersona,
  cleanStylePhrase,
  findPresetById,
  inferPresetFromStyle,
  normalizePresetToken,
  normalizeStyleText,
  resolvePresetId,
};
