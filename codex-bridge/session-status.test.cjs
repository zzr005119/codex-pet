'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const status = require('./codex-integration.cjs');
const thread = '00000000-0000-4000-8000-000000000001';
const first = '01a186bb-6aec-7ab0-b847-fc640d704c47';
const second = '01a186b9-a185-7e61-abae-bf42deafec3f';
const child = '01a186b1-0859-74c3-80fd-fdc17cc8c793';
const meta = (id = thread) => ({ type: 'session_meta', payload: { id, source: 'vscode' } });
const event = (type, turn = first, root = turn) => ({
  timestamp: '2026-10-29T08:16:32.000Z',
  type: 'event_msg',
  payload: { type, turn_id: turn, root_turn_id: root },
});
function completion(turn, error) {
  const completed = event('task_complete', turn);
  completed.payload.error = error;
  return completed;
}
const lines = (...items) => items.map((item) => JSON.stringify(item) + '\n').join('');

test('the bound root turn stays busy across tool and child events, then completes', () => {
  assert.equal(typeof status.createSessionReader, 'function', 'session status reader is missing');
  const directory = mkdtempSync(join(tmpdir(), 'pet-status-'));
  const file = join(directory, 'rollout.jsonl');
  try {
    writeFileSync(file, lines(meta(), event('task_started')));
    const reader = status.createSessionReader(file, thread);
    assert.deepEqual(reader.read(), { state: 'working', turnId: first });
    appendFileSync(file, lines(event('item_completed'), event('task_started', child, first), event('task_complete', child, first)));
    assert.deepEqual(reader.read(), { state: 'working', turnId: first });
    appendFileSync(file, lines({ ...event('task_complete'), payload: { ...event('task_complete').payload, last_agent_message: 'PRIVATE TEXT' } }));
    assert.deepEqual(reader.read(), { state: 'success', turnId: first });
    assert.equal(JSON.stringify(reader.read()).includes('PRIVATE'), false);
    appendFileSync(file, lines(event('task_started', second), event('task_complete', first)));
    assert.deepEqual(reader.read(), { state: 'working', turnId: second }, 'an old turn cannot complete the new turn');
    appendFileSync(file, lines(event('turn_aborted', second)));
    assert.deepEqual(reader.read(), { state: 'stopped', turnId: second });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only a structured root completion error marks the turn failed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pet-status-'));
  const file = join(directory, 'rollout.jsonl');
  const failure = { message: 'PRIVATE ERROR DETAIL', codex_error_info: 'other' };
  try {
    writeFileSync(file, lines(meta(), event('task_started'), completion(first, failure)));
    const reader = status.createSessionReader(file, thread);
    assert.deepEqual(reader.read(), { state: 'error', turnId: first });

    appendFileSync(file, lines(event('task_started', second), completion(second, null)));
    assert.deepEqual(reader.read(), { state: 'success', turnId: second });

    appendFileSync(file, lines(event('task_started', child), completion(child, [failure])));
    assert.deepEqual(reader.read(), { state: 'success', turnId: child });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('partial writes wait for a full JSON line, and truncation or another thread clears status', () => {
  assert.equal(typeof status.createSessionReader, 'function', 'session status reader is missing');
  const directory = mkdtempSync(join(tmpdir(), 'pet-status-'));
  const file = join(directory, 'rollout.jsonl');
  try {
    writeFileSync(file, lines(meta()));
    const reader = status.createSessionReader(file, thread);
    assert.deepEqual(reader.read(), { state: 'waiting', turnId: null });
    const started = lines(event('task_started'));
    appendFileSync(file, started.slice(0, -3));
    assert.deepEqual(reader.read(), { state: 'waiting', turnId: null });
    appendFileSync(file, started.slice(-3));
    assert.deepEqual(reader.read(), { state: 'working', turnId: first });
    writeFileSync(file, lines(meta(second), event('task_started')));
    assert.deepEqual(reader.read(), { state: 'waiting', turnId: null });
    writeFileSync(file, lines(meta()));
    assert.deepEqual(reader.read(), { state: 'waiting', turnId: null });
    rmSync(file);
    assert.deepEqual(reader.read(), { state: 'waiting', turnId: null });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the follower discovers the bound transcript and delivers authenticated status updates with retry', async () => {
  assert.equal(typeof status.followSessionStatus, 'function', 'session status publisher is missing');
  const directory = mkdtempSync(join(tmpdir(), 'pet-follow-'));
  const sessionsDirectory = join(directory, 'sessions');
  const dateDirectory = join(sessionsDirectory, '2026', '10', '29');
  mkdirSync(dateDirectory, { recursive: true });
  const file = join(dateDirectory, `rollout-2026-10-29T15-01-03-${thread}.jsonl`);
  writeFileSync(join(directory, 'conversation.json'), JSON.stringify({ threadId: thread }));
  writeFileSync(file, lines(meta(), event('task_started')));
  const requests = [];
  let rejectFirst = true;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers['x-dsh-pet-token'], 'private-test-token');
    assert.equal(req.url, '/dsh-pet-7340/work-status');
    assert.ok(req.method === 'POST' || req.method === 'DELETE');
    requests.push(req.method === 'DELETE' ? { state: null } : JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(rejectFirst ? 503 : req.method === 'DELETE' ? 204 : 200, { 'Content-Type': 'application/json' });
    rejectFirst = false;
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const options = {
    directory, sessionsDirectory,
    configUrl: `http://127.0.0.1:${server.address().port}/dsh-pet-7340/config`,
    token: 'private-test-token', intervalMs: 20,
  };
  let stop = status.followSessionStatus(options);
  function savedStatus() {
    try { return JSON.parse(readFileSync(join(directory, 'session-status.json'), 'utf8')); } catch { return {}; }
  }
  async function waitFor(predicate) {
    for (let i = 0; i < 150; i++) {
      if (predicate()) return;
      await delay(20);
    }
    assert.fail('status did not reach the service');
  }
  try {
    await waitFor(() => requests.length >= 2 && requests.at(-1).state === 'working');
    appendFileSync(file, lines(event('task_complete')));
    await waitFor(() => savedStatus().state === 'success');
    const saved = savedStatus();
    assert.equal(saved.turnId, first);
    assert.equal(saved.state, 'success');
    assert.equal(saved.threadId, thread);
    assert.equal(JSON.stringify(saved).includes('private-test-token'), false);
    writeFileSync(join(directory, 'acknowledged-status.json'), JSON.stringify({ threadId: thread, turnId: first }));
    await waitFor(() => savedStatus().acknowledged === true);
    assert.equal(requests.at(-1).state, null);
    stop();
    const count = requests.length;
    stop = status.followSessionStatus(options);
    await waitFor(() => requests.length > count);
    assert.equal(requests.at(-1).state, null, 'restarting must not resurrect a read completion');
    appendFileSync(file, lines(event('task_started', second)));
    await waitFor(() => requests.at(-1)?.state === 'working');
    appendFileSync(file, lines(completion(second, { message: 'PRIVATE ERROR DETAIL', codex_error_info: 'other' })));
    await waitFor(() => savedStatus().state === 'error');
    const failed = savedStatus();
    assert.equal(failed.acknowledged, false);
    assert.equal(requests.at(-1).state, 'error');
    assert.equal(requests.at(-1).task, '\u672c\u8f6e\u5df2\u5931\u8d25');
    assert.doesNotMatch(JSON.stringify({ requests, failed }), /PRIVATE ERROR DETAIL|codex_error_info/);
    writeFileSync(join(directory, 'conversation.json'), JSON.stringify({ threadId: child }));
    await waitFor(() => requests.at(-1)?.state === 'waiting');
    assert.equal(JSON.stringify(requests).includes('last_agent_message'), false);
  } finally {
    stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the follower refuses to send the application token to a remote or malformed service URL', () => {
  assert.equal(typeof status.followSessionStatus, 'function', 'session status publisher is missing');
  for (const configUrl of ['https://example.com/dsh-pet-7340/config', 'http://localhost:80/config', 'file:///config']) {
    assert.throws(() => status.followSessionStatus({ configUrl, token: 'private-test-token' }));
  }
});
