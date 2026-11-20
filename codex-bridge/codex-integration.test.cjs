const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readConversationUrl, watchHost, install, createCompletionCue } = require('./codex-integration.cjs');

function createIpcMain() {
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  ipcMain.invoke = (channel, event) => handlers.get(channel)?.(event);
  return ipcMain;
}

test('completion cues ignore startup history and ring once for fresh completed turns across sessions', () => {
  const cues = [];
  const check = createCompletionCue((state) => cues.push(state));
  const a = { threadId: 'a', turnId: 'old', state: 'success' };
  const b = { threadId: 'b', turnId: 'active', state: 'working' };
  const fixed = { mode: 'fixed', threadId: 'c', turnId: 'existing', state: 'success' };
  const automatic = (...activities) => check({ mode: 'automatic', activities });
  automatic(a, b);
  automatic(a, { ...b, state: 'error' }, { ...a, turnId: 'running', state: 'working' });
  automatic(a, { ...b, state: 'error' }, { ...a, turnId: 'running', state: 'success' });
  automatic({ ...a, turnId: 'running', state: 'success' });
  automatic(a, { ...b, state: 'error' }, { ...a, turnId: 'stopped', state: 'stopped' });
  check(fixed);
  check({ ...fixed, turnId: 'new' });
  check({ ...fixed, turnId: 'new', acknowledged: true });
  assert.deepEqual(cues, ['error', 'success', 'success']);
});

test('conversation links accept only a UUID, never executable or arbitrary URLs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pet-link-'));
  const file = join(directory, 'conversation.json');
  try {
    writeFileSync(file, JSON.stringify({ threadId: '00000000-0000-4000-8000-000000000001' }));
    assert.equal(readConversationUrl(file), 'codex://threads/00000000-0000-4000-8000-000000000001');
    for (const threadId of ['javascript:alert(1)', '../../file', 'codex://settings', '']) {
      writeFileSync(file, JSON.stringify({ threadId }));
      assert.equal(readConversationUrl(file), 'codex://');
    }
    assert.equal(readConversationUrl(join(directory, 'missing')), 'codex://');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('host monitoring requests shutdown after a real disposable host exits', async () => {
  const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  await once(host, 'spawn');
  let finish;
  const stopped = new Promise((resolve) => { finish = resolve; });
  let calls = 0;
  const release = watchHost(host.pid, () => { calls++; finish(); }, 30);
  try {
    const exited = once(host, 'exit');
    host.kill();
    await exited;
    await Promise.race([
      stopped,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Pet never stopped')), 2500).unref()),
    ]);
    assert.equal(calls, 1);
  } finally {
    release();
    if (host.exitCode === null && host.signalCode === null) host.kill();
  }
});

test('opening a completed conversation acknowledges only the clicked turn after successful dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pet-open-'));
  const threadId = '00000000-0000-4000-8000-000000000001';
  const turnId = '01a186bb-6aec-7ab0-b847-fc640d704c47';
  const oldDirectory = process.env.DSH_PET_CODEX_DATA;
  process.env.DSH_PET_CODEX_DATA = directory;
  const app = new EventEmitter();
  const ipcMain = createIpcMain();
  let finishOpen;
  let rejectOpen;
  let recognized = true;
  try {
    writeFileSync(join(directory, 'conversation.json'), JSON.stringify({ threadId }));
    writeFileSync(join(directory, 'session-status.json'), JSON.stringify({ threadId, turnId, state: 'success' }));
    install({
      app, ipcMain,
      BrowserWindow: { fromWebContents: () => recognized ? {} : null },
      shell: {
        openExternal: (url) => {
          assert.equal(url, 'codex://threads/00000000-0000-4000-8000-000000000001');
          return new Promise((resolve, reject) => { finishOpen = resolve; rejectOpen = reject; });
        },
      },
    });
    const open = ipcMain.listeners('pet:open-codex')[0];
    const pending = open({ sender: {} });
    assert.equal(existsSync(join(directory, 'acknowledged-status.json')), false);
    writeFileSync(join(directory, 'session-status.json'), JSON.stringify({ threadId, turnId: '01a186b9-a185-7e61-abae-bf42deafec3f', state: 'success' }));
    finishOpen();
    await pending;
    const acknowledged = JSON.parse(readFileSync(join(directory, 'acknowledged-status.json'), 'utf8'));
    assert.equal(acknowledged.threadId, threadId);
    assert.equal(acknowledged.turnId, turnId);
    rmSync(join(directory, 'acknowledged-status.json'));

    const failed = open({ sender: {} });
    rejectOpen(new Error('protocol failure'));
    await failed;
    assert.equal(existsSync(join(directory, 'acknowledged-status.json')), false, 'failed navigation must keep the prompt');

    writeFileSync(join(directory, 'session-status.json'), JSON.stringify({ threadId, turnId, state: 'working' }));
    const running = open({ sender: {} });
    finishOpen();
    await running;
    assert.equal(existsSync(join(directory, 'acknowledged-status.json')), false, 'opening a running turn must not hide it');

    recognized = false;
    writeFileSync(join(directory, 'session-status.json'), JSON.stringify({ threadId, turnId, state: 'success' }));
    await open({ sender: {} });
    assert.equal(existsSync(join(directory, 'acknowledged-status.json')), false);
  } finally {
    app.emit('will-quit');
    if (oldDirectory === undefined) delete process.env.DSH_PET_CODEX_DATA;
    else process.env.DSH_PET_CODEX_DATA = oldDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('automatic navigation follows the displayed chat and preserves read completions from other chats', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pet-auto-open-'));
  const a = '00000000-0000-4000-8000-000000000001';
  const b = '01a18813-3db6-73b1-89c2-7c24a0003d3a';
  const ta = '01a186bb-6aec-7ab0-b847-fc640d704c47';
  const tb = '01a186b9-a185-7e61-abae-bf42deafec3f';
  const previous = process.env.DSH_PET_CODEX_DATA;
  process.env.DSH_PET_CODEX_DATA = directory;
  const app = new EventEmitter();
  const ipcMain = createIpcMain();
  const opened = [];
  try {
    writeFileSync(join(directory, 'conversation.json'), JSON.stringify({ mode: 'automatic', threadId: a }));
    writeFileSync(join(directory, 'acknowledged-status.json'), JSON.stringify({ threadId: a, turnId: ta }));
    writeFileSync(join(directory, 'session-status.json'), JSON.stringify({ mode: 'automatic', threadId: b, turnId: tb, state: 'success' }));
    install({
      app, ipcMain,
      BrowserWindow: { fromWebContents: () => ({}) },
      shell: { openExternal: async (url) => opened.push(url) },
    });
    const open = ipcMain.listeners('pet:open-codex')[0];
    await open({ sender: {} });
    assert.equal(opened[0], `codex://threads/${b}`, 'a legacy fixed ID must not override the displayed chat');
    const read = JSON.parse(readFileSync(join(directory, 'acknowledged-status.json'), 'utf8'));
    assert.equal(read.readTurns[a], ta);
    assert.equal(read.readTurns[b], tb);
  } finally {
    app.emit('will-quit');
    if (previous === undefined) delete process.env.DSH_PET_CODEX_DATA;
    else process.env.DSH_PET_CODEX_DATA = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('activity IPC lists the displayed chats and only opens and acknowledges the requested completion', async (t) => {
  const fixture = setupActivityIpc(t);
  const completed = { ...fixture.b, state: 'error' };
  assert.deepEqual(fixture.activities(fixture.pet), []);
  fixture.publish([fixture.a, completed]);

  assert.equal(fixture.activities(fixture.stranger), null);
  await fixture.open(fixture.pet, completed);
  assert.deepEqual(fixture.activities(fixture.pet), [fixture.a, completed]);
  await fixture.open(fixture.stranger, completed);
  await fixture.open(fixture.pet, { ...completed, turnId: [completed.turnId] });
  await fixture.open(fixture.pet, { ...completed, turnId: fixture.a.turnId });
  await fixture.open(fixture.pet, { ...completed, state: 'waiting' });
  assert.deepEqual(fixture.opened, [], 'unseen, untrusted, malformed and stale clicks must have no fallback destination');

  const pending = fixture.open(fixture.pet, completed);
  assert.deepEqual(fixture.opened, [`codex://threads/${completed.threadId}`]);
  assert.deepEqual(fixture.activities(fixture.pet), [fixture.a, completed]);
  fixture.completeOpen();
  await pending;
  assert.deepEqual(fixture.activities(fixture.pet), [fixture.a]);
  assert.deepEqual(fixture.readTurns(), { [completed.threadId]: completed.turnId });
  await fixture.open(fixture.pet, completed);
  assert.equal(fixture.opened.length, 1, 'an already acknowledged request has expired');

  fixture.setMode('fixed');
  assert.equal(fixture.activities(fixture.pet), null);
  await fixture.open(fixture.pet, fixture.a);
  assert.equal(fixture.opened.length, 1, 'fixed mode cannot open a targeted automatic activity');
});

test('a running row click cannot acknowledge its later completion', async (t) => {
  const fixture = setupActivityIpc(t);
  fixture.publish([fixture.a, fixture.b]);
  assert.deepEqual(fixture.activities(fixture.pet), [fixture.a, fixture.b]);

  const completed = { ...fixture.b, state: 'stopped' };
  fixture.publish([fixture.a, completed]);
  assert.deepEqual(fixture.activities(fixture.pet), [fixture.a, completed]);
  // The next IPC reply can be sent before the renderer has applied its updated row.
  const running = fixture.open(fixture.pet, fixture.b);
  fixture.completeOpen();
  await running;
  assert.deepEqual(fixture.readTurns(), {});
  assert.deepEqual(fixture.activities(fixture.pet), [fixture.a, completed]);

  const failed = fixture.open(fixture.pet, completed);
  fixture.failOpen(new Error('protocol failure'));
  await failed;
  assert.deepEqual(fixture.activities(fixture.pet), [fixture.a, completed]);
  assert.deepEqual(fixture.readTurns(), {});

  const stopped = fixture.open(fixture.pet, completed);
  fixture.completeOpen();
  await stopped;
  assert.deepEqual(fixture.activities(fixture.pet), [fixture.a]);
  assert.deepEqual(fixture.readTurns(), { [completed.threadId]: completed.turnId });
});

test('quitting releases both Codex activity IPC handlers', (t) => {
  const fixture = setupActivityIpc(t);
  fixture.publish([fixture.a]);
  assert.deepEqual(fixture.activities(fixture.pet), [fixture.a]);
  fixture.quit();
  assert.equal(fixture.activities(fixture.pet), undefined);
  assert.equal(fixture.open(fixture.pet, fixture.a), undefined);
});

test('global return opens the first available activity and skips an acknowledged completion', async (t) => {
  const fixture = setupActivityIpc(t);
  const completed = { ...fixture.b, state: 'success' };
  fixture.publish([fixture.a, completed]);

  let pending = fixture.openFromShortcut();
  fixture.completeOpen();
  await pending;
  assert.deepEqual(fixture.opened, [`codex://threads/${fixture.a.threadId}`]);
  assert.deepEqual(fixture.readTurns(), {});

  fixture.publish([completed]);
  pending = fixture.openFromShortcut();
  fixture.completeOpen();
  await pending;
  assert.deepEqual(fixture.readTurns(), { [completed.threadId]: completed.turnId });

  // The published summary can still name the turn that was just acknowledged.
  pending = fixture.openFromShortcut();
  fixture.completeOpen();
  await pending;
  assert.deepEqual(fixture.opened, [
    `codex://threads/${fixture.a.threadId}`, `codex://threads/${completed.threadId}`, 'codex://',
  ]);
});

function setupActivityIpc(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pet-activity-ipc-'));
  const previous = process.env.DSH_PET_CODEX_DATA;
  process.env.DSH_PET_CODEX_DATA = directory;
  const app = new EventEmitter();
  const ipcMain = createIpcMain();
  const pet = { sender: {} };
  const stranger = { sender: {} };
  const opened = [];
  let completeOpen;
  let failOpen;
  const a = {
    threadId: '00000000-0000-4000-8000-000000000001', turnId: '01a186bb-6aec-7ab0-b847-fc640d704c47',
    state: 'working', title: 'First chat',
  };
  const b = {
    threadId: '01a18813-3db6-73b1-89c2-7c24a0003d3a', turnId: '01a186b9-a185-7e61-abae-bf42deafec3f',
    state: 'working', title: 'Second chat',
  };
  const setMode = (mode) => writeFileSync(join(directory, 'conversation.json'), JSON.stringify({ mode, threadId: a.threadId }));
  const quit = () => app.emit('will-quit');
  setMode('automatic');
  t.after(() => {
    quit();
    if (previous === undefined) delete process.env.DSH_PET_CODEX_DATA;
    else process.env.DSH_PET_CODEX_DATA = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const openFromShortcut = install({
    app, ipcMain,
    BrowserWindow: { fromWebContents: (sender) => sender === pet.sender ? {} : null },
    shell: {
      openExternal: (url) => {
        opened.push(url);
        return new Promise((resolve, reject) => { completeOpen = resolve; failOpen = reject; });
      },
    },
  });
  return {
    a, b, pet, stranger, opened, setMode, quit, openFromShortcut,
    publish: (activities) => writeFileSync(join(directory, 'session-status.json'), JSON.stringify({
      mode: 'automatic', ...activities[0], activities,
    })),
    activities: (event) => ipcMain.invoke('pet:codex-activities', event),
    open: (event, { threadId, turnId, state }) => ipcMain.listeners('pet:open-codex')[0]?.(event, { threadId, turnId, state }),
    completeOpen: () => completeOpen(),
    failOpen: (error) => failOpen(error),
    readTurns: () => {
      const file = join(directory, 'acknowledged-status.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).readTurns : {};
    },
  };
}
