'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } = require('node:fs');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const integration = require('./codex-integration.cjs');

const a = '00000000-0000-4000-8000-000000000001';
const b = '01a18813-3db6-73b1-89c2-7c24a0003d3a';
const child = '00000000-0000-4000-8000-000000000002';
const ta = '01a186bb-6aec-7ab0-b847-fc640d704c47';
const tb = '01a186b9-a185-7e61-abae-bf42deafec3f';
const tc = '01a186b1-0859-74c3-80fd-fdc17cc8c793';
const since = Date.parse('2026-10-31T08:00:00Z');
const line = (item) => JSON.stringify(item) + '\n';
const event = (type, turnId, at, rootId = turnId) => line({
  type: 'event_msg', timestamp: at,
  payload: { type, turn_id: turnId, root_turn_id: rootId },
});

function setup() {
  assert.equal(typeof integration.createAutomaticSessionReader, 'function', 'automatic session discovery is missing');
  const directory = mkdtempSync(join(tmpdir(), 'pet-auto-'));
  const sessionsDirectory = join(directory, 'sessions');
  const date = join(sessionsDirectory, '2026', '10', '29');
  mkdirSync(date, { recursive: true });
  function session(id, fields = {}) {
    const file = join(date, `rollout-2026-10-29T15-01-03-${id}.jsonl`);
    writeFileSync(file, line({ type: 'session_meta', payload: {
      id, source: 'vscode', originator: 'Codex Desktop', thread_source: 'user', ...fields,
    } }));
    return file;
  }
  const monitor = integration.createAutomaticSessionReader({ directory, sessionsDirectory, since });
  return { directory, sessionsDirectory, session, monitor, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('automatic discovery switches to another running chat and keeps a still-running chat ahead of completion', async () => {
  const fixture = setup();
  try {
    writeFileSync(join(fixture.directory, 'session_index.jsonl'),
      line({ id: a, thread_name: '  First\n  chat  ' }) +
      line({ id: b, thread_name: 'Second chat' }));
    const af = fixture.session(a);
    appendFileSync(af, event('task_started', ta, '2026-10-31T08:01:00Z'));
    assert.equal((await fixture.monitor.read()).threadId, a);
    const bf = fixture.session(b);
    appendFileSync(bf, event('task_started', tb, '2026-10-31T08:02:00Z'));
    let chosen = await fixture.monitor.read();
    assert.equal(chosen.threadId, b);
    assert.equal(chosen.runningCount, 2);
    assert.deepEqual(chosen.activities, [
      { threadId: b, turnId: tb, state: 'working', title: 'Second chat' },
      { threadId: a, turnId: ta, state: 'working', title: 'First chat' },
    ]);
    appendFileSync(bf, event('task_complete', tb, '2026-10-31T08:03:00Z'));
    chosen = await fixture.monitor.read();
    assert.equal(chosen.threadId, a, 'another chat is still running');
    assert.equal(chosen.state, 'working');
    assert.equal(chosen.runningCount, 1);
    assert.deepEqual(chosen.activities, [
      { threadId: a, turnId: ta, state: 'working', title: 'First chat' },
      { threadId: b, turnId: tb, state: 'success', title: 'Second chat' },
    ]);
    appendFileSync(af, event('task_complete', ta, '2026-10-31T08:04:00Z'));
    chosen = await fixture.monitor.read();
    assert.equal(chosen.threadId, a);
    assert.equal(chosen.state, 'success');
    assert.equal(chosen.unreadCount, 2);
    writeFileSync(join(fixture.directory, 'acknowledged-status.json'), JSON.stringify({ threadId: a, turnId: ta }));
    chosen = await fixture.monitor.read();
    assert.equal(chosen.threadId, b, 'the other unread completion must remain available');
    assert.deepEqual(chosen.activities, [{ threadId: b, turnId: tb, state: 'success', title: 'Second chat' }]);
    writeFileSync(join(fixture.directory, 'acknowledged-status.json'), JSON.stringify({
      threadId: b, turnId: tb, readTurns: { [a]: ta, [b]: tb },
    }));
    const restarted = integration.createAutomaticSessionReader({ ...fixture, since });
    assert.equal((await restarted.read()).state, null, 'acknowledgements must survive restart across chats');
    appendFileSync(bf, event('task_started', tc, '2026-10-31T08:05:00Z'));
    assert.equal((await restarted.read()).threadId, b);
    appendFileSync(bf, event('task_complete', tc, '2026-10-31T08:06:00Z'));
    assert.equal((await restarted.read()).state, 'success', 'the next turn must not inherit an old acknowledgement');
  } finally {
    fixture.cleanup();
  }
});

test('an older duplicate transcript cannot add a second row or resurrect an older turn', async () => {
  const fixture = setup();
  try {
    const old = fixture.session(a);
    appendFileSync(old, event('task_started', ta, '2026-10-31T08:01:00Z'));
    const latest = join(fixture.sessionsDirectory, '2026', '10', '29', `rollout-2026-10-29T15-02-03-${a}.jsonl`);
    writeFileSync(latest, line({ type: 'session_meta', payload: {
      id: a, source: 'vscode', originator: 'Codex Desktop', thread_source: 'user',
    } }) + event('task_started', tc, '2026-10-31T08:02:00Z') +
      event('turn_aborted', tc, '2026-10-31T08:03:00Z'));

    let chosen = await fixture.monitor.read();
    assert.equal(chosen.state, 'stopped');
    assert.deepEqual(chosen.activities, [{ threadId: a, turnId: tc, state: 'stopped', title: '' }]);
    writeFileSync(join(fixture.directory, 'acknowledged-status.json'), JSON.stringify({ threadId: a, turnId: tc }));
    chosen = await fixture.monitor.read();
    assert.equal(chosen.state, null);
    assert.deepEqual(chosen.activities, []);
  } finally {
    fixture.cleanup();
  }
});

test('automatic selection ignores CLI, child sessions, old app lifetimes and old-file metadata writes', async () => {
  const fixture = setup();
  try {
    const af = fixture.session(a);
    appendFileSync(af, event('task_started', ta, '2026-10-30T08:01:00Z'));
    const bf = fixture.session(b, { source: 'cli', originator: 'codex_cli_rs' });
    appendFileSync(bf, event('task_started', tb, '2026-10-31T08:09:00Z'));
    const cf = fixture.session(child, { thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: a } } } });
    appendFileSync(cf, event('task_started', tc, '2026-10-31T08:10:00Z'));
    assert.equal((await fixture.monitor.read()).state, null);
    appendFileSync(af, event('task_started', tb, '2026-10-31T08:11:00Z'));
    assert.equal((await fixture.monitor.read()).threadId, a, 'resuming an old file must be detected');
    appendFileSync(af, event('task_started', tc, '2026-10-31T08:12:00Z', tb));
    appendFileSync(af, event('task_complete', tc, '2026-10-31T08:13:00Z', tb));
    assert.equal((await fixture.monitor.read()).turnId, tb, 'a child event cannot replace the root');
    appendFileSync(af, event('turn_aborted', tb, '2026-10-31T08:14:00Z'));
    assert.equal((await fixture.monitor.read()).state, 'stopped');
    rmSync(af);
    assert.equal((await fixture.monitor.read()).state, null, 'a removed session cannot stay stuck running');
  } finally {
    fixture.cleanup();
  }
});

test('automatic publication switches the saved click target and clears only after all displayed completions are read', async () => {
  const fixture = setup();
  const requests = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['x-dsh-pet-token'], 'private-test-token');
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(req.method === 'DELETE' ? null : JSON.parse(body));
    res.writeHead(req.method === 'DELETE' ? 204 : 200);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  writeFileSync(join(fixture.directory, 'conversation.json'), JSON.stringify({ mode: 'automatic', threadId: child }));
  const af = fixture.session(a);
  appendFileSync(af, event('task_started', ta, '2026-10-31T08:01:00Z'));
  const stop = integration.followSessionStatus({
    ...fixture, since, intervalMs: 20,
    token: 'private-test-token',
    configUrl: `http://127.0.0.1:${server.address().port}/dsh-pet-7340/config`,
  });
  function saved() {
    try { return JSON.parse(readFileSync(join(fixture.directory, 'session-status.json'), 'utf8')); } catch { return {}; }
  }
  async function waitFor(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await delay(20);
    }
    assert.fail('automatic status never reached the app boundary');
  }
  try {
    await waitFor(() => saved().threadId === a);
    const bf = fixture.session(b);
    appendFileSync(bf, event('task_started', tb, '2026-10-31T08:02:00Z'));
    await waitFor(() => saved().threadId === b && saved().runningCount === 2);
    assert.match(requests.at(-1).task, /2/);
    appendFileSync(bf, event('turn_aborted', tb, '2026-10-31T08:03:00Z'));
    await waitFor(() => saved().threadId === a && saved().state === 'working');
    assert.deepEqual(saved().activities, [
      { threadId: a, turnId: ta, state: 'working', title: '' },
      { threadId: b, turnId: tb, state: 'stopped', title: '' },
    ]);
    appendFileSync(af, event('task_complete', ta, '2026-10-31T08:04:00Z'));
    await waitFor(() => saved().threadId === a && saved().state === 'success');
    const requestCount = requests.length;
    writeFileSync(join(fixture.directory, 'session_index.jsonl'), line({ id: b, thread_name: 'Second chat' }));
    await waitFor(() => saved().activities?.[1]?.title === 'Second chat');
    assert.equal(requests.length, requestCount, 'changing another activity title must not restart the primary animation');
    writeFileSync(join(fixture.directory, 'acknowledged-status.json'), JSON.stringify({ threadId: a, turnId: ta }));
    await waitFor(() => saved().threadId === b && saved().state === 'stopped');
    assert.equal(requests.at(-1).state, 'error');
    assert.match(requests.at(-1).task, /\u672c\u8f6e\u5df2\u4e2d\u65ad/u);
    writeFileSync(join(fixture.directory, 'acknowledged-status.json'), JSON.stringify({ readTurns: { [a]: ta, [b]: tb } }));
    await waitFor(() => saved().state === null);
    assert.equal(requests.at(-1), null);
    assert.equal(saved().threadId, null);
    assert.deepEqual(saved().activities, []);
  } finally {
    stop();
    await new Promise((resolve) => server.close(resolve));
    fixture.cleanup();
  }
});
