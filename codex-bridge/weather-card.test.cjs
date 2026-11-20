const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { setImmediate: flushPendingPromises } = require('node:timers/promises');
const vm = require('node:vm');

const script = readFileSync(join(__dirname, '..', 'pet-app', 'runtime', 'electron-helper', 'weather-card.js'), 'utf8');

class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.children = [];
  }

  append(...elements) { this.children.push(...elements); }
  setAttribute(name, value) { this[name] = value; }
  focus() { this.focused = true; }
  select() {}
  remove() {}
}

function mount(query, storedCity) {
  const document = new EventTarget();
  document.createElement = (tag) => new Element(tag);
  const storage = new Map();
  if (storedCity) storage.set('codex-pet.weather-city', storedCity);
  const window = { localStorage: {
    getItem: (key) => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
  } };
  vm.runInNewContext(script, { document, window });
  let changes = 0;
  const card = new window.PetWeatherCard({ query, onChange: () => { changes++; } });
  const form = card.element.children.find((child) => child.tag === 'form');
  return {
    card,
    changeCity: card.element.children.find((child) => child.textContent === '换城市'),
    changes: () => changes,
    close: card.element.children.find((child) => child['aria-label'] === '关闭天气'),
    document,
    form,
    input: form.children.find((child) => child.tag === 'input'),
    message: card.element.children.find((child) => child.role === 'status'),
    storedCity: () => storage.get('codex-pet.weather-city'),
  };
}

test('first use asks for a city and remembers it only after a successful manual query', async () => {
  const queries = [];
  const { card, form, input, changes, message, storedCity, close } = mount(async (city) => {
    queries.push(city);
    return { ok: true, message: '杭州 · 阴 · 13 ℃' };
  });
  assert.equal(card.element.hidden, true);
  card.open();
  assert.equal(form.hidden, false);
  assert.equal(input.focused, true);
  assert.equal(changes(), 1);
  assert.deepEqual(queries, []);
  input.value = '  杭州 ';
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(storedCity(), undefined);
  await flushPendingPromises();
  assert.deepEqual(queries, ['杭州']);
  assert.equal(storedCity(), '杭州');
  assert.equal(form.hidden, true);
  assert.equal(message.textContent, '杭州 · 阴 · 13 ℃');
  close.dispatchEvent(new Event('click'));
  assert.equal(card.element.hidden, true);
  await card.open();
  assert.deepEqual(queries, ['杭州', '杭州']);
});

test('an unsuccessful city change shows the error and preserves the last successful city', async () => {
  const queries = [];
  const { card, changeCity, form, input, message, storedCity } = mount(async (city) => {
    queries.push(city);
    if (city === '北京') return { ok: true, message: '北京 · 晴 · 8 ℃' };
    return { ok: false, message: '未找到该城市的天气，请检查名称。' };
  }, '北京');
  await card.open();
  changeCity.dispatchEvent(new Event('click'));
  assert.equal(input.value, '北京');
  assert.deepEqual(queries, ['北京']);
  input.value = '不存在的地方';
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await flushPendingPromises();
  assert.deepEqual(queries, ['北京', '不存在的地方']);
  assert.equal(form.hidden, false);
  assert.equal(input.value, '不存在的地方');
  assert.match(message.textContent, /未找到/);
  assert.equal(storedCity(), '北京');
});

test('closing by Escape hides the card and ignores a pending result', async () => {
  let resolveQuery;
  const { card, document, message, changes } = mount(() => new Promise((resolve) => { resolveQuery = resolve; }), '北京');
  const query = card.open();
  assert.match(message.textContent, /查询/);
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  document.dispatchEvent(escape);
  assert.equal(card.element.hidden, true);
  const closed = changes();
  resolveQuery({ ok: true, message: '北京 · 晴 · 8 ℃' });
  await query;
  assert.equal(card.element.hidden, true);
  assert.equal(changes(), closed);
});

test('the weather message itself can be clicked to dismiss it', async () => {
  const { card, message } = mount(async () => ({ ok: true, message: '北京 · 晴 · 8 ℃' }), '北京');
  await card.open();
  assert.equal(card.element.hidden, false);
  message.dispatchEvent(new Event('click'));
  assert.equal(card.element.hidden, true);
});
