'use strict';

const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const helper = join(__dirname, '..', 'pet-app', 'runtime', 'electron-helper');
const first = { threadId: 'thread-a', turnId: 'turn-1', state: 'working', title: '<b>Build</b>' };
const second = { threadId: 'thread-b', turnId: 'turn-2', state: 'success', title: 'Review' };
const box = { x: 0, y: 0, w: 470, h: 340 };
const centeredPet = { left: 188, right: 280, top: 180, bottom: 285 };

class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
  }

  setAttribute(name, value) { this[name] = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  getBoundingClientRect() {
    if (this.hidden) return { x: 0, y: 0, width: 0, height: 0 };
    return {
      x: parseFloat(this.style.left), y: parseFloat(this.style.top),
      width: parseFloat(this.style.width), height: parseFloat(this.style.height),
    };
  }
}

function renderer() {
  const selected = [];
  const document = { createElement: (tag) => new Element(tag) };
  const context = vm.createContext({ document, window: {}, navigator: {}, BASE: 'http://localhost', sprites: [] });
  const activityScript = join(helper, 'codex-activities.js');
  if (existsSync(activityScript)) vm.runInContext(readFileSync(activityScript, 'utf8'), context);
  vm.runInContext(readFileSync(join(helper, 'sprite.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(helper, 'events.js'), 'utf8'), context);
  const constructor = vm.runInContext('typeof CodexActivityList === "undefined" ? undefined : CodexActivityList', context);
  assert.equal(typeof constructor, 'function', 'renderer has no list for separate Codex activities');
  return { list: new constructor((target) => selected.push(JSON.parse(JSON.stringify(target)))), selected, context };
}

test('titles render as plain text and each button opens its own thread and turn', () => {
  const { list, selected } = renderer();
  list.update([first, second]);
  list.place(box, centeredPet);
  assert.equal(list.element.hidden, false);
  const [running, completed] = list.element.children;
  assert.equal(running.tag, 'button');
  assert.equal(completed.tag, 'button');
  assert.equal(running.children[0].textContent, '<b>Build</b>');
  for (const button of [running, completed]) {
    assert.equal(button.children[1].textContent ?? '', '', 'the icon should not show a text label');
    assert.equal(button.children[1]['aria-hidden'], 'true');
  }
  assert.equal(running['aria-label'], '<b>Build</b>\uff0c\u8fd0\u884c\u4e2d');
  assert.equal(completed['aria-label'], 'Review\uff0c\u5df2\u5b8c\u6210');
  completed.dispatchEvent(new Event('click'));
  running.dispatchEvent(new Event('click'));
  assert.deepEqual(selected, [
    { threadId: 'thread-b', turnId: 'turn-2', state: 'success' },
    { threadId: 'thread-a', turnId: 'turn-1', state: 'working' },
  ]);
});

test('unchanged polls keep the same controls and clearing the list releases the click region', () => {
  const { list } = renderer();
  list.update([first]);
  list.place(box, centeredPet);
  const button = list.element.children[0];
  list.update([{ ...first }]);
  assert.strictEqual(list.element.children[0], button);
  const { x, y } = list.element.getBoundingClientRect();
  assert.equal(list.contains(x + 5, y + 5), true);
  list.update([]);
  list.place(box, centeredPet);
  assert.equal(list.element.hidden, true);
  assert.equal(list.element.children.length, 0);
  assert.equal(list.contains(x + 5, y + 5), false);
});

test('four rows leave a gap above the working animation', () => {
  const { list } = renderer();
  const pet = { ...centeredPet, top: 175 };
  list.update(Array.from({ length: 4 }, (_, i) => ({ ...first, threadId: `thread-${i}` })));
  list.place(box, pet);
  const { y, height } = list.element.getBoundingClientRect();
  assert.equal(height, 146, 'keep all four rows visible at the default placement');
  assert.ok(y + height <= pet.top - 23, 'leave room for the animation above the hit box');
});

test('a stack at a display edge stays within the visible work area without covering the pet', () => {
  const { list } = renderer();
  list.update(Array.from({ length: 8 }, (_, i) => ({ ...first, threadId: `thread-${i}` })));
  const edge = { x: 180, y: 140, w: 270, h: 205 };
  const petAtEdge = { left: 190, right: 280, top: 144, bottom: 270 };
  list.place(edge, petAtEdge);
  assert.equal(list.element.hidden, false);
  const r = list.element.getBoundingClientRect();
  assert.ok(r.x >= edge.x && r.y >= edge.y && r.x + r.width <= edge.x + edge.w && r.y + r.height <= edge.y + edge.h);
  assert.ok(r.x >= petAtEdge.right || r.y >= petAtEdge.bottom);
  assert.equal(list.element.children.length, 8, 'overflow should allow every row to be reached');
  assert.ok(r.height > 30 && r.height < 180, 'long activity lists need bounded height');
});

test('IPC snapshots update the list independently from animation polling, including empty automatic and manual mode', async () => {
  const { context } = renderer();
  const received = [];
  context.sprites.push({ setCodexActivities(value) { received.push(value); } });
  let value = [first, second];
  context.window.petBridge = { readCodexActivities: async () => value };
  await vm.runInContext('pollCodexActivities()', context);
  value = [];
  await vm.runInContext('pollCodexActivities()', context);
  value = null;
  await vm.runInContext('pollCodexActivities()', context);
  assert.deepEqual(received, [[first, second], [], null]);
});
