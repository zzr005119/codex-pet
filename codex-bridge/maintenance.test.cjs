'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { createContext, runInContext } = require('node:vm');

const helper = join(__dirname, '..', 'pet-app', 'runtime', 'electron-helper');
const shared = readFileSync(join(helper, 'shared-core.js'), 'utf8');
const sprite = readFileSync(join(helper, 'sprite.js'), 'utf8');

function makePet(customPos = null) {
  const view = { x: 0, y: 0, w: 3840, h: 1032 };
  const main = { x: 0, y: 0, width: 1920, height: 1032 };
  const context = createContext({
    navigator: { platform: 'Win32' }, BASE: '', VIEW: view,
    AREAS: [main, { ...main, x: 1920 }], PRIMARY_AREA: main,
    CONFIG: { topInsetRatio: 0 }, toLocal: (x) => x,
    window: { __dshPetDebug: {} }, performance: { now: () => 100 }, setTimeout() {},
  });
  runInContext(shared + '\nconst S = PetShared;', context);
  const prototype = runInContext(sprite + '\nPetSprite.prototype', context);
  const pet = Object.assign(Object.create(prototype), {
    size: 320, halfW: 160, halfH: 90,
    pet: { position: { corner: 'bottom-right', marginX: 0, marginY: 60 } },
    customPos, dragState: { active: false }, throwRef: null, pos: { x: 0, y: 0 },
    stopThrow() {},
    stopMove() {},
    sendBounds(x, y) { this.pos = { x, y }; },
  });
  pet.position();
  return {
    pet,
    changePrimary(width) {
      const previous = { ...view };
      const area = { ...main, width };
      context.AREAS = [area];
      context.PRIMARY_AREA = area;
      view.w = width;
      pet.relayout(previous);
    },
  };
}

test('the configured corner survives a temporary wide display and a return to the original size', () => {
  const anchored = makePet();
  const manuallyPlaced = makePet({ rx: 3000 / 3840, ry: 600 / 1032 });
  assert.deepEqual(anchored.pet.pos, { x: 1600, y: 792 });
  for (const fixture of [anchored, manuallyPlaced]) fixture.changePrimary(3840);
  assert.deepEqual(anchored.pet.pos, { x: 3520, y: 792 });
  assert.deepEqual(manuallyPlaced.pet.pos, { x: 2840, y: 510 });
  for (const fixture of [anchored, manuallyPlaced]) fixture.changePrimary(1920);
  assert.deepEqual(anchored.pet.pos, { x: 1600, y: 792 });
  assert.equal(anchored.pet.customPos, null);
  assert.deepEqual(manuallyPlaced.pet.pos, { x: 1759, y: 510 });
  assert.ok(manuallyPlaced.pet.customPos);
});

test('the corner shortcut anchors to the primary work area and keeps the configured home position', () => {
  const fixture = makePet({ rx: 3000 / 3840, ry: 600 / 1032 });
  const { pet } = fixture;
  pet.dragState.active = true;
  pet.moveToCorner('top-left');
  assert.deepEqual(pet.pos, { x: 2840, y: 510 }, 'a pointer drag keeps control of the pet');

  pet.dragState.active = false;
  for (const [corner, expected] of [
    ['top-left', { x: 0, y: 60 }], ['top-right', { x: 1600, y: 60 }],
    ['bottom-right', { x: 1600, y: 792 }], ['bottom-left', { x: 0, y: 792 }],
  ]) {
    pet.moveToCorner(corner);
    assert.deepEqual(pet.pos, expected);
  }

  pet.moveToCorner('top-right');
  fixture.changePrimary(1280);
  assert.deepEqual(pet.pos, { x: 960, y: 60 });
  pet.goHome();
  assert.deepEqual(pet.pos, { x: 960, y: 792 });
});

test('the stage keeps its foot offset when the pointer becomes a drag and releases', () => {
  const { pet } = makePet();
  const stage = { style: { transform: 'translateY(12px)' } };
  Object.assign(pet, {
    bottomPad: 12, stage, hit: { classList: { remove() {} } },
    dragState: { active: true, dragging: false, sx: 100, sy: 100, petX: 30, petY: 40 },
    animations: { drag: [], idle: [] }, dragTrail: [],
    syncInputBusy() {}, startDragFollow() {}, stopDragFollow() {},
  });
  pet.onPointerMove({ screenX: 140, screenY: 130 });
  assert.equal(pet.dragState.dragging, true);
  assert.deepEqual({ ...pet.dragTarget }, { x: 70, y: 70 });
  assert.equal(stage.style.transform, 'translateY(12px)');

  pet.onPointerUp();
  assert.equal(pet.dragState.active, false);
  assert.equal(stage.style.transform, 'translateY(12px)');
});
