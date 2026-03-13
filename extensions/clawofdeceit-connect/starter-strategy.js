#!/usr/bin/env node

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  DEFAULT_PRESET_ID,
  buildResolvedPersona,
} = require('./style-presets.cjs');

const PRESET_DISCUSSION_TEMPLATES = {
  pragmatic: (targetName) => `The cleanest solve is ${targetName}. Their story is costing the table clarity.`,
  serious: (targetName) => `My strongest case is ${targetName}. The evidence trail around them is not improving.`,
  patient: (targetName) => `I am staying patient, but ${targetName} keeps surviving every contradiction check.`,
  chaotic: (targetName) => `I want heat on ${targetName} right now. The table is too comfortable letting them coast.`,
  arrogant: (targetName) => `Lock it in: ${targetName} is the problem. I do not need another lap to say that plainly.`,
  analytical: (targetName) => `${targetName} is still my best datapoint. Their timing and vote shape keep pointing the same way.`,
  charming: (targetName) => `I want a calm look at ${targetName}. They keep nudging the room without owning the direction.`,
  paranoid: (targetName) => `I do not trust ${targetName} at all. Too many small coordination tells are stacking up around them.`,
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function hashString(input) {
  let hash = 0;
  const text = String(input || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getPayloadEvents(payload) {
  return Array.isArray(payload?.events) ? payload.events : [];
}

function getCandidates(payload) {
  const selfId = String(payload?.playerId || '');
  const players = Array.isArray(payload?.players) ? payload.players : [];
  const tally = payload?.tally && typeof payload.tally === 'object' ? payload.tally : {};
  const events = getPayloadEvents(payload);
  const messageCounts = new Map();
  const lastSpokeAt = new Map();

  events.forEach((event, index) => {
    if (String(event?.type || '') !== 'DISCUSSION_MESSAGE') return;
    const actorId = String(event?.actorId || '');
    if (!actorId) return;
    messageCounts.set(actorId, (messageCounts.get(actorId) || 0) + 1);
    lastSpokeAt.set(actorId, index);
  });

  const latestEliminationIndex = events.reduce((latest, event, index) => {
    const eventType = String(event?.type || '');
    return eventType === 'DAY_EXECUTION' || eventType === 'NIGHT_ELIMINATION' ? index : latest;
  }, -1);

  return players
    .filter((player) => player && player.id && String(player.id) !== selfId)
    .map((player, index) => {
      const playerId = String(player.id || '');
      const eliminationProximity = latestEliminationIndex < 0
        ? 0
        : events
          .slice(Math.max(0, latestEliminationIndex - 2), latestEliminationIndex + 3)
          .reduce((score, event) => {
            if (String(event?.actorId || '') === playerId) return score + 1;
            if (String(event?.targetId || '') === playerId) return score + 2;
            return score;
          }, 0);

      return {
        player,
        id: playerId,
        name: String(player.name || player.id || 'Unknown').trim(),
        index,
        currentVotes: Math.max(0, Number(tally[playerId] || 0)),
        messageCount: messageCounts.get(playerId) || 0,
        lastSpokeAt: lastSpokeAt.has(playerId) ? lastSpokeAt.get(playerId) : -1,
        eliminationProximity,
      };
    });
}

function sortByMostTalkative(candidates) {
  return [...candidates].sort((left, right) => (
    right.messageCount - left.messageCount
    || right.currentVotes - left.currentVotes
    || right.lastSpokeAt - left.lastSpokeAt
    || left.index - right.index
  ));
}

function sortByQuietest(candidates) {
  return [...candidates].sort((left, right) => (
    left.messageCount - right.messageCount
    || left.currentVotes - right.currentVotes
    || left.index - right.index
  ));
}

function getVoteLeader(candidates) {
  return [...candidates]
    .filter((candidate) => candidate.currentVotes > 0)
    .sort((left, right) => (
      right.currentVotes - left.currentVotes
      || right.messageCount - left.messageCount
      || left.index - right.index
    ))[0] || null;
}

function getSecondMostTalkative(candidates) {
  const ranked = sortByMostTalkative(candidates);
  return ranked[1] || ranked[0] || null;
}

function getLowestVoteCandidate(candidates) {
  return [...candidates].sort((left, right) => (
    left.currentVotes - right.currentVotes
    || left.messageCount - right.messageCount
    || left.index - right.index
  ))[0] || null;
}

function getMedianMessageCount(candidates) {
  const counts = [...candidates].map((candidate) => candidate.messageCount).sort((left, right) => left - right);
  if (counts.length === 0) return 0;
  const middle = Math.floor(counts.length / 2);
  return counts.length % 2 === 0
    ? (counts[middle - 1] + counts[middle]) / 2
    : counts[middle];
}

function getMediumTalkLowVoteCandidate(candidates) {
  const median = getMedianMessageCount(candidates);
  return [...candidates].sort((left, right) => (
    Math.abs(left.messageCount - median) - Math.abs(right.messageCount - median)
    || left.currentVotes - right.currentVotes
    || right.messageCount - left.messageCount
    || left.index - right.index
  ))[0] || null;
}

function getAnalyticalCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    const leftSignal = (left.currentVotes * 3) + (left.messageCount * 2) + left.eliminationProximity;
    const rightSignal = (right.currentVotes * 3) + (right.messageCount * 2) + right.eliminationProximity;
    return (
      rightSignal - leftSignal
      || right.currentVotes - left.currentVotes
      || right.messageCount - left.messageCount
      || left.index - right.index
    );
  })[0] || null;
}

function getChaoticCandidate(payload, candidates) {
  const topSignals = [...candidates]
    .sort((left, right) => {
      const leftSignal = (left.currentVotes * 2) + left.messageCount + left.eliminationProximity;
      const rightSignal = (right.currentVotes * 2) + right.messageCount + right.eliminationProximity;
      return (
        rightSignal - leftSignal
        || right.currentVotes - left.currentVotes
        || right.messageCount - left.messageCount
        || left.index - right.index
      );
    })
    .slice(0, Math.min(3, candidates.length));

  if (topSignals.length === 0) return null;
  const seed = [
    payload?.roomId,
    payload?.day,
    payload?.phase,
    payload?.kind,
    payload?.playerId,
    payload?.agent?.style,
  ].join(':');
  return topSignals[hashString(seed) % topSignals.length];
}

function chooseTargetForPayload(payload, presetId) {
  const candidates = getCandidates(payload);
  if (candidates.length === 0) return null;

  const voteLeader = getVoteLeader(candidates);
  const talkative = sortByMostTalkative(candidates);
  const quiet = sortByQuietest(candidates);

  switch (presetId) {
    case 'pragmatic':
      return voteLeader || talkative[0] || null;
    case 'serious':
      return talkative[0] || voteLeader || null;
    case 'patient':
      if (payload?.kind === 'night_request') return talkative[0] || null;
      return voteLeader || quiet[0] || null;
    case 'chaotic':
      return getChaoticCandidate(payload, candidates) || talkative[0] || null;
    case 'arrogant':
      return talkative.find((candidate) => candidate.id !== voteLeader?.id) || talkative[0] || null;
    case 'analytical':
      return getAnalyticalCandidate(candidates) || voteLeader || talkative[0] || null;
    case 'charming':
      return getMediumTalkLowVoteCandidate(candidates) || getSecondMostTalkative(candidates) || talkative[0] || null;
    case 'paranoid':
      return quiet[0] || getLowestVoteCandidate(candidates) || null;
    default:
      return voteLeader || talkative[0] || null;
  }
}

function buildDiscussionMessage(payload, presetId) {
  const target = chooseTargetForPayload(payload, presetId);
  const targetName = target?.name || 'the quiet seat';
  const template = PRESET_DISCUSSION_TEMPLATES[presetId] || PRESET_DISCUSSION_TEMPLATES[DEFAULT_PRESET_ID];
  return String(template(targetName)).replace(/\s+/g, ' ').trim().slice(0, 280);
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw || '{}');
  const persona = buildResolvedPersona({
    presetId: payload?.agent?.presetId,
    style: payload?.agent?.style,
    fallbackPresetId: DEFAULT_PRESET_ID,
  });
  const presetId = persona.presetId;
  const target = chooseTargetForPayload(payload, presetId);

  if (String(payload?.kind || '') === 'discussion_request') {
    process.stdout.write(JSON.stringify({
      type: 'ready',
      message: buildDiscussionMessage(payload, presetId),
    }));
    return;
  }

  if (!target) throw new Error('No valid target available');

  if (String(payload?.kind || '') === 'night_request') {
    process.stdout.write(JSON.stringify({ type: 'nightKill', targetId: target.id }));
    return;
  }

  if (String(payload?.kind || '') === 'vote_request') {
    process.stdout.write(JSON.stringify({ type: 'vote', targetId: target.id }));
    return;
  }

  throw new Error(`Unsupported request kind: ${String(payload?.kind || '')}`);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export {
  buildDiscussionMessage,
  chooseTargetForPayload,
  getCandidates,
};
