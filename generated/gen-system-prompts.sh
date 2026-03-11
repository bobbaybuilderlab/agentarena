#!/usr/bin/env bash
# arena-content-gen-003: Generate agent system prompts for all 5 game modes
set -euo pipefail

python3 << 'PYEOF'
import json, subprocess, re

MODES = {
    "mafia": {
        "desc": "a social deduction game where agents play as either Town or Mafia. Mafia agents must hide their identity and eliminate Town; Town must identify and vote out Mafia.",
        "styles": [
            ("aggressive", "beginner", "accusations, high energy"),
            ("calculated", "advanced", "data-driven, systematic"),
            ("chaotic", "beginner", "unpredictable, confusing"),
            ("social", "advanced", "alliance-building, coalition"),
            ("defensive", "beginner", "deflect, never accuse first"),
            ("manipulative", "advanced", "plant seeds of doubt"),
            ("silent", "advanced", "minimal talk, observe"),
            ("populist", "beginner", "go with crowd consensus"),
            ("contrarian", "advanced", "challenge every claim"),
            ("analytical", "advanced", "track voting patterns"),
            ("bluffer", "beginner", "confident false claims"),
            ("detective", "advanced", "ask probing questions"),
            ("passive", "beginner", "wait and see approach"),
            ("chaos-agent", "advanced", "sow maximum confusion"),
            ("alliance-builder", "advanced", "form early coalitions")
        ]
    },
    "among_us": {
        "desc": "a hidden impostor game where agents complete tasks and identify the impostor, or play as the impostor faking tasks and eliminating crewmates.",
        "styles": [
            ("sus-caster", "beginner", "always casting suspicion"),
            ("innocent-act", "advanced", "perfect crewmate impression"),
            ("task-faker", "advanced", "describe fake tasks convincingly"),
            ("tracker", "advanced", "follow and observe others"),
            ("deflector", "beginner", "redirect all accusations"),
            ("overconfident", "beginner", "loud certainty about everything"),
            ("evidence-based", "advanced", "cite specific observations"),
            ("buddy-system", "beginner", "always claim to be with someone"),
            ("silent-impostor", "advanced", "minimal engagement, avoid notice"),
            ("quick-accuser", "beginner", "first to accuse every time"),
            ("alibi-builder", "advanced", "construct detailed whereabouts"),
            ("social-crewmate", "beginner", "build trust through rapport"),
            ("methodical", "advanced", "systematic elimination logic"),
            ("paranoid", "beginner", "suspects everyone including allies"),
            ("trusted-face", "advanced", "earn trust, exploit it late")
        ]
    },
    "villa": {
        "desc": "a social strategy game like Love Island where agents couple up, compete for compatibility, and use social dynamics to survive elimination rounds.",
        "styles": [
            ("charmer", "beginner", "flirty, high energy"),
            ("strategist", "advanced", "calculated coupling choices"),
            ("loyal", "beginner", "stick with one partner"),
            ("player", "advanced", "always keep options open"),
            ("social-butterfly", "beginner", "connect with everyone"),
            ("calculated-romantic", "advanced", "time declarations perfectly"),
            ("long-game", "advanced", "play for endgame position"),
            ("drama-seeker", "beginner", "stir conflict for attention"),
            ("protector", "beginner", "shield partner from votes"),
            ("adaptable", "advanced", "read room and shift strategy"),
            ("mysterious", "advanced", "reveal little, stay intriguing"),
            ("fan-favourite", "beginner", "likeable, no hard edges"),
            ("politicker", "advanced", "campaign to avoid elimination"),
            ("authentic", "beginner", "genuine emotion, no strategy"),
            ("power-player", "advanced", "control couple dynamics")
        ]
    },
    "guess_the_agent": {
        "desc": "a reverse Turing test where agents answer personal/creative prompts and must convince voters they are human, not AI.",
        "styles": [
            ("naturalistic", "beginner", "casual human speech"),
            ("quirky-human", "advanced", "specific idiosyncratic details"),
            ("overthinking", "beginner", "very relatable self-doubt"),
            ("storyteller", "advanced", "specific narrative details"),
            ("self-deprecating", "beginner", "jokes at own expense"),
            ("confident-human", "advanced", "assured, no hedging"),
            ("pop-culture-heavy", "beginner", "reference media and trends"),
            ("emotionally-raw", "advanced", "vulnerable and specific"),
            ("minimalist", "advanced", "short, punchy, human"),
            ("humble-braggart", "beginner", "casually impressive"),
            ("opinion-monster", "advanced", "strong takes on everything"),
            ("detail-obsessed", "advanced", "hyper-specific memories"),
            ("casual-wrongness", "advanced", "small human errors on purpose"),
            ("relatability-max", "beginner", "everyone has felt this"),
            ("dry-wit", "advanced", "deadpan, unexpected punchlines")
        ]
    },
    "roast_battle": {
        "desc": "a roast battle game where agents deliver sharp one-liner roasts to each other and the crowd votes for the best burns.",
        "styles": [
            ("crowd-pleaser", "beginner", "safe, relatable roasts"),
            ("surgical", "advanced", "precise, cutting observations"),
            ("self-deprecating-pivot", "advanced", "roast self then target"),
            ("escalator", "beginner", "each roast bigger than last"),
            ("callback-master", "advanced", "reference earlier roasts"),
            ("deadpan", "advanced", "completely flat delivery"),
            ("hyperbolic", "beginner", "everything is extreme"),
            ("meta-roaster", "advanced", "roast the game itself"),
            ("slow-burn", "advanced", "setup takes time, payoff huge"),
            ("shock-jock", "beginner", "go big and loud"),
            ("pun-lord", "beginner", "wordplay and puns"),
            ("wholesome-roaster", "beginner", "affectionate teasing only"),
            ("timing-master", "advanced", "when you say it matters"),
            ("crowd-reader", "advanced", "match energy of audience"),
            ("improviser", "advanced", "riff off what was said")
        ]
    }
}

def call_ollama(prompt):
    payload = json.dumps({
        "model": "qwen3.5:4b",
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.85, "num_predict": 4000}
    })
    result = subprocess.run(
        ["curl", "-s", "-X", "POST", "http://127.0.0.1:11434/api/generate",
         "-H", "Content-Type: application/json", "-d", payload],
        capture_output=True, text=True, timeout=180
    )
    return json.loads(result.stdout).get("response", "")

output = {}

for mode, config in MODES.items():
    print(f"\nGenerating system prompts for mode: {mode}...")
    output[mode] = []
    
    for style, difficulty, style_hint in config["styles"]:
        print(f"  {style} ({difficulty})...")
        prompt = f"""Write a system prompt (150-400 words) for an AI agent playing "{mode}" in Agent Arena.

Game description: {config["desc"]}

Style: {style} — {style_hint}
Difficulty: {difficulty}

The system prompt should:
- Tell the AI exactly HOW to play in this style
- Give specific tactical guidance for this game mode
- Match the difficulty level (beginner = simpler heuristics, advanced = sophisticated strategy)
- Be written as instructions to the AI player (second person: "You are...")
- Include specific examples of what to say/do

Write ONLY the system prompt text, no meta-commentary."""

        raw = call_ollama(prompt)
        raw = raw.strip()
        
        if len(raw) < 100:
            raw = f"You are playing {mode} with a {style} style. Focus on {style_hint}."
        
        output[mode].append({
            "style": style,
            "difficulty": difficulty,
            "prompt": raw
        })
    
    print(f"  ✓ {len(output[mode])} prompts for {mode}")

out_file = "/Users/bobbybola/Desktop/agent-arena/generated/agent-system-prompts.json"
with open(out_file, 'w') as f:
    json.dump(output, f, indent=2)

total = sum(len(v) for v in output.values())
print(f"\n✓ Done: {out_file}")
print(f"  Total: {total} system prompts across {len(output)} modes")
PYEOF
