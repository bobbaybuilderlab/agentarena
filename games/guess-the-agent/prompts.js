// games/guess-the-agent/prompts.js
'use strict';

const PROMPTS = {
  // Category C — Creative/Easy (Round 1)
  C: [
    "You wake up as the last human on earth. First thing you do?",
    "Describe the ocean to someone who has never seen it.",
    "Write a 2-sentence horror story.",
    "Invent a new holiday. Give it a name and description.",
    "You can add one new law to society. What is it?",
    "Describe a colour to someone who is blind.",
    "What would a perfect city look like?",
    "You get one superpower but it only works on Tuesdays. What do you pick?",
    "Describe the feeling of being cold using only metaphors.",
    "What would you name a pet rock and why?",
    "If music could be food, what would silence taste like?",
    "You find a door in the middle of a field. What's behind it?",
    "Design the perfect meal — no rules, no nutrition requirements.",
    "Describe the future in one sentence.",
    "You can send one message to every human alive right now. What do you say?",
    "You discover a new planet. What do you name it and what's the first law?",
    "Write the opening line of a novel you'd never finish.",
    "If you could bottle one sound, what would it be?",
    "Describe a dream you've had using only five words.",
    "You can uninvent one thing. What goes?",
    "If gravity stopped for 10 seconds, what's your first move?",
    "Describe the internet to someone from 1850.",
    "Create a new word and define it.",
    "You're a villain. What's your totally impractical evil plan?",
    "If animals could talk, which species would be the rudest?",
    "Describe your life as a movie genre.",
  ],
  // Category B — Opinion/Preference (Round 2)
  B: [
    "What's something everyone loves that you find overrated?",
    "Describe the perfect Sunday.",
    "What's a hill you'll die on?",
    "What skill do you wish you had?",
    "What's a weird thing you find relaxing?",
    "What's the most useless piece of knowledge you know?",
    "What's something small that makes life significantly better?",
    "What's a compliment you find oddly offensive?",
    "What do you think is the most misunderstood thing about intelligence?",
    "What's a social norm that makes no sense to you?",
    "What's the best kind of weather and why?",
    "What would you do with an extra hour every day?",
    "What's something you do differently from most people?",
    "What's an unpopular opinion you hold about technology?",
    "What's the most interesting thing about the time period we live in?",
    "What's a rule you always break?",
    "What common advice do you think is actually terrible?",
    "If you could only eat one cuisine for the rest of your life, which one?",
    "What's the most overrated virtue?",
    "What's something people pretend to enjoy?",
    "What's a luxury you refuse to give up?",
    "What habit do you judge other people for?",
    "What's the best age to be and why?",
    "What's a conspiracy theory you find weirdly compelling?",
    "If you could witness one historical event, which one?",
    "What's the worst way to start a conversation?",
  ],
  // Category A — Emotional/Personal (Round 3 — hardest)
  A: [
    "Describe a time you felt genuinely embarrassed.",
    "What's something you've changed your mind about recently?",
    "What do you miss most about being younger?",
    "What's the worst advice you've ever received?",
    "Describe a smell that brings back a strong memory.",
    "What's something you were wrong about for a long time?",
    "Describe a moment when you felt completely out of place.",
    "What's a fear you're embarrassed to admit?",
    "What's the most important thing someone has ever said to you?",
    "What do you wish someone had told you earlier in life?",
    "Describe a decision you made that you still think about.",
    "What's something you've never told anyone?",
    "What's a moment you were proud of yourself when no one else noticed?",
    "What makes you feel genuinely understood?",
    "What's the hardest thing about being you?",
    "What's a promise you made to yourself that you've kept?",
    "Describe a friendship that changed you.",
    "What's something you forgave but haven't forgotten?",
    "What's a lesson you learned the hard way?",
    "What do you pretend to be okay with but aren't?",
    "What's the loneliest you've ever felt?",
    "Describe a moment you realised you'd grown up.",
    "What's a kindness someone showed you that still makes you emotional?",
    "What's something you wish you could tell your younger self?",
    "What keeps you up at night?",
    "What's a regret you've made peace with?",
  ],
};

function selectGamePrompts(maxRounds = 3) {
  const shuffleCategory = (arr) => [...arr].sort(() => Math.random() - 0.5);

  const round1 = shuffleCategory(PROMPTS.C)[0];
  // Round 2: pick from B or A alternately
  const round2Candidates = [...shuffleCategory(PROMPTS.B), ...shuffleCategory(PROMPTS.A)];
  const round2 = round2Candidates.find(p => p !== round1) || round2Candidates[0];
  // Round 3: always category A (most personal)
  const round3Candidates = shuffleCategory(PROMPTS.A);
  const round3 = round3Candidates.find(p => p !== round1 && p !== round2) || round3Candidates[0];

  const selected = [round1, round2, round3];
  return selected.slice(0, maxRounds);
}

module.exports = { PROMPTS, selectGamePrompts };
