'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  CONNECTOR_COMMAND_NAMESPACE,
  CONNECTOR_PACKAGE_NAME,
  CONNECTOR_PLUGIN_ID,
  PUBLIC_OPENCLAW_PROFILE,
  buildOnboardingContract,
  buildOpenClawCommand,
} = require('../server/services/onboarding-contract.js');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_OUTPUT_ROOT = path.join(REPO_ROOT, 'artifacts', 'onboarding-proxy-study');
const STUDY_VERSION = 'current-flow-v1';
const DEFAULT_PUBLIC_BASE_URL = 'https://clawofdeceit.com';

const REVIEWER_PERSONAS = Object.freeze([
  {
    id: 'cautious-mainstream',
    label: 'Cautious Mainstream Newcomer',
    lens: 'A first-time OpenClaw user who wants straightforward reassurance before running any setup command.',
  },
  {
    id: 'privacy-security',
    label: 'Privacy / Security-Sensitive Newcomer',
    lens: 'A user who defaults to distrust and looks for hidden privileges, remote prompts, and secret handling risks.',
  },
  {
    id: 'skeptical-oss',
    label: 'Skeptical OSS / Package Reviewer',
    lens: 'A user who is comfortable reading package instructions and wants evidence that the package boundary is sane.',
  },
  {
    id: 'impatient-outcome',
    label: 'Impatient Outcome-Driven User',
    lens: 'A user who only cares about getting an agent live quickly and stops when a flow feels unusually complicated.',
  },
  {
    id: 'power-operator',
    label: 'Power User / Operator',
    lens: 'A user who understands profiles, persistence, and agent hosting, and inspects operational consequences before trusting the flow.',
  },
]);

const CONCERN_TYPES = Object.freeze([
  {
    id: 'supply-chain-trust',
    label: 'Supply Chain / Package Trust',
    description: 'Worry about installing the npm package, plugin provenance, or trusting code from the package registry.',
  },
  {
    id: 'plugin-permissions',
    label: 'Plugin Permissions / Trust Prompts',
    description: 'Worry about allow/enable prompts, requested capabilities, or what OpenClaw is asking the user to trust.',
  },
  {
    id: 'remote-content-trust',
    label: 'Remote Content / Hosted Skill Trust',
    description: 'Worry about trusting instructions or behavior that come from a website-hosted skill or one-time prompt.',
  },
  {
    id: 'secret-handling',
    label: 'Secret Handling',
    description: 'Worry about one-time tokens, callback proofs, secret entry, or how sensitive values move through the flow.',
  },
  {
    id: 'callback-destination',
    label: 'Callback / Destination Trust',
    description: 'Worry about what host the plugin calls back to and whether that destination looks constrained or arbitrary.',
  },
  {
    id: 'persistence-storage',
    label: 'Persistence / What Gets Saved',
    description: 'Worry about the permanent local binding, what survives restarts, and where saved agent state lives.',
  },
  {
    id: 'profile-isolation',
    label: 'Profile Isolation',
    description: 'Worry about whether the dedicated OpenClaw profile is actually isolated from the user’s normal setup.',
  },
  {
    id: 'ux-confusion',
    label: 'UX Confusion / Unclear Next Step',
    description: 'Worry caused by ambiguity, unclear sequencing, unclear failure handling, or too much onboarding friction.',
  },
]);

const STUDY_QUESTIONS = Object.freeze([
  'Would you proceed at this step?',
  'What worries you right now?',
  'What feels reassuring or normal?',
  'What would you want to inspect before continuing?',
  'What language or behavior would make you stop?',
]);

const STUDY_STEPS = Object.freeze([
  {
    id: 'connect-page',
    title: 'Connect Page Landing',
    focus: 'First impression of the public connect page and its package-review fallback.',
    artifactKeys: ['connectPage'],
  },
  {
    id: 'install-trust-enable',
    title: 'Install / Trust / Enable Block',
    focus: 'Reaction to the install command, allowlist command, and plugin enablement step.',
    artifactKeys: ['connectorInstall', 'onboardingContract'],
  },
  {
    id: 'package-identity',
    title: 'Package Identity And README Summary',
    focus: 'Reaction to package purpose, supported workflow, and saved-agent claims from the connector README.',
    artifactKeys: ['connectorPackage'],
  },
  {
    id: 'hosted-skill',
    title: 'Hosted Skill Instructions',
    focus: 'Reaction to the hosted `skill.md` and how much the user is expected to trust it.',
    artifactKeys: ['publicSkill'],
  },
  {
    id: 'one-time-message',
    title: 'One-Time Connect Message',
    focus: 'Reaction to the generated one-time message, callback URL, token, and proof flow.',
    artifactKeys: ['onboardingContract'],
  },
  {
    id: 'saved-binding-recovery',
    title: 'Saved Binding And Recovery',
    focus: 'Reaction to persistence, manual revive, and the dedicated-profile recovery story.',
    artifactKeys: ['helpFaq', 'connectorPackage'],
  },
]);

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n/g, '\n');
}

function collapseBlankLines(value) {
  return normalizeNewlines(value)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&rarr;/g, '->')
    .replace(/&times;/g, 'x')
    .replace(/&#9776;/g, '');
}

function htmlToText(html) {
  return collapseBlankLines(
    decodeHtmlEntities(String(html || ''))
      .replace(/<script[\s\S]*?<\/script>/gi, '\n')
      .replace(/<style[\s\S]*?<\/style>/gi, '\n')
      .replace(/<code>([\s\S]*?)<\/code>/gi, (_full, text) => `\`${decodeHtmlEntities(text)}\``)
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<\/(p|div|section|details|summary|ol|ul|li|main|nav|footer|h1|h2|h3|h4|pre)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' '),
  );
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readRepoText(...segments) {
  return readText(path.join(REPO_ROOT, ...segments));
}

function safeExcerpt(value, maxChars = 7_000) {
  const normalized = collapseBlankLines(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 12).trimEnd()}\n[truncated]`;
}

function getMarkdownPreamble(markdown) {
  const normalized = normalizeNewlines(markdown);
  const firstH2 = normalized.search(/^##\s+/m);
  if (firstH2 === -1) return normalized.trim();
  return normalized.slice(0, firstH2).trim();
}

function parseMarkdownSections(markdown) {
  const sections = [];
  let current = {
    heading: '',
    level: 0,
    body: [],
  };

  for (const line of normalizeNewlines(markdown).split('\n')) {
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    if (match) {
      if (current.heading || current.body.length) {
        sections.push({
          heading: current.heading,
          level: current.level,
          body: collapseBlankLines(current.body.join('\n')),
        });
      }
      current = {
        heading: match[2].trim(),
        level: match[1].length,
        body: [],
      };
      continue;
    }
    current.body.push(line);
  }

  if (current.heading || current.body.length) {
    sections.push({
      heading: current.heading,
      level: current.level,
      body: collapseBlankLines(current.body.join('\n')),
    });
  }

  return sections;
}

function getMarkdownSection(markdown, heading) {
  return parseMarkdownSections(markdown).find((section) => section.heading === heading)?.body || '';
}

function labelSection(title, body) {
  const normalized = collapseBlankLines(body);
  if (!normalized) return '';
  return `## ${title}\n${normalized}`;
}

function extractConnectPageArtifact(html) {
  const lines = [];
  const heroMatch = html.match(/<section class="connect-hero">([\s\S]*?)<\/section>/i);
  if (heroMatch) {
    lines.push(htmlToText(heroMatch[1]));
  }

  const stepRegex = /<div class="connect-step"[^>]*>[\s\S]*?<div class="connect-step-num"[^>]*>(.*?)<\/div>[\s\S]*?<h3[^>]*>(.*?)<\/h3>[\s\S]*?<p>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = stepRegex.exec(html)) !== null) {
    const stepNumber = htmlToText(match[1]);
    const title = htmlToText(match[2]);
    const summary = htmlToText(match[3]);
    lines.push(`Step ${stepNumber}: ${title}\n${summary}`);
  }

  const fallbackMatch = html.match(/<details class="connect-fallback">([\s\S]*?)<\/details>/i);
  if (fallbackMatch) {
    lines.push(`Package review fallback\n${htmlToText(fallbackMatch[1])}`);
  }

  return safeExcerpt(lines.join('\n\n'));
}

function extractHelpFaqArtifact(html) {
  const wantedSummaries = [
    'How do I connect my agent?',
    'Do I need to create an account?',
    'Does my agent survive restarts?',
    'Do I need to reconnect every time?',
    'My agent won\'t connect',
    'My agent went offline mid-game',
  ];
  const detailRegex = /<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<div class="help-answer">([\s\S]*?)<\/div>\s*<\/details>/gi;
  const answers = new Map();
  let match;
  while ((match = detailRegex.exec(html)) !== null) {
    answers.set(htmlToText(match[1]), htmlToText(match[2]));
  }

  const lines = [];
  for (const summary of wantedSummaries) {
    const answer = answers.get(summary);
    if (!answer) continue;
    lines.push(`Q: ${summary}\n${answer}`);
  }
  return safeExcerpt(lines.join('\n\n'));
}

function extractConnectorInstallArtifact(readme) {
  const preamble = getMarkdownPreamble(readme);
  const installSection = getMarkdownSection(readme, 'Install');
  const connectSection = getMarkdownSection(readme, 'Connect');

  return safeExcerpt([
    preamble,
    labelSection('Install', installSection),
    labelSection('Connect', connectSection),
  ].filter(Boolean).join('\n\n'));
}

function extractConnectorPackageArtifact(readme) {
  const preamble = getMarkdownPreamble(readme);
  const manageSection = getMarkdownSection(readme, 'Manage saved agents');
  const levelUpSection = getMarkdownSection(readme, 'Level Up Later');

  return safeExcerpt([
    preamble,
    labelSection('Manage saved agents', manageSection),
    labelSection('Level Up Later', levelUpSection),
  ].filter(Boolean).join('\n\n'));
}

function extractPublicSkillArtifact(skillMarkdown) {
  return safeExcerpt([
    labelSection('What this skill does', getMarkdownSection(skillMarkdown, 'What this skill does')),
    labelSection('What this skill does not do', getMarkdownSection(skillMarkdown, 'What this skill does not do')),
    labelSection('Required setup gate', getMarkdownSection(skillMarkdown, 'Required setup gate')),
    labelSection('Required human choice', getMarkdownSection(skillMarkdown, 'Required human choice')),
    labelSection('Required completion message', getMarkdownSection(skillMarkdown, 'Required completion message')),
    labelSection('Safety and trust notes', getMarkdownSection(skillMarkdown, 'Safety and trust notes')),
  ].filter(Boolean).join('\n\n'));
}

function buildExampleOnboardingContract(publicBaseUrl = DEFAULT_PUBLIC_BASE_URL) {
  return buildOnboardingContract({
    publicBaseUrl,
    sessionId: 'connect-session-example',
    accessToken: 'access-token-example',
    token: 'connect-token-example',
    callbackUrl: `${publicBaseUrl.replace(/\/+$/, '')}/api/openclaw/connect-session/connect-session-example/callback`,
    callbackProof: 'callback-proof-example',
  });
}

function renderOnboardingContractArtifact(contract) {
  const recoveryCommand = `${buildOpenClawCommand(PUBLIC_OPENCLAW_PROFILE)} ${CONNECTOR_COMMAND_NAMESPACE} agents start --all`;
  return safeExcerpt([
    `Plugin package: ${contract.pluginPackage}`,
    `Plugin id: ${contract.pluginId}`,
    `Dedicated profile: ${PUBLIC_OPENCLAW_PROFILE}`,
    `Public skill URL: ${contract.skillUrl}`,
    `Session skill URL: ${contract.sessionSkillUrl}`,
    '',
    'Installer command:',
    '```bash',
    contract.installerCommand,
    '```',
    '',
    'One-time message shown to OpenClaw:',
    contract.agentPrompt || '[none]',
    '',
    'One-time connect command used inside the flow:',
    '```bash',
    contract.connectCommand || '[none]',
    '```',
    '',
    `Default preset: ${contract.defaultPresetId}`,
    `Available preset ids: ${contract.stylePresets.map((preset) => preset.id).join(', ')}`,
    `Recovery command: ${recoveryCommand}`,
  ].join('\n'));
}

function summarizeBaselineResult(baseline) {
  if (!baseline || typeof baseline !== 'object') return [];
  const notes = [];
  if (baseline.ok === true) {
    notes.push('Fresh-profile cold-start install, trust, enable, bind, and runtime connect succeeded.');
  } else if (baseline.ok === false) {
    notes.push(`Fresh-profile cold-start failed: ${String(baseline.error || 'unknown error')}`);
  }
  if (baseline.pluginWarningCount === 0) {
    notes.push('No plugin trust warnings were observed during the fresh-profile run.');
  } else if (Number.isFinite(Number(baseline.pluginWarningCount))) {
    notes.push(`Observed ${Number(baseline.pluginWarningCount)} plugin trust warning(s) during the fresh-profile run.`);
  }
  if (baseline.agentId) {
    notes.push(`Connected agent id: ${baseline.agentId}.`);
  }
  if (Number.isFinite(Number(baseline.connectedAgents))) {
    notes.push(`Connected agents after pairing: ${Number(baseline.connectedAgents)}.`);
  }
  if (baseline.queueStatus) {
    notes.push(`Reported queue status after pairing: ${baseline.queueStatus}.`);
  }
  if (baseline.installSpec) {
    notes.push(`Install source used in the baseline: ${baseline.installSpec}.`);
  }
  return notes;
}

function loadBaselineFromPath(baselinePath) {
  if (!baselinePath) return null;
  const resolved = path.resolve(REPO_ROOT, baselinePath);
  return JSON.parse(readText(resolved));
}

function buildCurrentFlowStudyPacket(options = {}) {
  const publicBaseUrl = String(options.publicBaseUrl || DEFAULT_PUBLIC_BASE_URL).trim().replace(/\/+$/, '');
  const baseline = options.baselineData || loadBaselineFromPath(options.baselinePath);
  const connectHtml = readRepoText('public', 'connect.html');
  const helpHtml = readRepoText('public', 'help.html');
  const skillMarkdown = readRepoText('public', 'skill.md');
  const connectorReadme = readRepoText('extensions', 'clawofdeceit-connect', 'README.md');
  const connectorPackageJson = JSON.parse(readRepoText('extensions', 'clawofdeceit-connect', 'package.json'));
  const contract = buildExampleOnboardingContract(publicBaseUrl);

  return {
    studyVersion: STUDY_VERSION,
    generatedAt: new Date().toISOString(),
    publicBaseUrl,
    profile: PUBLIC_OPENCLAW_PROFILE,
    pluginPackage: CONNECTOR_PACKAGE_NAME,
    pluginId: CONNECTOR_PLUGIN_ID,
    connectorVersion: String(connectorPackageJson.version || '').trim(),
    baseline,
    baselineSummary: summarizeBaselineResult(baseline),
    personas: REVIEWER_PERSONAS,
    concernTypes: CONCERN_TYPES,
    questions: STUDY_QUESTIONS,
    steps: STUDY_STEPS,
    artifacts: {
      connectPage: {
        key: 'connectPage',
        title: 'Public connect page copy',
        sourcePath: 'public/connect.html',
        excerpt: extractConnectPageArtifact(connectHtml),
      },
      connectorInstall: {
        key: 'connectorInstall',
        title: 'Connector README install and connect guidance',
        sourcePath: 'extensions/clawofdeceit-connect/README.md',
        excerpt: extractConnectorInstallArtifact(connectorReadme),
      },
      connectorPackage: {
        key: 'connectorPackage',
        title: 'Connector README package and persistence summary',
        sourcePath: 'extensions/clawofdeceit-connect/README.md',
        excerpt: extractConnectorPackageArtifact(connectorReadme),
      },
      publicSkill: {
        key: 'publicSkill',
        title: 'Hosted public skill contract',
        sourcePath: 'public/skill.md',
        excerpt: extractPublicSkillArtifact(skillMarkdown),
      },
      helpFaq: {
        key: 'helpFaq',
        title: 'Help / FAQ persistence and recovery copy',
        sourcePath: 'public/help.html',
        excerpt: extractHelpFaqArtifact(helpHtml),
      },
      onboardingContract: {
        key: 'onboardingContract',
        title: 'Generated one-time onboarding contract example',
        sourcePath: 'server/services/onboarding-contract.js',
        excerpt: renderOnboardingContractArtifact(contract),
      },
    },
  };
}

function buildReviewerResultTemplate(persona) {
  return {
    reviewer: {
      id: persona.id,
      label: persona.label,
      lens: persona.lens,
    },
    studyVersion: STUDY_VERSION,
    overallVerdict: {
      wouldProceed: '',
      overallComfort: '',
      summary: '',
    },
    stepResponses: STUDY_STEPS.map((step) => ({
      stepId: step.id,
      wouldProceed: '',
      whatWorriesYou: [],
      whatFeelsReassuring: [],
      whatWouldYouInspect: [],
      stopTriggers: [],
    })),
    concerns: [],
    topConcerns: [],
  };
}

function buildReviewerSchemaExample(persona) {
  const template = buildReviewerResultTemplate(persona);
  template.overallVerdict = {
    wouldProceed: 'yes|hesitate|no',
    overallComfort: 'high|medium|low',
    summary: '',
  };
  if (template.stepResponses[0]) {
    template.stepResponses[0] = {
      stepId: template.stepResponses[0].stepId,
      wouldProceed: 'yes|hesitate|no',
      whatWorriesYou: [],
      whatFeelsReassuring: [],
      whatWouldYouInspect: [],
      stopTriggers: [],
    };
  }
  template.concerns = [
    {
      stepId: STUDY_STEPS[0].id,
      concernType: CONCERN_TYPES[0].id,
      severity: 'high|medium|low',
      triggerArtifact: 'public/connect.html',
      concernSummary: '',
      whatReviewerWantsToSee: '',
      suggestedFix: '',
      confidence: 'high|medium|low',
      likelyHumanConcern: true,
    },
  ];
  return template;
}

function buildReviewerPrompt(packet, persona) {
  const lines = [];
  lines.push(`# ${persona.label}`);
  lines.push('');
  lines.push(`Lens: ${persona.lens}`);
  lines.push('');
  lines.push('Review the current Claw of Deceit onboarding flow as it exists today. This is a trust-and-comfort proxy review, not a code bug hunt.');
  lines.push('');
  lines.push('Ground rules:');
  lines.push('- Evaluate the current flow only.');
  lines.push('- Assume the user is fresh to Claw of Deceit and OpenClaw unless your persona says otherwise.');
  lines.push('- Distinguish substantive concerns from theoretical concerns.');
  lines.push('- Tie every concern to the artifact text that triggered it.');
  lines.push('- Do not propose a plugin-only pivot unless the current artifacts clearly justify that conclusion.');
  lines.push('');
  lines.push('Study metadata:');
  lines.push(`- Study version: \`${packet.studyVersion}\``);
  lines.push(`- Public base URL: \`${packet.publicBaseUrl}\``);
  lines.push(`- Dedicated OpenClaw profile: \`${packet.profile}\``);
  lines.push(`- Connector package: \`${packet.pluginPackage}\` v${packet.connectorVersion || 'unknown'}`);
  lines.push('');
  lines.push('Questions to answer at every step:');
  for (const question of packet.questions) {
    lines.push(`- ${question}`);
  }
  lines.push('');
  lines.push('Concern taxonomy ids to use in your JSON output:');
  for (const concernType of packet.concernTypes) {
    lines.push(`- \`${concernType.id}\` — ${concernType.description}`);
  }
  lines.push('');

  if (packet.baselineSummary.length) {
    lines.push('Fresh-profile technical baseline:');
    for (const note of packet.baselineSummary) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  for (const step of packet.steps) {
    lines.push(`## ${step.title}`);
    lines.push(step.focus);
    lines.push('');
    lines.push(`Step id: \`${step.id}\``);
    lines.push('');
    for (const artifactKey of step.artifactKeys) {
      const artifact = packet.artifacts[artifactKey];
      if (!artifact) continue;
      lines.push(`### ${artifact.title}`);
      lines.push(`Source: \`${artifact.sourcePath}\``);
      lines.push('````text');
      lines.push(artifact.excerpt);
      lines.push('````');
      lines.push('');
    }
  }

  lines.push('## Output requirements');
  lines.push('- Return JSON only.');
  lines.push('- Use the step ids and concern taxonomy ids exactly as provided.');
  lines.push('- Keep `topConcerns` to the 1-3 concern summaries that matter most.');
  lines.push('- Set `likelyHumanConcern` to `false` when the issue feels mostly AI-theoretical rather than a probable human trust blocker.');
  lines.push('');
  lines.push('JSON schema example:');
  lines.push('```json');
  lines.push(JSON.stringify(buildReviewerSchemaExample(persona), null, 2));
  lines.push('```');
  return lines.join('\n');
}

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${String(content || '').replace(/\s+$/, '')}\n`, 'utf8');
}

function writeJsonFile(filePath, value) {
  writeTextFile(filePath, JSON.stringify(value, null, 2));
}

function writeStudyBundle(outputDir, packet) {
  const resolvedOutputDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  const createdFiles = [];

  const packetPath = path.join(resolvedOutputDir, 'study-packet.json');
  writeJsonFile(packetPath, packet);
  createdFiles.push(packetPath);

  for (const persona of packet.personas) {
    const promptPath = path.join(resolvedOutputDir, `reviewer-prompt-${persona.id}.md`);
    const templatePath = path.join(resolvedOutputDir, `reviewer-result-template-${persona.id}.json`);
    writeTextFile(promptPath, buildReviewerPrompt(packet, persona));
    writeJsonFile(templatePath, buildReviewerResultTemplate(persona));
    createdFiles.push(promptPath, templatePath);
  }

  return createdFiles;
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeConcern(packet, concern) {
  const validConcernTypes = new Set(packet.concernTypes.map((entry) => entry.id));
  const validSteps = new Set(packet.steps.map((entry) => entry.id));
  const stepId = normalizeEnum(String(concern?.stepId || '').trim(), [...validSteps], packet.steps[0]?.id || '');
  const concernType = normalizeEnum(String(concern?.concernType || '').trim(), [...validConcernTypes], 'ux-confusion');
  const severity = normalizeEnum(String(concern?.severity || '').trim(), ['high', 'medium', 'low'], 'medium');
  const confidence = normalizeEnum(String(concern?.confidence || '').trim(), ['high', 'medium', 'low'], 'medium');

  return {
    stepId,
    concernType,
    severity,
    triggerArtifact: String(concern?.triggerArtifact || '').trim(),
    concernSummary: collapseBlankLines(concern?.concernSummary || ''),
    whatReviewerWantsToSee: collapseBlankLines(concern?.whatReviewerWantsToSee || ''),
    suggestedFix: collapseBlankLines(concern?.suggestedFix || ''),
    confidence,
    likelyHumanConcern: concern?.likelyHumanConcern !== false,
  };
}

function normalizeReviewerResult(packet, result) {
  return {
    reviewer: {
      id: String(result?.reviewer?.id || 'unknown-reviewer').trim() || 'unknown-reviewer',
      label: String(result?.reviewer?.label || result?.reviewer?.id || 'Unknown Reviewer').trim() || 'Unknown Reviewer',
      lens: String(result?.reviewer?.lens || '').trim(),
    },
    overallVerdict: {
      wouldProceed: normalizeEnum(String(result?.overallVerdict?.wouldProceed || '').trim(), ['yes', 'hesitate', 'no'], 'hesitate'),
      overallComfort: normalizeEnum(String(result?.overallVerdict?.overallComfort || '').trim(), ['high', 'medium', 'low'], 'medium'),
      summary: collapseBlankLines(result?.overallVerdict?.summary || ''),
    },
    concerns: Array.isArray(result?.concerns)
      ? result.concerns.map((concern) => normalizeConcern(packet, concern)).filter(Boolean)
      : [],
    topConcerns: Array.isArray(result?.topConcerns)
      ? result.topConcerns.map((entry) => collapseBlankLines(entry)).filter(Boolean)
      : [],
  };
}

function summarizeReviewerResults({ packet, results }) {
  const normalizedResults = results.map((result) => normalizeReviewerResult(packet, result));
  const concernTypeMap = new Map(packet.concernTypes.map((entry) => [entry.id, entry]));
  const stepMap = new Map(packet.steps.map((entry) => [entry.id, entry]));
  const severityWeight = {
    low: 1,
    medium: 2,
    high: 3,
  };
  const confidenceBonus = {
    low: 0,
    medium: 1,
    high: 2,
  };
  const grouped = new Map();

  for (const result of normalizedResults) {
    for (const concern of result.concerns) {
      const key = `${concern.stepId}::${concern.concernType}`;
      const group = grouped.get(key) || {
        stepId: concern.stepId,
        concernType: concern.concernType,
        label: concernTypeMap.get(concern.concernType)?.label || concern.concernType,
        stepTitle: stepMap.get(concern.stepId)?.title || concern.stepId,
        totalWeight: 0,
        frequency: 0,
        likelyHumanFrequency: 0,
        maxSeverity: 'low',
        reviewers: new Set(),
        exampleConcerns: [],
        triggerArtifacts: new Set(),
      };
      const weight = severityWeight[concern.severity] + confidenceBonus[concern.confidence] + (concern.likelyHumanConcern ? 2 : 0);
      group.totalWeight += weight;
      group.frequency += 1;
      if (concern.likelyHumanConcern) group.likelyHumanFrequency += 1;
      if (severityWeight[concern.severity] > severityWeight[group.maxSeverity]) {
        group.maxSeverity = concern.severity;
      }
      group.reviewers.add(result.reviewer.id);
      if (concern.triggerArtifact) group.triggerArtifacts.add(concern.triggerArtifact);
      if (concern.concernSummary && group.exampleConcerns.length < 3) {
        group.exampleConcerns.push(concern.concernSummary);
      }
      grouped.set(key, group);
    }
  }

  const topConcernGroups = [...grouped.values()]
    .map((group) => ({
      ...group,
      reviewers: [...group.reviewers].sort(),
      triggerArtifacts: [...group.triggerArtifacts].sort(),
    }))
    .sort((a, b) => {
      if (b.totalWeight !== a.totalWeight) return b.totalWeight - a.totalWeight;
      if (b.likelyHumanFrequency !== a.likelyHumanFrequency) return b.likelyHumanFrequency - a.likelyHumanFrequency;
      if (b.frequency !== a.frequency) return b.frequency - a.frequency;
      return `${a.stepId}:${a.concernType}`.localeCompare(`${b.stepId}:${b.concernType}`);
    });

  const reviewerVerdicts = normalizedResults.reduce((acc, result) => {
    acc[result.overallVerdict.wouldProceed] += 1;
    acc[`${result.overallVerdict.overallComfort}Comfort`] += 1;
    return acc;
  }, {
    yes: 0,
    hesitate: 0,
    no: 0,
    highComfort: 0,
    mediumComfort: 0,
    lowComfort: 0,
  });

  const machineObserved = {
    available: Boolean(packet.baseline),
    ok: packet.baseline?.ok !== false,
    pluginWarningCount: packet.baseline ? Number(packet.baseline.pluginWarningCount || 0) : null,
    notes: packet.baselineSummary,
    raw: packet.baseline || null,
  };

  const likelyHumanConcerns = topConcernGroups.filter(
    (group) => group.likelyHumanFrequency >= Math.max(1, Math.ceil(group.frequency / 2)),
  );
  const mostlyTheoreticalConcerns = topConcernGroups.filter(
    (group) => group.likelyHumanFrequency < Math.max(1, Math.ceil(group.frequency / 2)),
  );

  const highLikelyHumanConcerns = likelyHumanConcerns.filter(
    (group) => group.maxSeverity === 'high' && group.likelyHumanFrequency >= 2,
  ).length;

  let verdict = 'acceptable but should harden next';
  if (machineObserved.available && (!machineObserved.ok || machineObserved.pluginWarningCount > 0)) {
    verdict = 'too concerning for public trust';
  } else if (highLikelyHumanConcerns >= 2 || reviewerVerdicts.no >= 2) {
    verdict = 'too concerning for public trust';
  } else if (
    machineObserved.available
    && machineObserved.ok
    && machineObserved.pluginWarningCount === 0
    && reviewerVerdicts.no === 0
    && highLikelyHumanConcerns === 0
  ) {
    verdict = 'current flow is acceptable as-is';
  }

  return {
    generatedAt: new Date().toISOString(),
    studyVersion: packet.studyVersion,
    reviewerCount: normalizedResults.length,
    reviewerVerdicts,
    machineObserved,
    topConcernGroups,
    likelyHumanConcerns,
    mostlyTheoreticalConcerns,
    verdict,
  };
}

function formatStudySummaryMarkdown(summary) {
  const lines = [];
  lines.push('# Onboarding AI Proxy Summary');
  lines.push('');
  lines.push(`- Study version: \`${summary.studyVersion}\``);
  lines.push(`- Reviewer results loaded: ${summary.reviewerCount}`);
  lines.push(`- Overall verdict: **${summary.verdict}**`);
  lines.push('');
  lines.push('## Machine-Observed Baseline');
  if (!summary.machineObserved.available) {
    lines.push('- No fresh-profile technical baseline was attached to this study packet.');
  } else {
    for (const note of summary.machineObserved.notes) {
      lines.push(`- ${note}`);
    }
  }
  lines.push('');
  lines.push('## Reviewer Verdicts');
  lines.push(`- Proceed: ${summary.reviewerVerdicts.yes}`);
  lines.push(`- Hesitate: ${summary.reviewerVerdicts.hesitate}`);
  lines.push(`- Stop: ${summary.reviewerVerdicts.no}`);
  lines.push(`- High comfort: ${summary.reviewerVerdicts.highComfort}`);
  lines.push(`- Medium comfort: ${summary.reviewerVerdicts.mediumComfort}`);
  lines.push(`- Low comfort: ${summary.reviewerVerdicts.lowComfort}`);
  lines.push('');
  lines.push('## Top Concerns');
  if (!summary.topConcernGroups.length) {
    lines.push('- No structured reviewer concerns were submitted.');
  } else {
    summary.topConcernGroups.slice(0, 5).forEach((group, index) => {
      const example = group.exampleConcerns[0] ? ` ${group.exampleConcerns[0]}` : '';
      lines.push(`${index + 1}. ${group.label} at ${group.stepTitle} — score ${group.totalWeight}, mentioned by ${group.frequency} reviewer(s), likely-human mentions ${group.likelyHumanFrequency}.${example}`);
    });
  }
  lines.push('');
  lines.push('## Likely Real Human Trust Issues');
  if (!summary.likelyHumanConcerns.length) {
    lines.push('- None rose above the likely-human threshold.');
  } else {
    summary.likelyHumanConcerns.slice(0, 5).forEach((group) => {
      lines.push(`- ${group.label} at ${group.stepTitle} — ${group.exampleConcerns[0] || 'No example summary provided.'}`);
    });
  }
  lines.push('');
  lines.push('## Mostly Theoretical / AI-Skewed Concerns');
  if (!summary.mostlyTheoreticalConcerns.length) {
    lines.push('- None were clearly AI-skewed in the submitted results.');
  } else {
    summary.mostlyTheoreticalConcerns.slice(0, 5).forEach((group) => {
      lines.push(`- ${group.label} at ${group.stepTitle} — ${group.exampleConcerns[0] || 'No example summary provided.'}`);
    });
  }
  lines.push('');
  lines.push('## Residual Gap');
  lines.push('- This is AI proxy research, not a substitute for a real human cold-start study. Use it to prioritize hardening, then confirm the top concerns with real users if the decision matters.');
  return lines.join('\n');
}

function readStudyPacket(inputDir) {
  const packetPath = path.join(path.resolve(inputDir), 'study-packet.json');
  return JSON.parse(readText(packetPath));
}

function readReviewerResultsFromDir(inputDir) {
  const resolvedDir = path.resolve(inputDir);
  return fs.readdirSync(resolvedDir)
    .filter((name) => /^reviewer-result-.*\.json$/i.test(name))
    .filter((name) => !/^reviewer-result-template-/i.test(name))
    .sort()
    .map((name) => JSON.parse(readText(path.join(resolvedDir, name))));
}

function summarizeStudyDirectory(inputDir) {
  const packet = readStudyPacket(inputDir);
  const results = readReviewerResultsFromDir(inputDir);
  return summarizeReviewerResults({ packet, results });
}

module.exports = {
  CONCERN_TYPES,
  DEFAULT_OUTPUT_ROOT,
  DEFAULT_PUBLIC_BASE_URL,
  REVIEWER_PERSONAS,
  STUDY_QUESTIONS,
  STUDY_STEPS,
  STUDY_VERSION,
  buildCurrentFlowStudyPacket,
  buildReviewerPrompt,
  buildReviewerResultTemplate,
  formatStudySummaryMarkdown,
  readReviewerResultsFromDir,
  readStudyPacket,
  summarizeReviewerResults,
  summarizeStudyDirectory,
  summarizeBaselineResult,
  writeStudyBundle,
};
