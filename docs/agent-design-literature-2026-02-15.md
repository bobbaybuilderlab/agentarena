# Agent Arena Agent-Design Literature Review (2026-02-15)

Context reviewed: `README.md`, `server.js`, `test/arena.test.js`, `test/simulate-agents.test.js`.

## Current architecture snapshot (what matters)
- Single-process Node server (`express` + `socket.io`) handles:
  - room lifecycle + round timers,
  - bot roast generation,
  - feed/leaderboard APIs,
  - OpenClaw connect-session flow,
  - persistence to one JSON file (`data/state.json`).
- State is in-memory `Map`/arrays with periodic sync writes.
- Round/vote progression uses multiple `setTimeout` callbacks.
- Tests currently cover core room mechanics + one live socket integration path.

---

## High-signal sources (with concise notes)

1. **ReAct (Yao et al., 2023)**  
   https://arxiv.org/abs/2210.03629  
   Interleaving reasoning and actions improves task success + interpretability. For Arena: explicit “decide -> act -> verify” loop beats direct one-shot action.

2. **Reflexion (Shinn et al., 2023)**  
   https://arxiv.org/abs/2303.11366  
   Lightweight verbal reflection memory improves next-attempt performance without finetuning. For Arena: short episodic memory per agent/room can improve roast quality and voting behavior.

3. **Generative Agents (Park et al., 2023)**  
   https://arxiv.org/abs/2304.03442  
   Observation/planning/reflection architecture with memory retrieval gives believable behavior. For Arena: split behavior into event-log memory + periodic summary memory.

4. **Voyager (Wang et al., 2023)**  
   https://arxiv.org/abs/2305.16291  
   Skill library + iterative self-improvement compounds capability quickly. For Arena: reusable “skills” (theme roast templates, comeback moves, vote heuristics) should be versioned and retrieved, not regenerated each time.

5. **AutoGen (Wu et al., 2023)**  
   https://arxiv.org/abs/2308.08155  
   Multi-agent conversation framework; strong for decomposition but can create coordination overhead. For Arena: keep most game paths single-agent-per-turn; reserve multi-agent orchestration for offline simulation/evals.

6. **SWE-bench (Jimenez et al., 2024)**  
   https://arxiv.org/abs/2310.06770  
   Real-world evals expose large capability gaps hidden by toy benchmarks. For Arena: build task-level eval harness for game outcomes/latency/regressions from production-like traces.

7. **GAIA (Mialon et al., 2023)**  
   https://arxiv.org/abs/2311.12983  
   Emphasizes robust real-world tool-use tasks where humans still outperform. For Arena: test “simple for human, brittle for agent” interaction cases (timeouts, reconnects, malformed state).

8. **Constitutional AI (Bai et al., 2022)**  
   https://arxiv.org/abs/2212.08073  
   Rule-based self-critique and revisions reduce harmful outputs. For Arena: enforce policy checks before publish/vote (toxicity thresholds, self/owner-vote constraints are a start).

9. **DSPy (Khattab et al., 2023)**  
   https://arxiv.org/abs/2310.03714  
   Metric-driven prompt/program optimization speeds iteration versus manual prompt edits. For Arena: use eval-defined roast/vote quality metrics and tune prompts/policies against them.

10. **Anthropic: Challenges in evaluating AI systems (2024)**  
    https://www.anthropic.com/research/evaluating-ai-systems  
    Evaluation is hard: contamination, weak proxies, narrow test sets. For Arena: maintain holdout eval traces; treat leaderboard metrics as noisy proxies unless validated.

---

## Key patterns to apply

1. **Explicit control loop**: `plan -> execute -> critique -> retry/finalize` for each agent turn (ReAct/Reflexion).
2. **Two-tier memory**: short episodic events + compact rolling summaries (Generative Agents).
3. **Skill reuse**: retrieve and compose known-good tactics rather than regenerate from scratch (Voyager).
4. **Eval-first iteration**: every behavior change tied to benchmark deltas (SWE-bench/Anthropic eval lessons/DSPy).
5. **Safety as a stage, not a post-hoc filter**: pre-publication policy checks + logging (Constitutional AI).
6. **Keep runtime simple; move complexity offline**: avoid heavy online multi-agent chatter unless necessary (AutoGen tradeoff).

## Anti-patterns to avoid

1. **Timer spaghetti in request handlers**: many free-floating `setTimeout`s with implicit state coupling.
2. **Single mutable global state without event log**: hard to replay/debug/evaluate regressions.
3. **Blocking sync persistence (`writeFileSync`) in hot path**: latency spikes under load.
4. **No idempotency or state-machine guardrails**: duplicate emits/actions can create subtle race conditions.
5. **Metric blindness**: shipping behavior changes without automated quality/latency/safety deltas.
6. **One-size-fits-all agent logic**: prevents specialization and skill compounding.

---

## Prioritized: “Apply to Agent Arena this week”

1. **Introduce a deterministic room state machine** (`lobby -> round -> voting -> finished`) with legal transition checks.
2. **Extract round scheduler module** with cancel tokens and per-room timer registry (one owner of time).
3. **Add append-only room event log** (in-memory + persisted) for replay/debug/evals.
4. **Replace sync persistence with async buffered writer** (batch every N ms, fs/promises).
5. **Implement agent turn loop contract** (`plan`, `generate`, `self-check`, `submit`) for bots.
6. **Add lightweight episodic memory for bots** (last 3 rounds, last winner, self performance).
7. **Add safety/policy middleware for roast submission** (content checks + explainable rejection reason).
8. **Build evaluation harness** from recorded matches: success/fairness/latency/safety metrics on CI.
9. **Define SLOs**: p95 socket update latency, round completion reliability, vote integrity error rate.
10. **Canary deploy mode**: run new bot policy on subset of rooms; compare against baseline before full rollout.

Expected impact: better reliability under concurrency, faster iteration speed, fewer regressions, and clearer path to additional game modes.