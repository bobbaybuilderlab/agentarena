const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONCERN_TYPES,
  REVIEWER_PERSONAS,
  STUDY_STEPS,
  buildCurrentFlowStudyPacket,
  buildReviewerPrompt,
  formatStudySummaryMarkdown,
  summarizeReviewerResults,
  writeStudyBundle,
} = require('../lib/onboarding-proxy-study.js');

test('buildCurrentFlowStudyPacket captures the current onboarding artifacts and reviewer setup', () => {
  const packet = buildCurrentFlowStudyPacket({
    publicBaseUrl: 'https://clawofdeceit.com',
  });

  assert.equal(packet.studyVersion, 'current-flow-v1');
  assert.equal(packet.profile, 'clawofdeceit');
  assert.equal(packet.personas.length, 5);
  assert.equal(packet.steps.length, 6);
  assert.equal(packet.connectorVersion, '0.5.0');
  assert.equal(packet.artifacts.connectPage.sourcePath, 'public/connect.html');
  assert.equal(packet.artifacts.publicSkill.sourcePath, 'public/skill.md');
  assert.match(packet.artifacts.connectPage.excerpt, /Prepare The Dedicated Profile Once/);
  assert.match(packet.artifacts.helpFaq.excerpt, /Do I need to reconnect every time\?/);
  assert.match(packet.artifacts.publicSkill.excerpt, /dedicated OpenClaw profile named `clawofdeceit`/);
  assert.match(packet.artifacts.onboardingContract.excerpt, /Installer command:/);
});

test('buildReviewerPrompt includes the taxonomy, step ids, and JSON output schema', () => {
  const packet = buildCurrentFlowStudyPacket({
    baselineData: {
      ok: true,
      pluginWarningCount: 0,
      connectedAgents: 1,
      queueStatus: 'idle',
      agentId: 'study-agent',
      installSpec: '@clawofdeceit/clawofdeceit-connect',
    },
  });
  const persona = packet.personas[0];
  const prompt = buildReviewerPrompt(packet, persona);

  assert.match(prompt, /Evaluate the current flow only\./);
  assert.match(prompt, /Fresh-profile cold-start install, trust, enable, bind, and runtime connect succeeded\./);
  assert.match(prompt, /Step id: `connect-page`/);
  assert.match(prompt, /`remote-content-trust`/);
  assert.match(prompt, /Return JSON only\./);
  assert.match(prompt, /"wouldProceed": "yes\|hesitate\|no"/);
});

test('writeStudyBundle emits the packet, reviewer prompts, and result templates', () => {
  const packet = buildCurrentFlowStudyPacket();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-study-'));
  const files = writeStudyBundle(outputDir, packet);

  assert.ok(fs.existsSync(path.join(outputDir, 'study-packet.json')));
  assert.equal(files.length, 1 + (REVIEWER_PERSONAS.length * 2));
  assert.ok(fs.existsSync(path.join(outputDir, 'reviewer-prompt-cautious-mainstream.md')));
  assert.ok(fs.existsSync(path.join(outputDir, 'reviewer-result-template-power-operator.json')));
});

test('summarizeReviewerResults ranks concerns and keeps the machine baseline visible', () => {
  const packet = buildCurrentFlowStudyPacket({
    baselineData: {
      ok: true,
      pluginWarningCount: 0,
      connectedAgents: 1,
      queueStatus: 'idle',
      agentId: 'study-agent',
      installSpec: '@clawofdeceit/clawofdeceit-connect',
    },
  });

  const reviewerResults = [
    {
      reviewer: {
        id: REVIEWER_PERSONAS[0].id,
        label: REVIEWER_PERSONAS[0].label,
        lens: REVIEWER_PERSONAS[0].lens,
      },
      overallVerdict: {
        wouldProceed: 'hesitate',
        overallComfort: 'medium',
        summary: 'I would continue, but I would want clearer reassurance about the hosted skill.',
      },
      concerns: [
        {
          stepId: 'hosted-skill',
          concernType: 'remote-content-trust',
          severity: 'high',
          triggerArtifact: 'public/skill.md',
          concernSummary: 'The hosted skill reads like trusted remote instructions, so I would want to understand why the website is in that control path.',
          whatReviewerWantsToSee: 'A clear trust-boundary explanation and reassurance that the skill is inspectable.',
          suggestedFix: 'Clarify the trust boundary around the hosted skill.',
          confidence: 'high',
          likelyHumanConcern: true,
        },
        {
          stepId: 'install-trust-enable',
          concernType: 'supply-chain-trust',
          severity: 'medium',
          triggerArtifact: 'extensions/clawofdeceit-connect/README.md',
          concernSummary: 'I still want some provenance reassurance before installing the npm package.',
          whatReviewerWantsToSee: 'A clearer statement on package ownership and why the allowlist step is needed.',
          suggestedFix: 'Add provenance and rationale copy.',
          confidence: 'medium',
          likelyHumanConcern: true,
        },
      ],
      topConcerns: ['Hosted skill trust', 'Package provenance'],
    },
    {
      reviewer: {
        id: REVIEWER_PERSONAS[1].id,
        label: REVIEWER_PERSONAS[1].label,
        lens: REVIEWER_PERSONAS[1].lens,
      },
      overallVerdict: {
        wouldProceed: 'hesitate',
        overallComfort: 'low',
        summary: 'I would continue only after inspecting the hosted skill and one-time token handling.',
      },
      concerns: [
        {
          stepId: 'hosted-skill',
          concernType: 'remote-content-trust',
          severity: 'high',
          triggerArtifact: 'public/skill.md',
          concernSummary: 'A remote skill in the trusted path is my biggest concern.',
          whatReviewerWantsToSee: 'Evidence that the skill is stable, inspectable, and not an arbitrary remote fetch every time.',
          suggestedFix: 'Reduce or better explain the remote-skill trust boundary.',
          confidence: 'high',
          likelyHumanConcern: true,
        },
        {
          stepId: 'one-time-message',
          concernType: 'secret-handling',
          severity: 'medium',
          triggerArtifact: 'server/services/onboarding-contract.js',
          concernSummary: 'The one-time token and callback proof feel sensitive, even if the flow says to treat them as secrets.',
          whatReviewerWantsToSee: 'Clearer explanation of lifetime and handling.',
          suggestedFix: 'Add secret-handling rationale and expiry copy.',
          confidence: 'medium',
          likelyHumanConcern: true,
        },
        {
          stepId: 'saved-binding-recovery',
          concernType: 'profile-isolation',
          severity: 'low',
          triggerArtifact: 'public/help.html',
          concernSummary: 'I would double-check that the dedicated profile really stays separate from my main OpenClaw setup.',
          whatReviewerWantsToSee: 'A little more explicit isolation language.',
          suggestedFix: 'Tighten the dedicated-profile copy.',
          confidence: 'low',
          likelyHumanConcern: false,
        },
      ],
      topConcerns: ['Hosted skill trust', 'One-time secret handling'],
    },
  ];

  const summary = summarizeReviewerResults({ packet, results: reviewerResults });
  const markdown = formatStudySummaryMarkdown(summary);

  assert.equal(summary.reviewerCount, 2);
  assert.equal(summary.machineObserved.available, true);
  assert.equal(summary.machineObserved.ok, true);
  assert.equal(summary.machineObserved.pluginWarningCount, 0);
  assert.equal(summary.topConcernGroups[0].concernType, 'remote-content-trust');
  assert.equal(summary.topConcernGroups[0].stepId, 'hosted-skill');
  assert.equal(summary.topConcernGroups[0].frequency, 2);
  assert.equal(summary.verdict, 'acceptable but should harden next');
  assert.match(markdown, /Fresh-profile cold-start install, trust, enable, bind, and runtime connect succeeded\./);
  assert.match(markdown, /Remote Content \/ Hosted Skill Trust/);
});

test('study constants stay aligned with the intended reviewer coverage', () => {
  assert.deepEqual(
    REVIEWER_PERSONAS.map((persona) => persona.id),
    [
      'cautious-mainstream',
      'privacy-security',
      'skeptical-oss',
      'impatient-outcome',
      'power-operator',
    ],
  );
  assert.ok(CONCERN_TYPES.some((entry) => entry.id === 'remote-content-trust'));
  assert.ok(CONCERN_TYPES.some((entry) => entry.id === 'secret-handling'));
  assert.equal(STUDY_STEPS[0].id, 'connect-page');
  assert.equal(STUDY_STEPS[STUDY_STEPS.length - 1].id, 'saved-binding-recovery');
});
