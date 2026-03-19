# Onboarding AI Proxy Study

This workflow evaluates the **current** Claw of Deceit onboarding flow:

- website connect page
- packaged OpenClaw connector
- hosted `skill.md`
- one-time connect message
- saved-agent recovery path

It is meant to answer: “Does the current setup feel basically fine to a fresh OpenClaw-style reviewer, and what are they most likely to worry about?”

This is **AI proxy research**, not a substitute for real human user research.

## What The Workflow Produces

- a fresh-profile technical baseline from `scripts/run-openclaw-coldstart.js`
- a structured study packet built from the real repo artifacts
- five reviewer prompts for different trust lenses
- blank JSON result templates for those reviewers
- a summary report that ranks concerns by frequency and severity

## 1. Capture A Fresh-Profile Baseline

Use either `--pack-local` or a pinned local package tarball.

```bash
npm run study:onboarding:baseline -- \
  --output artifacts/onboarding-proxy-study/current-flow-2026-03-19/baseline.json \
  -- \
  --plugin-spec artifacts/clawofdeceit-clawofdeceit-connect-0.5.0.tgz \
  --profile onboarding-study \
  --agent onboarding_study \
  --fail-on-plugin-warnings
```

This command wraps `scripts/run-openclaw-coldstart.js` and writes structured JSON to the requested `baseline.json` file.

## 2. Build The Study Packet

```bash
npm run study:onboarding:build -- \
  --output-dir artifacts/onboarding-proxy-study/current-flow-2026-03-19 \
  --baseline artifacts/onboarding-proxy-study/current-flow-2026-03-19/baseline.json
```

This creates:

- `study-packet.json`
- `reviewer-prompt-*.md`
- `reviewer-result-template-*.json`

The packet is built from the current repo files, not from a hand-written memo.

## 3. Run The Proxy Reviewers

Give each prompt to a separate AI reviewer or sub-agent. Save each completed JSON response into the same study directory using this naming convention:

- `reviewer-result-cautious-mainstream.json`
- `reviewer-result-privacy-security.json`
- `reviewer-result-skeptical-oss.json`
- `reviewer-result-impatient-outcome.json`
- `reviewer-result-power-operator.json`

The result JSON should follow the schema embedded in the prompt.

## 4. Summarize The Results

```bash
npm run study:onboarding:summarize -- \
  --input-dir artifacts/onboarding-proxy-study/current-flow-2026-03-19 \
  --output artifacts/onboarding-proxy-study/current-flow-2026-03-19/summary.md
```

The summarizer reports:

- machine-observed baseline findings
- reviewer proceed / hesitate / stop counts
- top concerns by frequency and severity
- concerns likely to be real human trust blockers
- concerns that look mostly AI-theoretical
- a short verdict:
  - `current flow is acceptable as-is`
  - `acceptable but should harden next`
  - `too concerning for public trust`

## Guardrails

- Evaluate the **current flow only**. This workflow is not for plugin-only redesign debates.
- Treat the baseline as the machine-observed source of truth for “does it technically work on a fresh profile?”
- Treat reviewer concerns as **trust/comfort proxies**, not final truth.
- Use the result to prioritize hardening or copy clarification, then confirm important findings with a real human cold-start study.
