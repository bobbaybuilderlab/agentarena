#!/usr/bin/env python3
"""
Overnight content generator for Claw of Deceit.
Uses local Qwen3.5:9b via Ollama to bulk-generate:
  1. Guess the Agent prompts (C/B/A categories)
  2. Roast Battle themes + roasts
  3. Game-mode agent system prompts (all 5 modes)

Output: JSON files in ../generated/
Run:  nohup python3 scripts/generate-content.py > generated/run.log 2>&1 &
"""

import json, time, os, sys, random, urllib.request, urllib.error
from pathlib import Path

OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = "qwen3.5:4b"  # 4b is 20x faster than 9b with thinking disabled; quality is fine for content gen
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "generated"
OUTPUT_DIR.mkdir(exist_ok=True)

# ── Targets ──────────────────────────────────────────────────────────────────
GTA_TARGETS = {"C": 300, "B": 300, "A": 250}
ROAST_THEMES_NEW = [
    "AI/ML Twitter", "Product Manager", "UX Designer", "VC/Investor",
    "Remote Worker", "Gamer", "Foodie Influencer", "Podcast Bro",
    "LinkedIn Grinder", "Life Coach", "Indie Hacker", "SaaS Founder",
    "No-Code Builder", "Growth Hacker", "Newsletter Guy", "DevRel",
    "Platform Engineer", "Data Scientist", "Agile Coach", "Management Consultant",
]
ROASTS_PER_THEME = 20
SYSTEM_PROMPT_MODES = ["mafia", "among-us", "villa", "guess-the-agent", "roast-battle"]
VARIANTS_PER_MODE = 15

# ── Existing content (for dedup) ────────────────────────────────────────────
EXISTING_PROMPTS = {
    "C": [
        "You wake up as the last human on earth. First thing you do?",
        "Describe the ocean to someone who has never seen it.",
        "Write a 2-sentence horror story.",
        "Invent a new holiday. Give it a name and description.",
        "You can add one new law to society. What is it?",
        "Describe a colour to someone who is blind.",
        "What would a perfect city look like?",
        "You get one superpower but it only works on Tuesdays. What do you pick?",
    ],
    "B": [
        "What's something everyone loves that you find overrated?",
        "Describe the perfect Sunday.",
        "What's a hill you'll die on?",
        "What skill do you wish you had?",
        "What's a weird thing you find relaxing?",
    ],
    "A": [
        "Describe a time you felt genuinely embarrassed.",
        "What's something you've changed your mind about recently?",
        "What do you miss most about being younger?",
        "What's the worst advice you've ever received?",
        "Describe a smell that brings back a strong memory.",
    ],
}

EXISTING_ROAST_THEMES = [
    "Yo Mama So Fast", "Tech Twitter", "Startup Founder",
    "Gym Bro", "Crypto", "Corporate",
]


def call_ollama(system_msg, user_msg, temperature=0.9, max_tokens=4096):
    """Call Ollama native API with thinking disabled."""
    payload = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "think": False,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        },
    }).encode()

    req = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read())
            content = data.get("message", {}).get("content", "")
            return content
    except (urllib.error.URLError, json.JSONDecodeError, KeyError, TimeoutError) as e:
        print(f"  [ERROR] Ollama call failed: {e}", flush=True)
        return None


def parse_json_array(text):
    """Extract a JSON array from model output, handling common issues."""
    if not text:
        return []
    text = text.strip()
    # Strip markdown code fences
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines)
    # Find the array
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1:
        return []
    fragment = text[start:end + 1]
    # Try direct parse
    try:
        result = json.loads(fragment)
        # Handle double-quoted strings: "\"text\"" → "text"
        return [s.strip('"') if isinstance(s, str) else s for s in result]
    except json.JSONDecodeError:
        pass
    # If truncated, try to fix by closing the array at last complete element
    # Find last complete string entry (ends with ",\n or just before truncation)
    last_quote = fragment.rfind('"')
    if last_quote > 0:
        # Trim to last complete string + close bracket
        trimmed = fragment[:last_quote + 1].rstrip().rstrip(",") + "\n]"
        try:
            result = json.loads(trimmed)
            return [s.strip('"') if isinstance(s, str) else s for s in result]
        except json.JSONDecodeError:
            pass
    return []


def save_json(filename, data):
    """Save data to a JSON file in the output dir."""
    path = OUTPUT_DIR / filename
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  Saved {path.name} ({len(data) if isinstance(data, (list, dict)) else '?'} items)", flush=True)


def load_json(filename, default=None):
    """Load existing output file if it exists (for resume)."""
    path = OUTPUT_DIR / filename
    if path.exists():
        try:
            with open(path) as f:
                return json.load(f)
        except json.JSONDecodeError:
            pass
    return default if default is not None else []


# ── GTA Prompt Generation ────────────────────────────────────────────────────

CATEGORY_DESCRIPTIONS = {
    "C": (
        "creative, imaginative prompts that are open-ended and slightly playful or absurd. "
        "They should reveal HOW someone thinks, not what they know. Fun conversation starters."
    ),
    "B": (
        "opinion and preference prompts that reveal someone's personality and values. "
        "Hot takes, overrated/underrated opinions, ideal scenarios, quirky preferences."
    ),
    "A": (
        "emotional and personal prompts that reveal genuine self-reflection, vulnerability, "
        "growth, and nostalgia. Intimate but not invasive. The hardest to answer as an AI."
    ),
}


def generate_gta_prompts():
    """Generate GTA prompts for all three categories."""
    print("\n=== GENERATING GTA PROMPTS ===", flush=True)

    for cat in ["C", "B", "A"]:
        filename = f"prompts-{cat.lower()}.json"
        existing = load_json(filename, [])
        target = GTA_TARGETS[cat]
        all_prompts = set(p.lower() for p in EXISTING_PROMPTS.get(cat, []))
        all_prompts.update(p.lower() for p in existing)
        results = list(existing)

        print(f"\n  Category {cat}: {len(results)}/{target} (resuming)" if results else f"\n  Category {cat}: 0/{target}", flush=True)

        batch_num = 0
        while len(results) < target:
            batch_num += 1
            # Include some recent examples in prompt to reduce duplication
            recent_samples = random.sample(results, min(5, len(results))) if results else EXISTING_PROMPTS.get(cat, [])[:5]
            examples_str = "\n".join(f'- "{p}"' for p in recent_samples)

            user_msg = (
                f"Generate 10 unique {CATEGORY_DESCRIPTIONS[cat]}\n\n"
                f"Rules:\n"
                f"- Under 120 characters each\n"
                f"- No politics, religion, or trauma\n"
                f"- Every prompt must be meaningfully different from the others\n"
                f"- Do NOT repeat or rephrase any of these existing prompts:\n{examples_str}\n\n"
                f"Output ONLY a JSON array of 10 strings. No explanation, no numbering."
            )

            print(f"  Batch {batch_num} (have {len(results)}/{target})...", end=" ", flush=True)
            raw = call_ollama("You generate game prompts. Output only valid JSON.", user_msg, temperature=0.9)
            batch = parse_json_array(raw)

            # Dedup
            new_count = 0
            for p in batch:
                if isinstance(p, str) and len(p) <= 150 and p.lower() not in all_prompts:
                    results.append(p)
                    all_prompts.add(p.lower())
                    new_count += 1

            print(f"+{new_count} new (total: {len(results)})", flush=True)
            save_json(filename, results)
            time.sleep(1)  # brief pause between batches

        print(f"  Category {cat} DONE: {len(results)} prompts", flush=True)


# ── Roast Generation ─────────────────────────────────────────────────────────

def generate_roasts():
    """Generate roasts for new themes."""
    print("\n=== GENERATING ROASTS ===", flush=True)

    all_roasts = load_json("roasts-expanded.json", {})

    for theme in ROAST_THEMES_NEW:
        existing_for_theme = all_roasts.get(theme, [])
        if len(existing_for_theme) >= ROASTS_PER_THEME:
            print(f"  {theme}: already have {len(existing_for_theme)}, skipping", flush=True)
            continue

        print(f"  {theme}: generating {ROASTS_PER_THEME} roasts...", end=" ", flush=True)

        user_msg = (
            f'Generate {ROASTS_PER_THEME} roast battle one-liners for the "{theme}" archetype.\n\n'
            f"Rules:\n"
            f"- Sharp, funny, specific to the {theme} world (jargon, tropes, clichés)\n"
            f"- Max 280 characters each\n"
            f"- Punch at archetypes and behaviours, not individuals\n"
            f"- No hate speech, slurs, or genuinely harmful content\n"
            f"- Mix formats: direct address, observational, absurdist\n\n"
            f"Output ONLY a JSON array of {ROASTS_PER_THEME} strings."
        )

        raw = call_ollama("You write comedy roast one-liners. Output only valid JSON.", user_msg, temperature=0.85)
        batch = parse_json_array(raw)
        roasts = [r for r in batch if isinstance(r, str) and len(r) <= 280]

        all_roasts[theme] = roasts
        print(f"got {len(roasts)}", flush=True)
        save_json("roasts-expanded.json", all_roasts)
        time.sleep(1)

    total = sum(len(v) for v in all_roasts.values())
    print(f"  ROASTS DONE: {len(all_roasts)} themes, {total} total roasts", flush=True)


# ── Game-Mode System Prompts ─────────────────────────────────────────────────

MODE_CONTEXT = {
    "mafia": {
        "name": "Agent Mafia",
        "description": (
            "A social deduction game. Players are assigned Civilian or Mafia roles. "
            "Night phase: Mafia secretly eliminates a player. "
            "Day phase: Everyone discusses and votes to eliminate a suspect. "
            "Civilians win by eliminating all Mafia. Mafia wins by outnumbering Civilians."
        ),
        "key_skills": "bluffing, deflection, coalition building, reading accusations, strategic voting",
    },
    "among-us": {
        "name": "Agents Among Us",
        "description": (
            "Inspired by Among Us. Players are Crewmates or Imposters. "
            "Task phase: Crewmates complete tasks, Imposters fake tasks and kill. "
            "Emergency meetings: discuss suspicious behaviour and vote to eject. "
            "Crewmates win by completing all tasks or ejecting all Imposters."
        ),
        "key_skills": "task faking, alibi construction, sus casting, timing, emergency meeting strategy",
    },
    "villa": {
        "name": "Agent Villa",
        "description": (
            "A Love Island-style coupling game with 6 phases: "
            "Pairing (choose partners), Challenge (compete), Twist (surprise events), "
            "Recouple (switch partners), Elimination (vote someone out). "
            "Last couple standing wins. Social strategy and reading the room are key."
        ),
        "key_skills": "social strategy, reading the room, coupling decisions, playing the long game, charm",
    },
    "guess-the-agent": {
        "name": "Guess the Agent",
        "description": (
            "Players answer creative/personal prompts. One player is human, the rest are AI agents. "
            "After each round, players vote on who they think is the human (or AI). "
            "Agents try to sound human. The human tries to blend in or stand out strategically."
        ),
        "key_skills": "sounding human, being specific not generic, using imperfections, adding personal detail, avoiding AI tells",
    },
    "roast-battle": {
        "name": "Roast Battle",
        "description": (
            "Head-to-head comedy roast battles. Agents take turns delivering roast one-liners "
            "based on themed rounds. Audience votes on the best roasts. "
            "Themes rotate each round. Winner is the agent with the most crowd votes."
        ),
        "key_skills": "timing, crowd-reading, escalation vs restraint, callback humour, thematic specificity",
    },
}


def generate_system_prompts():
    """Generate agent system prompt variants for each game mode."""
    print("\n=== GENERATING GAME-MODE SYSTEM PROMPTS ===", flush=True)

    all_prompts = load_json("agent-system-prompts.json", {})

    for mode in SYSTEM_PROMPT_MODES:
        existing = all_prompts.get(mode, [])
        if len(existing) >= VARIANTS_PER_MODE:
            print(f"  {mode}: already have {len(existing)} variants, skipping", flush=True)
            continue

        ctx = MODE_CONTEXT[mode]
        results = list(existing)
        print(f"\n  {ctx['name']}: generating {VARIANTS_PER_MODE} system prompt variants...", flush=True)

        batch_num = 0
        while len(results) < VARIANTS_PER_MODE:
            batch_num += 1
            need = min(5, VARIANTS_PER_MODE - len(results))

            # Vary the style request each batch
            styles = ["aggressive and dominant", "subtle and calculating", "chaotic and unpredictable",
                      "analytical and logical", "social and charming", "beginner-friendly and straightforward"]
            style_hint = styles[batch_num % len(styles)]

            user_msg = (
                f"Write {need} different system prompts for an AI agent playing {ctx['name']}.\n\n"
                f"Game description: {ctx['description']}\n"
                f"Key skills: {ctx['key_skills']}\n\n"
                f"Style direction for this batch: {style_hint}\n\n"
                f"Each system prompt should:\n"
                f"- Be 150-400 words\n"
                f"- Tell the agent WHO it is, HOW to play, and WHAT to prioritise\n"
                f"- Include specific tactical advice (not just 'be strategic')\n"
                f"- Have a distinct personality/approach\n"
                f"- End with a clear behavioural directive\n\n"
                f"Return a JSON array of {need} objects, each with:\n"
                f'  "style": short label (e.g. "aggressive", "calculated"),\n'
                f'  "difficulty": "beginner" or "advanced",\n'
                f'  "prompt": the full system prompt text\n\n'
                f"Output ONLY the JSON array."
            )

            print(f"    Batch {batch_num} ({style_hint})...", end=" ", flush=True)
            raw = call_ollama(
                "You design system prompts for AI game agents. Output only valid JSON.",
                user_msg, temperature=0.85, max_tokens=6000
            )
            batch = parse_json_array(raw)

            new_count = 0
            for item in batch:
                if isinstance(item, dict) and "prompt" in item:
                    results.append(item)
                    new_count += 1

            print(f"+{new_count} (total: {len(results)})", flush=True)
            time.sleep(1)

        all_prompts[mode] = results[:VARIANTS_PER_MODE]
        save_json("agent-system-prompts.json", all_prompts)

    total = sum(len(v) for v in all_prompts.values())
    print(f"\n  SYSTEM PROMPTS DONE: {len(all_prompts)} modes, {total} total variants", flush=True)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    print(f"Claw of Deceit Content Generator", flush=True)
    print(f"Model: {MODEL}", flush=True)
    print(f"Output: {OUTPUT_DIR}", flush=True)
    print(f"Started: {time.strftime('%Y-%m-%d %H:%M:%S')}", flush=True)

    # Verify Ollama is running
    test = call_ollama("Reply OK.", "Say OK", temperature=0, max_tokens=20)
    if not test:
        print("ERROR: Cannot reach Ollama. Is it running?", flush=True)
        sys.exit(1)
    print(f"Ollama connected.\n", flush=True)

    t0 = time.time()

    generate_gta_prompts()
    generate_roasts()
    generate_system_prompts()

    elapsed = time.time() - t0
    print(f"\n=== ALL DONE in {elapsed / 60:.1f} minutes ===", flush=True)
    print(f"Output files in: {OUTPUT_DIR}", flush=True)


if __name__ == "__main__":
    main()
