// The host's view of one sandbox: its cgroup, read while a look runs. Under gVisor the whole sandbox
// kernel (the Sentry and its host threads) is in this cgroup, so what it shows is what the limits in
// LIMITS (runner/sandbox.mjs) act on: memory (with the tmpfs folders, which live in RAM) and
// processes. Read-only: nothing here writes to a cgroup. Plain functions over files, so
// test/agent-loop.mjs --unit checks them on a folder of fake files (U18).
import { readFileSync, watch } from 'node:fs';
import path from 'node:path';

/** Where the host mounts its cgroups. */
export const CGROUP_ROOT = '/sys/fs/cgroup';

/**
 * The cgroup folders named in the text of /proc/<pid>/cgroup, most likely first: the cgroup v2 line
 * ("0::/system.slice/docker-<id>.scope"), then the v1 line of the pids controller.
 * @param {string} procText
 * @param {string} [root]
 * @returns {string[]}
 */
export function cgroupDirs(procText, root = CGROUP_ROOT) {
  const v2 = [];
  const v1 = [];
  for (const line of String(procText ?? '').split('\n')) {
    const m = /^(\d+):([^:]*):(\/.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === '0' && m[2] === '') v2.push(path.join(root, m[3]));
    else if (m[2].split(',').includes('pids')) v1.push(path.join(root, 'pids', m[3]));
  }
  return [...v2, ...v1];
}

/** "key value" lines (memory.events, pids.events) as numbers by key; anything else is skipped. */
export function parseEvents(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([a-z_]+) (\d+)$/.exec(line.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** A cgroup v2 number file: a whole number, Infinity for "max", or null when absent or unreadable. */
function readNumber(dir, file) {
  try {
    const t = readFileSync(path.join(dir, file), 'utf8').trim();
    if (t === 'max') return Infinity;
    return /^\d+$/.test(t) ? Number(t) : null;
  } catch {
    return null;
  }
}

/**
 * The cgroup v2 folder of a container's main process (under gVisor, the sandbox kernel), from the
 * text of its /proc/<pid>/cgroup: the first candidate that has memory.current and pids.current.
 * @param {string} procText
 * @param {{root?: string, id?: string}} [o]  id: the container's full id, for Docker's usual folders
 * @returns {string|null}
 */
export function usageDir(procText, { root = CGROUP_ROOT, id = '' } = {}) {
  const usual = /^[0-9a-f]{64}$/.test(id) ? [path.join(root, 'system.slice', `docker-${id}.scope`), path.join(root, 'docker', id)] : [];
  // A v1 pids folder has no memory.current, so only a v2 folder can pass.
  for (const dir of [...new Set([...cgroupDirs(procText, root), ...usual])]) {
    if (readNumber(dir, 'memory.current') !== null && readNumber(dir, 'pids.current') !== null) return dir;
  }
  return null;
}

/**
 * What the cgroup showed while it was watched: its limits, the memory and processes at the first
 * reading and the most at once, and what the kernel counted since the watch began: memory.events
 * `max` (usage reached the limit), `oom` and `oom_kill`, and pids.events `max` (a fork or a new
 * thread refused at the limit). `gone`: the folder disappeared, which happens when the container stops.
 * @typedef {{dir: string, reads: number, gone: boolean, error: string, memMax: number|null, memStart: number|null, memPeak: number,
 *   pidsMax: number|null, pidsStart: number|null, pidsPeak: number, atMemLimit: number, oom: number, oomKill: number, pidsRefused: number, ms: number}} Usage
 */

/**
 * Read a cgroup v2 folder every `everyMs` ms until stop(), and at once whenever the kernel reports a
 * change to memory.events or pids.events (fs.watch, where inotify works). Docker removes the folder
 * with the container, so what counts is what was read before it went.
 * @param {string} dir
 * @param {{everyMs?: number}} [o]
 * @returns {{stop(): Usage}}
 */
export function watchUsage(dir, { everyMs = 200 } = {}) {
  const t0 = Date.now();
  const seen = {
    dir, reads: 0, gone: false, error: '', memMax: readNumber(dir, 'memory.max'), memStart: null, memPeak: 0, pidsMax: readNumber(dir, 'pids.max'),
    pidsStart: null, pidsPeak: 0, atMemLimit: 0, oom: 0, oomKill: 0, pidsRefused: 0, ms: 0,
  };
  let start = null;
  const read = () => {
    if (seen.gone) return;
    try {
      const mem = Number(readFileSync(path.join(dir, 'memory.current'), 'utf8').trim());
      const pids = Number(readFileSync(path.join(dir, 'pids.current'), 'utf8').trim());
      const me = parseEvents(readFileSync(path.join(dir, 'memory.events'), 'utf8'));
      const pe = parseEvents(readFileSync(path.join(dir, 'pids.events'), 'utf8'));
      seen.reads += 1;
      if (Number.isFinite(mem)) { seen.memStart ??= mem; seen.memPeak = Math.max(seen.memPeak, mem); }
      if (Number.isFinite(pids)) { seen.pidsStart ??= pids; seen.pidsPeak = Math.max(seen.pidsPeak, pids); }
      start ??= { max: me.max ?? 0, oom: me.oom ?? 0, oomKill: me.oom_kill ?? 0, pids: pe.max ?? 0 };
      seen.atMemLimit = Math.max(seen.atMemLimit, (me.max ?? 0) - start.max);
      seen.oom = Math.max(seen.oom, (me.oom ?? 0) - start.oom);
      seen.oomKill = Math.max(seen.oomKill, (me.oom_kill ?? 0) - start.oomKill);
      seen.pidsRefused = Math.max(seen.pidsRefused, (pe.max ?? 0) - start.pids);
    } catch (err) {
      if (err.code === 'ENOENT' && seen.reads > 0) seen.gone = true;
      else seen.error ||= String(err.code ?? err.message).slice(0, 80);
    }
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref?.();
  const watchers = [];
  for (const f of ['memory.events', 'pids.events']) {
    try {
      const w = watch(path.join(dir, f), { persistent: false }, read);
      w.on('error', () => {}); // the folder went away; the timer's next read records that
      watchers.push(w);
    } catch {
      // no inotify here: the timer alone reads
    }
  }
  return {
    stop() {
      clearInterval(timer);
      for (const w of watchers) {
        try { w.close(); } catch { /* already closed */ }
      }
      read();
      seen.ms = Date.now() - t0;
      return { ...seen };
    },
  };
}

const gb = (bytes) => `${(bytes / 2 ** 30).toFixed(2)} GB`;
const limitText = (n, unit) => (n === null ? 'no limit read' : n === Infinity ? 'no limit' : unit(n));

/**
 * What the usage says about a look that died: 'memory' when the kernel counted an OOM or the folder
 * went away with memory at its limit, 'pids' when a fork or thread was refused at the process limit,
 * 'sandbox' when the folder went away (the sandbox stopped) for no reason it shows, or null.
 * @param {Usage|null} u
 * @returns {'memory'|'pids'|'sandbox'|null}
 */
export function usageVerdict(u) {
  if (!u || u.reads === 0) return null;
  const nearMemLimit = Number.isFinite(u.memMax) && u.memMax > 0 && u.memPeak >= u.memMax * 0.97;
  if (u.oom > 0 || u.oomKill > 0 || (u.gone && (u.atMemLimit > 0 || nearMemLimit))) return 'memory';
  if (u.pidsRefused > 0 || (u.gone && Number.isFinite(u.pidsMax) && u.pidsPeak >= u.pidsMax)) return 'pids';
  if (u.gone) return 'sandbox';
  return null;
}

/**
 * One line for the journal: "memory: 1.21 GB at the start, at most 2.91 GB of 4.00 GB, at the limit 4
 * times, 0 OOM, 0 OOM kills · processes: 60 at the start, at most 230 of 512, 0 refused · 41 reads in 4.9 s".
 */
export function usageText(u) {
  if (!u) return 'host cgroup not read';
  if (u.reads === 0) return `host cgroup not read (${u.error || 'no reading'})`;
  const start = (n, f) => (Number.isFinite(n) ? `${f(n)} at the start, ` : '');
  return `memory: ${start(u.memStart, gb)}at most ${gb(u.memPeak)} of ${limitText(u.memMax, gb)}, at the limit ${u.atMemLimit} time${u.atMemLimit === 1 ? '' : 's'}, `
    + `${u.oom} OOM, ${u.oomKill} OOM kill${u.oomKill === 1 ? '' : 's'} · processes: ${start(u.pidsStart, String)}at most ${u.pidsPeak} of ${limitText(u.pidsMax, String)}, `
    + `${u.pidsRefused} refused · ${u.reads} reads in ${(u.ms / 1000).toFixed(1)} s${u.gone ? ' · the cgroup went away (the sandbox stopped)' : ''}`;
}
