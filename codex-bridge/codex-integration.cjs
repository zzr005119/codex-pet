/**
 * Codex 会话状态、跳转与桌宠退出监听。
 * 只向本机桌宠服务发送生命周期状态；宿主或联动器退出后请求 Electron 正常退出。
 * @module codex-pet-integration
 */
'use strict';
const { readFileSync, appendFileSync, openSync, readSync, closeSync, fstatSync, writeFileSync, readdirSync, existsSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { homedir } = require('node:os');
const { setImmediate: yieldLoop } = require('node:timers/promises');
const path = require('node:path');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID.test(value);
const isTerminal = (state) => state === 'success' || state === 'stopped' || state === 'error';

/** 只构造 Codex 会话链接，配置丢失时回到应用。 */
function readConversationUrl(file) {
  try {
    const { threadId } = JSON.parse(readFileSync(file, 'utf8'));
    return UUID.test(threadId) ? `codex://threads/${threadId}` : 'codex://';
  } catch {
    return 'codex://';
  }
}

/** 仅进程确已消失时退出；权限错误不能视为退出。 */
function watchHost(pid, onGone, intervalMs = 2000) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return () => {};
  const timer = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        clearInterval(timer);
        onGone();
      }
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Incrementally consume lifecycle markers; never retain or forward message text. */
function createSessionReader(file, threadId) {
  let offset = 0;
  let identity = null;
  let prefix = null;
  let decoder = new StringDecoder('utf8');
  let pending = '';
  let bound = false;
  let desktop = false;
  let startedAt = 0;
  let changedAt = 0;
  let snapshot = { state: 'waiting', turnId: null };
  function reset() {
    offset = 0;
    pending = '';
    decoder = new StringDecoder('utf8');
    bound = false;
    desktop = false;
    startedAt = 0;
    changedAt = 0;
    snapshot = { state: 'waiting', turnId: null };
  }
  function consume(line) {
    if (!line.includes('"session_meta"') &&
        !line.includes('"task_started"') && !line.includes('"task_complete"') &&
        !line.includes('"turn_aborted"')) return;
    let item;
    try { item = JSON.parse(line); } catch { return; }
    const payload = item?.payload;
    if (item?.type === 'session_meta') {
      bound = UUID.test(threadId) && payload?.id === threadId;
      desktop = bound && payload.originator === 'Codex Desktop' && payload.source === 'vscode' &&
        (!payload.thread_source || payload.thread_source === 'user');
      snapshot = { state: 'waiting', turnId: null };
      return;
    }
    if (!bound || item?.type !== 'event_msg' || !payload) return;
    const turnId = payload.turn_id;
    if (!UUID.test(turnId)) return;
    if (payload.root_turn_id && payload.root_turn_id !== turnId) return;
    if (payload.turn_attribution?.initiating_agent_path) return;
    const timestamp = Date.parse(item.timestamp || payload.completed_at || payload.started_at) || 0;
    if (payload.type === 'task_started') {
      snapshot = { state: 'working', turnId };
      startedAt = timestamp;
      changedAt = timestamp;
    }
    if (turnId !== snapshot.turnId || snapshot.state !== 'working') return;
    if (payload.type === 'turn_aborted') {
      snapshot = { state: 'stopped', turnId };
      changedAt = timestamp;
    } else if (payload.type === 'task_complete') {
      const error = payload.error;
      const failed = error !== null && typeof error === 'object' && !Array.isArray(error);
      snapshot = { state: failed ? 'error' : 'success', turnId };
      changedAt = timestamp;
    }
  }
  return {
    details() { return { desktop, startedAt, changedAt }; },
    read() {
      let fd;
      try {
        fd = openSync(file, 'r');
        const stat = fstatSync(fd);
        const nextIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        const head = Buffer.alloc(Math.min(stat.size, 256));
        readSync(fd, head, 0, head.length, 0);
        const prefixChanged = prefix && !head.subarray(0, prefix.length).equals(prefix);
        if (identity !== nextIdentity || stat.size < offset || prefixChanged) reset();
        identity = nextIdentity;
        prefix = head;
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (offset < stat.size) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
          if (!count) break;
          offset += count;
          pending += decoder.write(buffer.subarray(0, count));
          let newline;
          while ((newline = pending.indexOf('\n')) !== -1) {
            consume(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
        }
      } catch {
        reset();
        identity = null;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      return { ...snapshot };
    },
  };
}

function readAcknowledgements(directory) {
  const result = new Map();
  try {
    const data = JSON.parse(readFileSync(path.join(directory, 'acknowledged-status.json'), 'utf8'));
    for (const [threadId, turnId] of Object.entries(data.readTurns || {})) {
      if (UUID.test(threadId) && UUID.test(turnId)) result.set(threadId, turnId);
    }
    if (UUID.test(data.threadId) && UUID.test(data.turnId)) result.set(data.threadId, data.turnId);
  } catch {}
  return result;
}

function listTranscripts(directory, depth = 0, result = []) {
  if (depth > 3) return result;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) listTranscripts(file, depth + 1, result);
    else if (entry.isFile() && entry.name.startsWith('rollout-')) {
      const threadId = entry.name.slice(-42, -6);
      if (entry.name.endsWith('.jsonl') && UUID.test(threadId)) result.push({ file, threadId });
    }
  }
  return result;
}

/** Prefer running desktop root chats, then the latest unread terminal chat. */
function createAutomaticSessionReader({ directory, sessionsDirectory, since = Date.now() }) {
  const readers = new Map();
  return {
    async read() {
      const files = listTranscripts(sessionsDirectory);
      const present = new Set(files.map(({ file }) => file));
      for (const file of readers.keys()) if (!present.has(file)) readers.delete(file);
      const acknowledged = readAcknowledgements(directory);
      const byThread = new Map();
      for (const { file, threadId } of files) {
        let reader = readers.get(file);
        if (!reader) {
          reader = createSessionReader(file, threadId);
          readers.set(file, reader);
        }
        const snapshot = reader.read();
        const details = reader.details();
        // A previous app lifetime can leave a start marker without a matching end.
        if (details.desktop && snapshot.turnId && details.startedAt >= since) {
          const current = byThread.get(threadId);
          if (!current || details.startedAt > current.startedAt ||
              (details.startedAt === current.startedAt && details.changedAt >= current.changedAt &&
                (details.changedAt > current.changedAt || isTerminal(snapshot.state)))) {
            byThread.set(threadId, { threadId, ...snapshot, ...details });
          }
        }
        await yieldLoop();
      }
      const candidates = [...byThread.values()];
      const running = candidates.filter((item) => item.state === 'working')
        .sort((left, right) => right.startedAt - left.startedAt || left.threadId.localeCompare(right.threadId));
      const unread = candidates.filter((item) => isTerminal(item.state) && acknowledged.get(item.threadId) !== item.turnId)
        .sort((left, right) => right.changedAt - left.changedAt || left.threadId.localeCompare(right.threadId));
      const visible = [...running, ...unread];
      const titles = new Map();
      if (visible.length) {
        try {
          const visibleIds = new Set(visible.map(({ threadId }) => threadId));
          for (const line of readFileSync(path.join(sessionsDirectory, '..', 'session_index.jsonl'), 'utf8').split('\n')) {
            let item;
            try { item = JSON.parse(line); } catch { continue; }
            if (visibleIds.has(item?.id) && typeof item.thread_name === 'string') {
              titles.set(item.id, Array.from(item.thread_name.replace(/\s+/g, ' ').trim()).slice(0, 28).join(''));
            }
          }
        } catch {}
      }
      const activities = visible.map(({ threadId, turnId, state }) => ({
        threadId, turnId, state, title: titles.get(threadId) || '',
      }));
      const selected = activities[0];
      return {
        threadId: selected?.threadId || null, turnId: selected?.turnId || null,
        state: selected?.state || null, title: selected?.title || '',
        runningCount: running.length, unreadCount: unread.length, activities,
      };
    },
  };
}

function findTranscript(directory, threadId, depth = 0) {
  if (!UUID.test(threadId) || depth > 3) return null;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`)) {
      return path.join(directory, entry.name);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{2,4}$/.test(entry.name)) continue;
    const found = findTranscript(path.join(directory, entry.name), threadId, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Use the app's authenticated loopback route; retry without persisting its token. */
function followSessionStatus({ directory, sessionsDirectory, configUrl, token, intervalMs = 750,
  since = Date.now(), record = () => {}, onSnapshot = () => {} }) {
  const url = new URL(configUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/dsh-pet-7340/config' || !token) {
    throw new Error('Invalid local pet service configuration');
  }
  url.pathname = '/dsh-pet-7340/work-status';
  url.search = '';
  let reader = null;
  let transcript = null;
  let threadId = null;
  let lastSent = null;
  let lastActivities = null;
  let nextSearch = 0;
  let busy = false;
  let stopped = false;
  let failed = false;
  let controller = null;
  const automatic = createAutomaticSessionReader({ directory, sessionsDirectory, since });
  const labels = {
    working: '会话正在运行', success: '本轮已完成', stopped: '本轮已中断', error: '本轮已失败', waiting: '等待会话状态',
  };
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      let boundId = null;
      let mode = 'fixed';
      try {
        const config = JSON.parse(readFileSync(path.join(directory, 'conversation.json'), 'utf8'));
        if (config.mode === 'automatic') mode = 'automatic';
        if (UUID.test(config.threadId)) boundId = config.threadId;
      } catch {}
      if (mode === 'fixed' && boundId !== threadId) {
        threadId = boundId;
        transcript = null;
        reader = null;
        lastSent = null;
        nextSearch = 0;
      }
      if (transcript && !existsSync(transcript)) {
        transcript = null;
        reader = null;
        nextSearch = 0;
      }
      if (mode === 'fixed' && !reader && threadId && Date.now() >= nextSearch) {
        nextSearch = Date.now() + 10000;
        transcript = findTranscript(sessionsDirectory, threadId);
        if (transcript) reader = createSessionReader(transcript, threadId);
      }
      const snapshot = mode === 'automatic' ? await automatic.read() :
        reader ? reader.read() : { state: 'waiting', turnId: null };
      if (mode === 'automatic') threadId = snapshot.threadId;
      const acknowledged = isTerminal(snapshot.state) && readAcknowledgements(directory).get(threadId) === snapshot.turnId;
      const { activities = [], ...status } = snapshot;
      const key = JSON.stringify({ mode, threadId, ...status, acknowledged });
      const activityKey = JSON.stringify(activities);
      if (key === lastSent && activityKey === lastActivities) return;
      if (key !== lastSent) {
        controller = new AbortController();
        const timeout = setTimeout(() => controller?.abort(), 3000);
        let response;
        try {
          response = await fetch(url, {
            method: acknowledged || !snapshot.state ? 'DELETE' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-DSH-Pet-Token': token },
            body: acknowledged || !snapshot.state ? undefined : JSON.stringify({
              state: snapshot.state === 'stopped' ? 'error' : snapshot.state,
              task: mode === 'automatic' ? [
                snapshot.state === 'working' && snapshot.runningCount > 1 ?
                  `${snapshot.runningCount} 条会话运行中` : labels[snapshot.state],
                snapshot.title || `会话 ${threadId.slice(-6)}`,
              ].join(' · ') : labels[snapshot.state],
            }),
            signal: controller.signal,
            redirect: 'error',
          });
          await response.arrayBuffer();
        } finally {
          clearTimeout(timeout);
          controller = null;
        }
        if (!response.ok) throw new Error('Local pet status request failed');
      }
      if (stopped) return;
      const published = {
        mode, threadId, ...status, acknowledged, activities, source: 'local-session-events', updated: new Date().toISOString(),
      };
      writeFileSync(path.join(directory, 'session-status.json'), JSON.stringify(published, null, 2));
      onSnapshot(published);
      lastSent = key;
      lastActivities = activityKey;
      failed = false;
      record(`session-status:${acknowledged ? 'read' : snapshot.state}`);
    } catch {
      if (!failed && !stopped) record('session-status-unavailable');
      failed = true;
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    controller?.abort();
  };
}

/** One sound per new terminal turn; the first snapshot only establishes a baseline. */
function createCompletionCue(emit) {
  const seen = new Set();
  let previousMode;
  return (snapshot) => {
    const baseline = snapshot.mode !== previousMode;
    previousMode = snapshot.mode;
    const activities = snapshot.mode === 'automatic' ? snapshot.activities :
      snapshot.acknowledged ? [] : [snapshot];
    let cue;
    for (const { threadId, turnId, state } of activities) {
      if (!threadId || !turnId || (state !== 'success' && state !== 'error')) continue;
      const key = threadId + ':' + turnId;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!baseline && cue !== 'error') cue = state;
    }
    if (cue) emit(cue);
  };
}

/** 注册受控跳转，并跟随宿主及联动器的生命周期。 */
function install({ app, ipcMain, shell, BrowserWindow, onCompletion = () => {} }) {
  const directory = process.env.DSH_PET_CODEX_DATA;
  if (!directory) return;
  const configFile = path.join(directory, 'conversation.json');
  const statusFile = path.join(directory, 'session-status.json');
  const token = process.env.DSH_PET_APP_TOKEN;
  const configUrl = process.env.DSH_PET_CONFIG_URL;
  const shownActivities = new WeakMap();
  const checkCompletion = createCompletionCue(onCompletion);
  let latestPublished = null;
  const record = (event) => {
    appendFileSync(path.join(directory, 'integration.log'), `${new Date().toISOString()} ${event}\n`);
  };
  function currentActivities() {
    try {
      if (JSON.parse(readFileSync(configFile, 'utf8')).mode !== 'automatic') return null;
    } catch {
      return null;
    }
    try {
      const snapshot = token && configUrl ? latestPublished : JSON.parse(readFileSync(statusFile, 'utf8'));
      if (snapshot?.mode !== 'automatic' || !Array.isArray(snapshot.activities)) return [];
      const read = readAcknowledgements(directory);
      return snapshot.activities.filter((item) => isUuid(item?.threadId) && isUuid(item.turnId) &&
        (item.state === 'working' || (isTerminal(item.state) && read.get(item.threadId) !== item.turnId)))
        .map(({ threadId, turnId, state, title }) => ({ threadId, turnId, state, title: typeof title === 'string' ? title : '' }));
    } catch {
      return [];
    }
  }
  ipcMain.handle('pet:codex-activities', (event) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return null;
    const activities = currentActivities();
    shownActivities.set(event.sender, activities);
    return activities;
  });
  async function openConversationUrl(url, completed) {
    try {
      await shell.openExternal(url);
      record('conversation-opened');
      if (completed) {
        const read = readAcknowledgements(directory);
        read.set(completed.threadId, completed.turnId);
        writeFileSync(path.join(directory, 'acknowledged-status.json'), JSON.stringify({
          ...completed, readTurns: Object.fromEntries(read),
        }));
        record('completion-acknowledged');
      }
    } catch {
      record('conversation-open-failed');
    }
  }
  function openDefaultConversation() {
    let url = readConversationUrl(configFile);
    let completed = null;
    try {
      const snapshot = JSON.parse(readFileSync(statusFile, 'utf8'));
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      if (config.mode === 'automatic') {
        url = isUuid(snapshot.threadId) ? `codex://threads/${snapshot.threadId}` : 'codex://';
      }
      if (isTerminal(snapshot.state) && isUuid(snapshot.turnId) && url === `codex://threads/${snapshot.threadId}`) {
        completed = { threadId: snapshot.threadId, turnId: snapshot.turnId };
      }
    } catch {}
    return openConversationUrl(url, completed);
  }
  function openConversation(event, requested) {
    if (!BrowserWindow.fromWebContents(event.sender)) return;
    if (requested === undefined) return openDefaultConversation();
    const { threadId, turnId, state: displayedState } = requested || {};
    if (!isUuid(threadId) || !isUuid(turnId) || (displayedState !== 'working' && !isTerminal(displayedState))) return;
    const matches = (item) => item.threadId === threadId && item.turnId === turnId;
    const shown = shownActivities.get(event.sender)?.find(matches);
    if (!shown) return;
    const target = currentActivities()?.find(matches);
    if (!target) return;
    // A poll may have delivered completion while the renderer still shows the running row.
    const completed = isTerminal(displayedState) && shown.state === displayedState && target.state === displayedState
      ? { threadId, turnId } : null;
    return openConversationUrl(`codex://threads/${threadId}`, completed);
  }
  ipcMain.on('pet:open-codex', openConversation);
  const releases = [
    watchHost(Number(process.env.DSH_PET_CODEX_HOST_PID), () => { record('host-exited'); app.quit(); }),
    watchHost(Number(process.env.DSH_PET_CODEX_BRIDGE_PID), () => { record('bridge-exited'); app.quit(); }),
  ];
  if (token && configUrl) {
    releases.push(followSessionStatus({
      directory,
      sessionsDirectory: path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions'),
      configUrl,
      token,
      since: Date.parse(process.env.DSH_PET_CODEX_HOST_STARTED) || Date.now(),
      record,
      onSnapshot: (snapshot) => {
        latestPublished = snapshot;
        checkCompletion(snapshot);
      },
    }));
  }
  app.once('will-quit', () => {
    releases.forEach((release) => release());
    ipcMain.removeListener('pet:open-codex', openConversation);
    ipcMain.removeHandler('pet:codex-activities');
  });
  record('integration-ready');
  return () => {
    const activities = currentActivities();
    if (activities === null) return openDefaultConversation();
    if (activities.length === 0) return openConversationUrl('codex://', null);
    const { threadId, turnId, state } = activities[0];
    return openConversationUrl(`codex://threads/${threadId}`, isTerminal(state) ? { threadId, turnId } : null);
  };
}

module.exports = { readConversationUrl, watchHost, createSessionReader, createAutomaticSessionReader, followSessionStatus, createCompletionCue, install };
