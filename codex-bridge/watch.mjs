/**
 * Follow Codex desktop roots and own one external pet process.
 * The process probe is local and persistent; failed probes never count as app exits.
 * A named pipe prevents duplicate login launchers.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { selectCodexHost, createLifecycle } from './lifecycle.mjs';

const bridgeDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(bridgeDir, '..');
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const logFile = join(dataDir, 'bridge.log');
function record(event, fields = {}) {
  appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n');
}
const lock = createServer();
lock.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') record('lock-error', { code: error.code });
  process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
});
const userKey = (process.env.USERNAME ?? 'user').replace(/\W/g, '_');
// A portable copy only shares its lock with launchers for the same folder.
const portableKey = process.env.DSH_PET_PORTABLE === '1'
  ? '-' + createHash('sha256').update(realpathSync.native(root).toLowerCase()).digest('hex').slice(0, 24)
  : '';
lock.listen('\\\\.\\pipe\\codex-dsh-pet-' + userKey + portableKey, () => run());

function run() {
  let pet = null;
  let stopping = false;
  let hostPid = null;
  const lifecycle = createLifecycle({
    start: async (host) => {
      const environment = {
        ...process.env,
        DSH_HOME: dataDir,
        DSH_PET_CODEX_DATA: dataDir,
        DSH_PET_CODEX_HOST_PID: String(host.pid),
        DSH_PET_CODEX_HOST_STARTED: host.created,
        DSH_PET_CODEX_BRIDGE_PID: String(process.pid),
        DSH_PET_GPU_SANDBOX: '1',
      };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = spawn(join(root, 'app', 'dsh-pet.exe'), [], {
        env: environment,
        cwd: join(root, 'app'),
        windowsHide: true,
        stdio: 'ignore',
      });
      child.on('error', (error) => record('pet-error', { code: error.code }));
      await once(child, 'spawn');
      pet = child;
      child.on('exit', (code, signal) => {
        record('pet-exited', { pid: child.pid, code, signal });
        if (pet === child) pet = null;
        saveState();
      });
      record('pet-started', { pid: child.pid, hostPid: host.pid });
      return child;
    },
    stop: async (child) => {
      // Electron's integration quits gracefully when its captured host disappears.
      const exited = once(child, 'exit');
      const outcome = await Promise.race([
        exited.then(() => true),
        new Promise((done) => setTimeout(() => done(false), 6000)),
      ]);
      if (!outcome && child.exitCode === null && child.signalCode === null) {
        record('pet-stop-fallback', { pid: child.pid });
        child.kill();
        await exited;
      }
    },
  });
  function saveState() {
    writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify({
      bridgePid: process.pid, hostPid, petPid: pet?.pid ?? null, updated: new Date().toISOString(),
    }, null, 2));
  }
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let queue = Promise.resolve();
  const probe = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(bridgeDir, 'probe.ps1')], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  createInterface({ input: probe.stdout }).on('line', (line) => {
    queue = queue.then(async () => {
      if (stopping) return;
      const snapshot = JSON.parse(line);
      if (!snapshot.ok) return;
      const host = selectCodexHost(snapshot.processes);
      const nextPid = host?.pid ?? null;
      if (nextPid !== hostPid) record('host-changed', { hostPid: nextPid });
      hostPid = nextPid;
      await lifecycle.update(host);
      saveState();
    }).catch((error) => record('reconcile-error', { message: error.message }));
  });
  probe.on('error', (error) => { record('probe-error', { code: error.code }); process.exit(1); });
  probe.on('exit', () => { if (!stopping) { record('probe-exited'); process.exit(1); } });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    record('bridge-stopped');
    probe.kill();
    lock.close();
    process.exit(0);
  };
  const poll = setInterval(() => { if (existsSync(join(dataDir, 'stop-bridge'))) stop(); }, 2000);
  poll.unref();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  record('bridge-started', { pid: process.pid });
  saveState();
}
