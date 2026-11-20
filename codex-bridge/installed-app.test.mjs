import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const app = process.env.DSH_PET_TEST_APP || join(workspace, 'install', 'app', 'dsh-pet.exe');

function environment(dataDir, fields = {}) {
  const env = {
    ...process.env,
    DSH_HOME: dataDir,
    DSH_PET_CODEX_DATA: dataDir,
    DSH_PET_GPU_SANDBOX: '1',
    ...fields,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function waitFor(read, accept, message) {
  for (let attempt = 0; attempt < 75; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  assert.fail(message);
}

async function connectRenderer(port) {
  const targets = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(3000) })
    .then((response) => response.json());
  const target = targets.find((entry) => entry.url.startsWith('file:') &&
    new URL(entry.url).pathname.endsWith('/runtime/electron-helper/index.html'));
  if (!target) return null;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    socket.close();
    throw error;
  }
  let id = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', receive);
      reject(new Error('Timed out evaluating ' + method + ' in the packaged renderer'));
    }, 3000);
    function receive(event) {
      const result = JSON.parse(event.data);
      if (result.id !== requestId) return;
      socket.removeEventListener('message', receive);
      clearTimeout(timeout);
      if (result.error || result.result?.exceptionDetails) {
        reject(new Error('Packaged renderer ' + method + ' failed: ' +
          (result.error?.message || result.result.exceptionDetails.text)));
      } else {
        resolve(result.result);
      }
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  return {
    close: () => socket.close(),
    call,
    evaluate: async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true })).result.value,
  };
}

function renderedActivityStyles() {
  const list = document.querySelector('.pet-codex-activities:not([hidden])');
  const backgrounds = (style) => [style.backgroundColor, style.backgroundImage];
  const transparent = 'rgba(0, 0, 0, 0)';
  return {
    list: backgrounds(getComputedStyle(list)),
    rows: Array.from(list.querySelectorAll('button'), (button) => {
      const icon = button.querySelector('.pet-codex-activity-status');
      const iconStyle = getComputedStyle(icon);
      const pseudoStyles = ['::before', '::after'].map((pseudo) => getComputedStyle(icon, pseudo));
      const shapes = pseudoStyles.filter((style) => style.content === '""').map((style) => ({
        fill: style.backgroundColor,
        radius: style.borderTopLeftRadius,
        width: parseFloat(style.width),
        height: parseFloat(style.height),
        borders: ['Top', 'Right', 'Bottom', 'Left'].map((side) => parseFloat(style['border' + side + 'Width'])),
        rotation: new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform).b,
      }));
      return {
        state: button.dataset.state,
        background: backgrounds(getComputedStyle(button)),
        ariaLabel: button.getAttribute('aria-label'),
        title: button.querySelector('.pet-codex-activity-title').textContent,
        visibleText: button.innerText.trim(),
        color: iconStyle.color,
        hidden: icon.getAttribute('aria-hidden'),
        content: pseudoStyles.map((style) => style.content),
        shapes,
        painted: shapes.some((shape) => shape.width > 0 && shape.height > 0 &&
          (shape.fill !== transparent || shape.borders.some((width) => width > 0))),
        animated: [iconStyle, ...pseudoStyles].some((style) => style.animationName !== 'none'),
      };
    }),
  };
}

test('installed packaged DPI probe exits promptly without starting the pet service', { timeout: 15000 }, async () => {
  const dataDir = mkdtempSync(join(workspace, 'dpi-test-'));
  const child = spawn(app, [], {
    windowsHide: true,
    env: environment(dataDir, { DSH_PET_DPI_PROBE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  const timer = setTimeout(() => child.kill(), 12000);
  try {
    const [code] = await once(child, 'exit');
    assert.match(output, /dsh-pet-primary-scale:[1-9][0-9]*(?:\.[0-9]+)?/);
    // The parent consumes the marker even if headless Electron hits the known Windows exit-time fault.
    assert.ok(code === 0 || (process.platform === 'win32' && code === 0xc0000005),
      'unexpected exit after DPI output: ' + code);
    assert.doesNotMatch(output, /127\.0\.0\.1|integration-ready/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('installed Electron shows distinct activity buttons, clears one completion at a time, and exits with its host', { timeout: 45000 }, async () => {
  const dataDir = mkdtempSync(join(workspace, 'host-test-'));
  const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  await once(host, 'spawn');
  const configDir = join(dataDir, 'dsh-pet');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'main-config.jsonc'), readFileSync(new URL('./main-config.jsonc', import.meta.url)));
  writeFileSync(join(dataDir, 'conversation.json'), JSON.stringify({ mode: 'automatic' }));
  const sessionDir = join(dataDir, 'sessions', '2026', '10', '29');
  mkdirSync(sessionDir, { recursive: true });
  const threadId = '00000000-0000-4000-8000-000000000001';
  const turnId = '01a186bb-6aec-7ab0-b847-fc640d704c47';
  const otherThread = '01a18813-3db6-73b1-89c2-7c24a0003d3a';
  const otherTurn = '01a186b9-a185-7e61-abae-bf42deafec3f';
  const transcript = join(sessionDir, `rollout-2026-10-29T15-01-03-${threadId}.jsonl`);
  const eventLine = (type, id = turnId, details = {}) => JSON.stringify({
    type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: id, root_turn_id: id, ...details },
  }) + '\n';
  const metaLine = (id) => JSON.stringify({ type: 'session_meta', payload: {
    id, originator: 'Codex Desktop', source: 'vscode', thread_source: 'user',
  } }) + '\n';
  writeFileSync(join(dataDir, 'session_index.jsonl'), [
    { id: threadId, thread_name: 'Build check' },
    { id: otherThread, thread_name: 'Review changes' },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  writeFileSync(transcript, metaLine(threadId) + eventLine('task_started'));
  const child = spawn(app, [
    `--user-data-dir=${join(dataDir, 'electron-profile')}`,
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  ], {
    windowsHide: true,
    env: environment(dataDir, {
      CODEX_HOME: dataDir, DSH_PET_CODEX_HOST_PID: String(host.pid),
      DSH_PET_CODEX_HOST_STARTED: new Date(Date.now() - 10000).toISOString(),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let startup = '';
  child.stderr.on('data', (chunk) => { startup = (startup + chunk).slice(-12000); });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill(), 40000);
  let renderer;
  try {
    renderer = await waitFor(async () => {
      assert.equal(child.exitCode, null, 'pet exited before readiness');
      const debugPort = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(startup)?.[1];
      if (!debugPort) return null;
      try {
        return await connectRenderer(debugPort);
      } catch {
        return null;
      }
    }, Boolean, 'pet renderer did not start its local test connection');
    const readRows = () => renderer.evaluate(
      "Array.from(document.querySelectorAll('.pet-codex-activities:not([hidden]) button'), (button) => " +
      "[button.title, button.dataset.state, button.getBoundingClientRect().height])",
    );
    async function expectRows(expected) {
      const rows = await waitFor(readRows, (value) => JSON.stringify(value.map((row) => row.slice(0, 2))) === JSON.stringify(expected),
        'incorrect visible pet bubbles for ' + JSON.stringify(expected));
      assert.ok(rows.every((row) => row[2] > 0), 'each activity must have a visible button');
    }
    const styles = {
      working: ['rgb(24, 95, 165)', '\u8fd0\u884c\u4e2d'],
      success: ['rgb(59, 109, 17)', '\u5df2\u5b8c\u6210'],
      stopped: ['rgb(95, 94, 90)', '\u5df2\u505c\u6b62'],
      error: ['rgb(163, 45, 45)', '\u5df2\u5931\u8d25'],
    };
    const transparent = ['rgba(0, 0, 0, 0)', 'none'];
    const shapeMatches = {
      working: ([dot, ring]) => dot.width === dot.height && dot.radius === '50%' && ring.borders.every((width) => width > 0),
      success: ([check]) => check.borders.filter((width) => width > 0).length === 2 && check.rotation !== 0,
      stopped: ([square]) => square.width === square.height && square.radius !== '50%' && square.rotation === 0,
      error: ([downstroke, upstroke]) => downstroke.width > downstroke.height && upstroke.width > upstroke.height &&
        downstroke.rotation * upstroke.rotation < 0,
    };
    async function expectIconStyles() {
      const rendered = await renderer.evaluate('(' + renderedActivityStyles.toString() + ')()');
      assert.deepEqual(rendered.list, transparent, 'activity container must be fully transparent');
      for (const row of rendered.rows) {
        const [color, label] = styles[row.state];
        assert.deepEqual(row.background, transparent, 'activity button must be fully transparent');
        assert.equal(row.visibleText, row.title, row.state + ' must display a title without visible status text');
        assert.ok(row.ariaLabel.includes(label), row.state + ' needs a speaking status label');
        assert.equal(row.hidden, 'true', row.state + ' icon should be hidden from assistive technology');
        assert.equal(row.color, color, row.state + ' icon color');
        assert.ok(row.content.every((content) => ['none', 'normal', '""'].includes(content)),
          row.state + ' icon must not use generated text');
        assert.equal(row.painted, true, row.state + ' icon must paint a visible shape');
        assert.equal(row.shapes.length, ['working', 'error'].includes(row.state) ? 2 : 1, row.state + ' icon parts');
        assert.ok(shapeMatches[row.state](row.shapes), row.state + ' icon shape');
        assert.equal(row.animated, row.state === 'working', row.state + ' icon animation');
      }
    }
    await renderer.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await expectRows([['Build check', 'working']]);
    await expectIconStyles();
    await renderer.call('DOM.enable');
    await renderer.call('CSS.enable');
    const { root } = await renderer.call('DOM.getDocument');
    const { nodeId } = await renderer.call('DOM.querySelector', {
      nodeId: root.nodeId, selector: '.pet-codex-activities button',
    });
    assert.ok(nodeId, 'activity button must exist for hover verification');
    await renderer.call('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    await expectIconStyles();
    await renderer.call('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    await renderer.evaluate(`(() => {
      window.playedCues = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        const cue = /\\/sound\\/(turn-(?:success|error)\\.wav)$/.exec(this.src);
        if (!cue) return play.call(this);
        this.muted = true;
        return play.call(this).then(() => { window.playedCues.push(cue[1]); });
      };
      return true;
    })()`);
    const playedCues = () => renderer.evaluate('window.playedCues');
    const otherFile = join(sessionDir, 'rollout-2026-10-29T15-01-03-' + otherThread + '.jsonl');
    writeFileSync(otherFile, metaLine(otherThread) + eventLine('task_started', otherTurn));
    await expectRows([['Review changes', 'working'], ['Build check', 'working']]);
    assert.equal(await renderer.evaluate("!!document.querySelector('.pet-bubble.is-on')"), false, 'the single work bubble must not duplicate the list');
    appendFileSync(otherFile, eventLine('task_complete', otherTurn));
    await expectRows([['Build check', 'working'], ['Review changes', 'success']]);
    await expectIconStyles();
    assert.deepEqual(await playedCues(), [], 'task sounds are disabled by default');
    await renderer.evaluate("localStorage.setItem('codex-pet.sound.completion', '1')");
    appendFileSync(transcript, eventLine('task_complete'));
    await expectRows([['Build check', 'success'], ['Review changes', 'success']]);
    await waitFor(playedCues, (cues) => cues.includes('turn-success.wav'), 'missing completion sound');
    writeFileSync(join(dataDir, 'acknowledged-status.json'), JSON.stringify({ threadId, turnId }));
    await expectRows([['Review changes', 'success']]);
    writeFileSync(join(dataDir, 'acknowledged-status.json'), JSON.stringify({ readTurns: {
      [threadId]: turnId, [otherThread]: otherTurn,
    } }));
    await expectRows([]);
    const interruptedTurn = '01a186bb-6aec-7ab0-b847-fc640d704c48';
    const failedTurn = '01a186b9-a185-7e61-abae-bf42deafec40';
    appendFileSync(transcript, eventLine('task_started', interruptedTurn) + eventLine('turn_aborted', interruptedTurn));
    await expectRows([['Build check', 'stopped']]);
    await expectIconStyles();
    appendFileSync(otherFile, eventLine('task_started', failedTurn) +
      eventLine('task_complete', failedTurn, { error: { message: 'fixture failure' } }));
    await expectRows([['Review changes', 'error'], ['Build check', 'stopped']]);
    await expectIconStyles();
    await waitFor(playedCues, (cues) => cues.includes('turn-error.wav'), 'missing failure sound');
    assert.deepEqual(await playedCues(), ['turn-success.wav', 'turn-error.wav']);
    writeFileSync(join(dataDir, 'acknowledged-status.json'), JSON.stringify({ readTurns: {
      [threadId]: interruptedTurn, [otherThread]: failedTurn,
    } }));
    await expectRows([]);
    await waitFor(() => renderer.evaluate("window.__dshPetDebug.inputBusy"), (value) => value === false,
      'the empty list must release its input region');
    assert.equal(child.exitCode, null, 'pet must remain alive with its host');
    const hostExited = once(host, 'exit');
    host.kill();
    await hostExited;
    const [code] = await exited;
    assert.equal(code, 0);
    assert.match(readFileSync(join(dataDir, 'integration.log'), 'utf8'), /host-exited/);
  } finally {
    clearTimeout(timer);
    renderer?.close();
    if (host.exitCode === null && host.signalCode === null) {
      const hostExited = once(host, 'exit');
      host.kill();
      await hostExited;
    }
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
