import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { selectCodexHost, createLifecycle } from './lifecycle.mjs';

const desktop = {
  pid: 100,
  path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe',
  commandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe"',
  created: '2026-10-29T00:00:00Z',
};

test('only the Codex desktop root keeps the pet alive', () => {
  const candidates = [
    { ...desktop, pid: 200, commandLine: 'ChatGPT.exe --type=renderer' },
    { ...desktop, pid: 201, path: 'C:\\Tools\\ChatGPT.exe' },
    { ...desktop, pid: 202, path: 'C:\\Tools\\codex.exe' },
    { ...desktop, pid: 203, path: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0_x64__x\\app\\ChatGPT.exe' },
    { ...desktop, pid: 0 },
  ];
  assert.equal(selectCodexHost(candidates), null);
  assert.deepEqual(selectCodexHost([...candidates, desktop]), desktop);
});

test('matching the package name is case insensitive and works after an app update', () => {
  const updated = {
    ...desktop,
    path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_27.1.0.0_x64__2p2nqsd0c76g0\\app\\chatgpt.EXE',
  };
  assert.deepEqual(selectCodexHost([updated]), updated);
});

test('minimization has no effect, polling does not duplicate, and host loss stops the real child', async () => {
  const children = [];
  const controller = createLifecycle({
    start: async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
      await once(child, 'spawn');
      children.push(child);
      return child;
    },
    stop: async (child) => {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    },
  });
  try {
    await controller.update(null);
    assert.equal(children.length, 0);
    await controller.update(desktop);
    await controller.update({ ...desktop, minimized: true, mainWindowHandle: 0 });
    await controller.update(desktop);
    assert.equal(children.length, 1);
    assert.equal(children[0].exitCode, null);
    await controller.update(null);
    assert.equal(children[0].exitCode !== null || children[0].signalCode !== null, true);
    await controller.update(desktop);
    assert.equal(children.length, 2);
  } finally {
    await controller.update(null);
  }
});

test('a manual pet exit stays closed until a different desktop lifetime begins', async () => {
  let starts = 0;
  const controller = createLifecycle({
    start: async () => {
      starts++;
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
      await once(child, 'spawn');
      return child;
    },
    stop: async (child) => {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    },
  });
  const child = await controller.update(desktop);
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  await controller.update(desktop);
  assert.equal(starts, 1);
  await controller.update(null);
  await controller.update({ ...desktop, pid: 101 });
  assert.equal(starts, 2);
  await controller.update(null);
});
