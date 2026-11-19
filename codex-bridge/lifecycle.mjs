/** Identify Codex desktop lifetimes and own exactly one pet process. */
export function selectCodexHost(processes) {
  return processes.find((entry) =>
    Number.isSafeInteger(entry.pid) && entry.pid > 0 &&
    /\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$/i.test(entry.path ?? '') &&
    !/(?:^|\s)--type=/.test(entry.commandLine ?? '')
  ) ?? null;
}

/** A manually closed pet stays closed for the current host lifetime. */
export function createLifecycle({ start, stop }) {
  let lifetime = '';
  let child = null;
  return {
    async update(host) {
      const next = host ? `${host.pid}:${host.created ?? ''}` : '';
      if (next === lifetime) return child;
      if (child && child.exitCode === null && child.signalCode === null) await stop(child);
      child = null;
      lifetime = '';
      if (!host) return null;
      child = await start(host);
      lifetime = next;
      return child;
    },
  };
}
