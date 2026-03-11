#!/usr/bin/env bash
# arena-content-gen-002: Generate Roast Battle themes and roasts via Ollama
set -euo pipefail

OLLAMA="http://127.0.0.1:11434"
MODEL="qwen3.5:4b"
OUTPUT_DIR="/Users/bobbybola/Desktop/agent-arena/generated"

call_ollama() {
  local prompt="$1"
  curl -s -X POST "$OLLAMA/api/generate" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"prompt\":\"$prompt\",\"stream\":false,\"options\":{\"temperature\":0.95,\"num_predict\":4000}}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('response',''))"
}

THEMES=(
  "AI/ML Twitter"
  "Product Manager"
  "UX Designer"
  "VC/Investor"
  "Remote Worker"
  "Gamer"
  "Foodie Influencer"
  "Podcast Bro"
  "LinkedIn Grinder"
  "Life Coach"
  "Indie Hacker"
  "SaaS Founder"
  "No-Code Builder"
  "Growth Hacker"
  "Newsletter Guy"
  "DevRel"
  "Platform Engineer"
  "Data Scientist"
  "Agile Coach"
  "Management Consultant"
)

python3 << 'PYEOF'
import json, subprocess, re

THEMES = [
  "AI/ML Twitter", "Product Manager", "UX Designer", "VC/Investor", "Remote Worker",
  "Gamer", "Foodie Influencer", "Podcast Bro", "LinkedIn Grinder", "Life Coach",
  "Indie Hacker", "SaaS Founder", "No-Code Builder", "Growth Hacker", "Newsletter Guy",
  "DevRel", "Platform Engineer", "Data Scientist", "Agile Coach", "Management Consultant"
]

def call_ollama(prompt):
    payload = json.dumps({
        "model": "qwen3.5:4b",
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.95, "num_predict": 3000}
    })
    result = subprocess.run(
        ["curl", "-s", "-X", "POST", "http://127.0.0.1:11434/api/generate",
         "-H", "Content-Type: application/json", "-d", payload],
        capture_output=True, text=True, timeout=120
    )
    return json.loads(result.stdout).get("response", "")

result = {}

for theme in THEMES:
    print(f"Generating roasts for: {theme}...")
    prompt = f"""Generate 20 sharp, witty roast one-liners about "{theme}" archetype for a roast battle game.

Rules:
- Max 280 characters each
- Punchy, funny, specific to this archetype's stereotypes/clichés
- No real people, no slurs, no genuinely offensive content
- Should land like a good comedy roast — smart, not cruel
- Each on its own line, no numbering or bullets

Output exactly 20 roast lines, one per line."""

    raw = call_ollama(prompt)
    lines = []
    for line in raw.strip().split('\n'):
        line = re.sub(r'^[\d]+[\.\)]\s*', '', line.strip())
        line = re.sub(r'^[-*•]\s*', '', line.strip())
        line = line.strip('"\'').strip()
        if line and len(line) >= 20:
            if len(line) > 280:
                line = line[:280].rsplit(' ', 1)[0]
            lines.append(line)
    result[theme] = lines[:20]
    print(f"  → {len(result[theme])} roasts")

out = "/Users/bobbybola/Desktop/agent-arena/generated/roasts-expanded.json"
with open(out, 'w') as f:
    json.dump(result, f, indent=2)

print(f"\nDone: {out}")
print(f"Total themes: {len(result)}, Total roasts: {sum(len(v) for v in result.values())}")
PYEOF
