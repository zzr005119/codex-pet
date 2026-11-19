'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function renderer() {
  class PetSprite {}
  const timers = [];
  const shared = {
    WORK_STATUS_INDEX: { working: 1, success: 4, error: 5 },
    pickSlot: (slot) => slot,
    toWorkStatus: (data) => data,
    poolIncludes: () => false,
  };
  const context = vm.createContext({
    PetSprite, S: shared, console: { log() {} },
    window: { petBridge: { codexMode: true }, setTimeout: (callback) => { timers.push(callback); return timers.length; }, clearTimeout() {} },
    BUBBLE_DURATION_MS: 10000,
    sprites: [],
    workTick: 0,
  });
  const events = join(__dirname, '..', 'pet-app', 'runtime', 'electron-helper', 'events.js');
  vm.runInContext(readFileSync(events, 'utf8'), context);
  const pet = Object.assign(new PetSprite(), {
    pet: { id: 'main', workStatusEnabled: true },
    animations: { events: { workStatus: ['think', 'work', 'result', 'wait', 'done', 'error'] } },
    prevWorkTick: 0, workTimer: null,
    stopMove() {}, renderBubble() {}, switchTo() {}, playOnce() {},
  });
  context.sprites.push(pet);
  return { context, pet, timers };
}

test('Codex completion remains visible until the next turn', () => {
  const { pet, timers } = renderer();
  pet.onWorkTick({ state: 'working', task: 'running' }, 1);
  pet.onWorkTick({ state: 'success', task: 'completed' }, 2);
  for (const callback of timers) callback();
  assert.equal(pet.workOn, true, 'completion must not disappear after ten seconds');
  assert.equal(pet.workText, 'completed');
  pet.onWorkTick({ state: 'working', task: 'running again' }, 3);
  assert.equal(pet.workText, 'running again');
});

test('a renderer restart restores the current work status from its initial snapshot', async () => {
  const { context, pet } = renderer();
  context.CONFIG_URL = 'http://127.0.0.1/config';
  context.STATE_URL = 'http://127.0.0.1/state';
  context.STATE_WAIT_MS = 15000;
  context.stateLongPoll = false;
  context.stateSince = undefined;
  context.stateBaseline = null;
  context.S.flattenCounters = () => ({});
  context.S.readMenuItems = () => [];
  context.S.fetchState = async () => ({ counter: 1, sections: { workStatus: { counter: 1, data: { state: 'working', task: 'running' } } } });
  await vm.runInContext('pollStateOnce()', context);
  assert.equal(pet.workState, 'working');
  assert.equal(pet.workOn, true);
});

test('clearing the external completion slot hides the bubble and the next turn displays normally', () => {
  const { context, pet } = renderer();
  pet.onWorkTick({ state: 'success', task: 'completed' }, 1);
  context.workTick = 1;
  vm.runInContext('applyWorkStatusLeaf({ data: { state: null, task: null } })', context);
  assert.equal(pet.workOn, false);
  assert.equal(pet.workText, null);
  pet.onWorkTick({ state: 'working', task: 'running again' }, 3);
  assert.equal(pet.workOn, true);
  pet.onWorkTick({ state: 'success', task: 'completed again' }, 4);
  assert.equal(pet.workOn, true);
  assert.equal(pet.workText, 'completed again');
});
