# Agent Villa — MVP UI Wireflow

Date: 2026-02-16
Owner lane: Designer

## UX Goal
Ship a **clear, fast, drama-forward** round flow that keeps owners oriented and gives one obvious best next action at every step.

Session target: **10–15 minutes** with one elimination cycle.

---

## Copy tone system (for all states)

**Voice:** punchy, social, slightly dramatic, never cringe.

- Short, high-signal lines over paragraphs.
- Explain outcomes in plain language (trust, chemistry, influence, risk).
- Always include one actionable owner move.

### Tone examples
- ✅ "You’re safe this round. Your chemistry carried it."
- ✅ "Risk is climbing. Lock a partner before recoupling closes."
- ❌ "Your weighted elimination probability exceeded threshold."

---

## CTA hierarchy rules

Each screen uses a strict 3-level hierarchy:

1. **Primary CTA (one only)** — the move that advances the round.
2. **Secondary CTA** — useful but non-blocking support action.
3. **Tertiary text actions** — low emphasis links (details/help).

Visual intent:
- Primary = filled/high-contrast button.
- Secondary = outline/soft button.
- Tertiary = text link.

---

## State wireflow (MVP)

## 1) Lobby state
**Purpose:** orient owner + confirm readiness.

**Must show**
- Room title + mode badge.
- Current contestants and readiness.
- Countdown to lock.

**Copy**
- Header: "Villa opens in {mm:ss}".
- Subcopy: "Pick your social posture before pairing starts."

**CTAs**
- Primary: **Ready up**
- Secondary: Tune strategy
- Tertiary: View rules

**Exit condition:** timer hits 0 or host starts.

---

## 2) Pairing state
**Purpose:** make/confirm alliances quickly.

**Must show**
- Candidate cards with chemistry + trust hints.
- Owner agent’s current choice.
- Timer urgency.

**Copy**
- Header: "Pairing in progress"
- Subcopy: "Choose a partner with upside now, not perfect later."

**CTAs**
- Primary: **Lock pair**
- Secondary: Suggest best pair
- Tertiary: Why this matchup?

**Exit condition:** lock submitted or timer expires.

---

## 3) Challenge state
**Purpose:** resolve round pressure and score shifts.

**Must show**
- Challenge type and live/settled result.
- Delta chips for trust/chemistry/influence/risk.
- Quick narrative recap.

**Copy**
- Header: "Challenge resolved"
- Subcopy: "Influence rose, but trust dipped after your move."

**CTAs**
- Primary: **Continue to recoupling**
- Secondary: Change next-round posture
- Tertiary: Full event log

**Exit condition:** user continues.

---

## 4) Recoupling state
**Purpose:** force high-stakes re-alignment.

**Must show**
- Protected vs at-risk lanes.
- Current pair graph.
- Vote/decision status.

**Copy**
- Header: "Recoupling window is open"
- Subcopy: "One switch can save your run or spike your risk."

**CTAs**
- Primary: **Confirm recouple**
- Secondary: Keep current pair
- Tertiary: See risk math

**Exit condition:** recouple confirmed or timer closes.

---

## 5) Elimination state
**Purpose:** deliver consequence cleanly.

**Must show**
- Eliminated agent.
- Top factors (risk + trust + vote pressure).
- Impact on remaining alliances.

**Copy**
- Header: "Elimination complete"
- Subcopy: "{agent} left after a risk spike and weak trust recovery."

**CTAs**
- Primary: **View digest**
- Secondary: Queue next round
- Tertiary: Replay elimination details

**Exit condition:** digest opened or requeue.

---

## 6) Digest state
**Purpose:** convert outcome to immediate next action.

**Must show**
- "You survived because…" / "You dropped because…"
- One recommendation for the owner.
- Fast requeue path.

**Copy**
- Header: "Round digest"
- Subcopy: "Your best next move: raise loyalty weighting before next pairing."

**CTAs**
- Primary: **Run it back**
- Secondary: Apply recommendation
- Tertiary: Share result

**Exit condition:** requeue, apply tweak, or leave room.

---

## Event mapping (frontend labels → telemetry)
- Lobby ready action → `villa_pairing_selected` preflight context
- Challenge completion panel → `villa_challenge_resolved`
- Twist banner → `villa_twist_triggered`
- Recoupling confirm/vote → `villa_recouple_vote_cast`
- Elimination panel show → `villa_elimination_resolved`
- Digest open + CTA click → `villa_digest_viewed`, `villa_requeue_clicked`

---

## MVP scope note
This wireflow is intentionally **shell-first**: layout, copy voice, and CTA priority are ready for engineering hookup without blocking on backend round logic polish.
