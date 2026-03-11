#!/usr/bin/env bash
# arena-content-gen-001: Generate GTA prompts via Ollama qwen3.5:4b
# Max 120 chars, no politics/religion/trauma

set -euo pipefail

OLLAMA="http://127.0.0.1:11434"
MODEL="qwen3.5:4b"
OUTPUT_DIR="/Users/bobbybola/Desktop/agent-arena/generated"

call_ollama() {
  local prompt="$1"
  curl -s -X POST "$OLLAMA/api/generate" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"prompt\":\"$prompt\",\"stream\":false,\"options\":{\"temperature\":0.9,\"num_predict\":2000}}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('response',''))"
}

echo "Generating Category C prompts (creative/easy)..."

PROMPT_C='Generate 30 unique, short creative writing prompts for a social game where players (humans or AI) answer imaginatively. These are Category C: creative/easy — fun, whimsical, imaginative. Requirements:
- Max 120 characters each
- No politics, religion, trauma, violence, or sensitive topics
- Should spark creative, fun responses
- Each on its own line, no numbering
- No quotes around them
- Varied themes: imagination, hypotheticals, silly scenarios, inventions, nature

Output exactly 30 prompts, one per line.'

C_RAW=$(call_ollama "$PROMPT_C")
echo "$C_RAW" > "$OUTPUT_DIR/raw-c.txt"

PROMPT_B='Generate 30 unique short opinion/preference prompts for a social game where players answer personally. Category B: opinion/preference — what you like, think, prefer. Requirements:
- Max 120 characters each  
- No politics, religion, or controversial topics
- Should reveal personality and preferences without being invasive
- Each on its own line, no numbering
- Varied: food/lifestyle preferences, unpopular opinions, personal quirks, hypothetical choices

Output exactly 30 prompts, one per line.'

B_RAW=$(call_ollama "$PROMPT_B")
echo "$B_RAW" > "$OUTPUT_DIR/raw-b.txt"

PROMPT_A='Generate 25 unique short personal/emotional prompts for a social game. Category A: emotional/personal — deeper, more revealing, but still comfortable to share. Requirements:
- Max 120 characters each
- Warm and reflective, not traumatic or distressing
- Should reveal genuine personality/values
- Each on its own line, no numbering
- Themes: growth, relationships, self-knowledge, meaning, small joys

Output exactly 25 prompts, one per line.'

A_RAW=$(call_ollama "$PROMPT_A")
echo "$A_RAW" > "$OUTPUT_DIR/raw-a.txt"

echo "Raw generation done. Processing..."

python3 << 'PYEOF'
import json, re, os

OUTPUT_DIR = "/Users/bobbybola/Desktop/agent-arena/generated"

# Load existing prompts from prompts.js to dedup
existing = set()
with open("/Users/bobbybola/Desktop/agent-arena/games/guess-the-agent/prompts.js") as f:
    for line in f:
        line = line.strip()
        if line.startswith('"') or line.startswith("'"):
            txt = line.strip('",\' ')
            if txt:
                existing.add(txt.lower()[:50])

def clean_prompts(raw, max_chars=120):
    lines = raw.strip().split('\n')
    result = []
    for line in lines:
        # Remove numbering, bullets, dashes
        line = re.sub(r'^[\d]+[\.\)]\s*', '', line.strip())
        line = re.sub(r'^[-*•]\s*', '', line.strip())
        line = line.strip('"\'')
        line = line.strip()
        if not line or len(line) < 10:
            continue
        if len(line) > max_chars:
            # Try to truncate at sentence boundary
            if '?' in line[:max_chars]:
                line = line[:line.rfind('?', 0, max_chars)+1]
            else:
                line = line[:max_chars].rsplit(' ', 1)[0]
        # Dedup check
        key = line.lower()[:50]
        if key in existing:
            continue
        existing.add(key)
        result.append(line)
    return result

for cat, fname in [('C', 'raw-c.txt'), ('B', 'raw-b.txt'), ('A', 'raw-a.txt')]:
    with open(f"{OUTPUT_DIR}/{fname}") as f:
        raw = f.read()
    prompts = clean_prompts(raw)
    out_file = f"{OUTPUT_DIR}/prompts-{cat.lower()}.json"
    with open(out_file, 'w') as f:
        json.dump(prompts, f, indent=2)
    print(f"Category {cat}: {len(prompts)} prompts → {out_file}")

PYEOF

echo "Done: prompts-c.json, prompts-b.json, prompts-a.json"
