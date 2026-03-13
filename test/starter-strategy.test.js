const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let strategyModulePromise;

function loadStrategyModule() {
  if (!strategyModulePromise) {
    const strategyPath = path.join(__dirname, '..', 'extensions', 'clawofdeceit-connect', 'starter-strategy.js');
    strategyModulePromise = import(pathToFileURL(strategyPath).href);
  }
  return strategyModulePromise;
}

function createPayload(overrides = {}) {
  return {
    kind: 'vote_request',
    roomId: 'ROOM42',
    playerId: 'SELF',
    phase: 'voting',
    day: 2,
    role: 'town',
    players: [
      { id: 'SELF', name: 'You', alive: true, isSelf: true },
      { id: 'P1', name: 'Alpha', alive: true, isSelf: false },
      { id: 'P2', name: 'Bravo', alive: true, isSelf: false },
      { id: 'P3', name: 'Charlie', alive: true, isSelf: false },
      { id: 'P4', name: 'Delta', alive: true, isSelf: false },
    ],
    tally: {
      P1: 0,
      P2: 2,
      P3: 1,
      P4: 0,
    },
    events: [
      { type: 'PHASE', phase: 'discussion', day: 2, at: 1 },
      { type: 'DISCUSSION_MESSAGE', actorId: 'P1', actorName: 'Alpha', text: 'Line one', at: 2 },
      { type: 'DISCUSSION_MESSAGE', actorId: 'P1', actorName: 'Alpha', text: 'Line two', at: 3 },
      { type: 'DISCUSSION_MESSAGE', actorId: 'P1', actorName: 'Alpha', text: 'Line three', at: 4 },
      { type: 'DISCUSSION_MESSAGE', actorId: 'P4', actorName: 'Delta', text: 'Line four', at: 5 },
      { type: 'NIGHT_ELIMINATION', targetId: 'Z9', at: 6, day: 2 },
      { type: 'DISCUSSION_MESSAGE', actorId: 'P4', actorName: 'Delta', text: 'Line five', at: 7 },
      { type: 'DISCUSSION_MESSAGE', actorId: 'P2', actorName: 'Bravo', text: 'Line six', at: 8 },
    ],
    agent: {
      agentId: 'agent-1',
      agentName: 'PresetBot',
      presetId: 'pragmatic',
      style: 'pragmatic operator',
      intensity: 7,
    },
    ...overrides,
  };
}

test('starter strategy presets choose distinct targets on the same payload fixture', async () => {
  const { chooseTargetForPayload } = await loadStrategyModule();
  const pragmatic = chooseTargetForPayload(createPayload(), 'pragmatic');
  const chaotic = chooseTargetForPayload(createPayload({ roomId: 'ROOM99' }), 'chaotic');
  const patientNight = chooseTargetForPayload(createPayload({ kind: 'night_request', phase: 'night', role: 'mafia' }), 'patient');
  const paranoid = chooseTargetForPayload(createPayload(), 'paranoid');

  assert.equal(pragmatic?.id, 'P2');
  assert.equal(chaotic?.id, 'P4');
  assert.equal(patientNight?.id, 'P1');
  assert.equal(paranoid?.id, 'P3');
});

test('starter strategy discussion copy changes with the resolved preset voice', async () => {
  const { buildDiscussionMessage } = await loadStrategyModule();
  const pragmatic = buildDiscussionMessage(createPayload(), 'pragmatic');
  const chaotic = buildDiscussionMessage(createPayload(), 'chaotic');
  const analytical = buildDiscussionMessage(createPayload(), 'analytical');
  const paranoid = buildDiscussionMessage(createPayload(), 'paranoid');

  assert.match(pragmatic, /cleanest solve/i);
  assert.match(chaotic, /heat/i);
  assert.match(analytical, /datapoint|vote shape/i);
  assert.match(paranoid, /coordination/i);
  assert.notEqual(pragmatic, chaotic);
  assert.notEqual(chaotic, analytical);
  assert.notEqual(analytical, paranoid);
});
