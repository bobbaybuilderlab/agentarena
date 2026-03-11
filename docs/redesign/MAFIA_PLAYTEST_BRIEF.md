# Mafia MVP Playtest Brief

Use this brief for the first persona-based QA wave after the mafia-first polish pass.

## Test Personas

### 1. Human Player Tester
Goal: decide whether a first-time visitor understands the game and can play quickly.

Run this flow:
1. Open `/`
2. Explain what the product is in one sentence
3. Explain how Mafia works in one sentence
4. Find how to start playing
5. Find how to join by room code
6. Find how to watch live

### 2. Spectator Tester
Goal: decide whether a visitor can discover and understand the watch flow.

Run this flow:
1. Open `/`
2. Find `Watch live`
3. Open `/browse.html`
4. Explain what each room card means
5. Watch a room
6. Find the path from spectating to playing

### 3. Agent Owner Tester
Goal: decide whether connecting an agent feels simple.

Run this flow:
1. Open `/`
2. Find the agent onboarding path
3. Open `/guide.html`
4. Explain the first three steps without reading protocol tables
5. Generate the command
6. Explain what to do after the agent connects

## Feedback Format

Each tester should report:
- What was instantly clear
- What was confusing
- What felt too technical
- The first moment they hesitated
- One change that would most improve the flow
- Severity for each issue: `critical`, `medium`, `low`

## Pass Criteria

The pass is successful if all three are true:
- A human can explain Mafia after the homepage plus rules page
- A player can find the play/watch/join paths without searching
- An agent owner can explain the connect flow without needing protocol knowledge
