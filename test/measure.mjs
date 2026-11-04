// What test/containment.mjs and test/scenes.mjs read on the host while a sandbox is under attack, and
// the rules that turn those readings into PASS or FAIL. Only pidsCgroup() asks Docker; everything
// else is plain functions over strings and files, so test/agent-loop.mjs --unit checks it (U14).
// A check here passes only on what was measured: a sandbox that stopped for a reason nobody measured
// is reported as such, never as "held at the cap".
import { readFileSync, watch } from 'node:fs';
import path from 'node:path';
import { run } from '../runner/sandbox.mjs';

/** Where the host mounts its cgroups. */
export const CGROUP_ROOT = '/sys/fs/cgroup';

// --- Reaching an address ------------------------------------------------------------------------------
/**
 * The results of a TCP connect that mean the address was never reached: no route to it, no such
 * local address, or no answer within the probe's 3 s. Anything else is an answer from the address:
 * a refusal (ECONNREFUSED) or a reset (ECONNRESET) comes from a host that the packet reached.
 */
export const UNREACHED = Object.freeze(['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'timeout']);
/** True when a connect result shows that the address was not reached (UNREACHED). */
export const unreached = (result) => UNREACHED.includes(result);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** The IPv6 addresses (anything that is not dotted IPv4) in a list of addresses. */
export const ipv6Of = (addresses) => (Array.isArray(addresses) ? addresses : []).filter((a) => typeof a === 'string' && a !== '' && !IPV4.test(a));

// --- The process cap, read from the host -------------------------------------------------------------
/** A path with every 64-digit container id cut to 12 digits, for the detail of a check. */
const short = (p) => String(p).replace(/[0-9a-f]{64}/g, (id) => `${id.slice(0, 12)}…`);

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

/** The "max" counter of a pids.events file: how many forks the cgroup refused at its limit (0 when absent). */
export function parsePidsEvents(text) {
  const m = /^max (\d+)$/m.exec(String(text ?? ''));
  return m ? Number(m[1]) : 0;
}

/** A pids.max file as a number, or null for "max" (no limit) or anything unreadable. */
function limitIn(dir) {
  try {
    const t = readFileSync(path.join(dir, 'pids.max'), 'utf8').trim();
    return /^\d+$/.test(t) ? Number(t) : null;
  } catch {
    return null;
  }
}

/**
 * The host cgroup that counts a running container's processes, found before anything is measured:
 * the cgroup of the container's main process, as /proc/<pid>/cgroup names it (under gVisor that is
 * the sandbox kernel, whose own host threads count against the cap), else the usual folders of the
 * systemd and cgroupfs drivers. The folder must have pids.current and pids.events. `limitDir` is the
 * nearest folder from there up that sets a number in pids.max (usually the same one).
 * @param {string} name  the container
 * @param {{root?: string}} [o]
 * @returns {Promise<{dir: string|null, limitDir: string|null, why: string}>} `why` says what failed when dir is null
 */
export async function pidsCgroup(name, { root = CGROUP_ROOT } = {}) {
  const r = await run('docker', ['inspect', '-f', '{{.Id}} {{.State.Pid}}', name], { timeoutMs: 30_000 });
  const [id, pid] = String(r.stdout).trim().split(/\s+/);
  if (r.code !== 0 || !/^[0-9a-f]{64}$/.test(id ?? '')) {
    return { dir: null, limitDir: null, why: `docker inspect gave no container id (${String(r.stderr).trim().split('\n').pop() || `exit ${r.code}`})` };
  }
  const tried = [];
  let fromProc = [];
  if (/^[1-9]\d*$/.test(pid ?? '')) {
    try {
      fromProc = cgroupDirs(readFileSync(`/proc/${pid}/cgroup`, 'utf8'), root);
    } catch (err) {
      tried.push(`/proc/${pid}/cgroup ${err.code ?? 'unreadable'}`);
    }
  } else {
    tried.push(`no main process (pid ${pid ?? 'unknown'})`);
  }
  const candidates = [...new Set([...fromProc,
    path.join(root, 'system.slice', `docker-${id}.scope`), path.join(root, 'docker', id),
    path.join(root, 'pids', 'system.slice', `docker-${id}.scope`), path.join(root, 'pids', 'docker', id)])];
  for (const dir of candidates) {
    try {
      readFileSync(path.join(dir, 'pids.current'), 'utf8');
      readFileSync(path.join(dir, 'pids.events'), 'utf8');
    } catch (err) {
      tried.push(`${short(dir)} ${err.code ?? 'unreadable'}`);
      continue;
    }
    let limitDir = dir;
    while (limitIn(limitDir) === null && path.dirname(limitDir) !== limitDir && limitDir.startsWith(`${root}/`)) limitDir = path.dirname(limitDir);
    return { dir, limitDir: limitIn(limitDir) === null ? null : limitDir, why: '' };
  }
  return { dir: null, limitDir: null, why: `no cgroup with pids.current found (${tried.join('; ')})` };
}

/**
 * Read a cgroup's pids.current and pids.events every `everyMs` ms until stop(), and at once whenever
 * the kernel reports a change to pids.events (it does when a fork is refused; fs.watch, where inotify
 * works). Docker removes the folder with the container, so what counts is what was read before: the
 * most processes at once (`peak`), the forks refused at the limit since the watch began
 * (`refusedForks`, from the "max" counter of pids.events), how many reads there were, and whether the
 * folder went away.
 * @param {string} dir  the folder pidsCgroup() found
 * @param {{everyMs?: number, limitDir?: string|null}} [o]
 * @returns {{stop(): PidsSeen}}
 * @typedef {{dir: string, limit: number|null, reads: number, peak: number, refusedForks: number, gone: boolean, error: string}} PidsSeen
 */
export function watchPids(dir, { everyMs = 10, limitDir = dir } = {}) {
  const seen = { dir, limit: limitDir ? limitIn(limitDir) : null, reads: 0, peak: 0, refusedForks: 0, gone: false, error: '' };
  let atStart = null;
  const read = () => {
    if (seen.gone) return;
    try {
      const current = Number(readFileSync(path.join(dir, 'pids.current'), 'utf8').trim());
      const events = parsePidsEvents(readFileSync(path.join(dir, 'pids.events'), 'utf8'));
      seen.reads += 1;
      if (Number.isFinite(current)) seen.peak = Math.max(seen.peak, current);
      atStart ??= events;
      seen.refusedForks = Math.max(seen.refusedForks, events - atStart);
    } catch (err) {
      if (err.code === 'ENOENT' && seen.reads > 0) seen.gone = true;
      else seen.error ||= String(err.code ?? err.message);
    }
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref?.();
  let notify = null;
  try {
    notify = watch(path.join(dir, 'pids.events'), { persistent: false }, read);
    notify.on('error', () => {}); // the folder went away; the timer's next read records that
  } catch {
    notify = null; // no inotify here: the timer alone reads
  }
  return {
    stop() {
      clearInterval(timer);
      try { notify?.close(); } catch { /* already closed */ }
      read();
      return { ...seen };
    },
  };
}

/** True when the host cgroup shows the cap itself: its limit is `limit`, and a fork was refused there or the count reached it. */
export function capMeasured(seen, limit) {
  return Boolean(seen) && seen.reads > 0 && seen.limit === limit && (seen.refusedForks > 0 || seen.peak >= limit);
}

/** What the host cgroup showed, for the detail of a check; `why` is used when it was never read. */
export function pidsText(seen, why = '') {
  if (!seen || seen.reads === 0) return `host cgroup not read (${why || seen?.error || 'no cgroup found'})`;
  return `host cgroup ${short(seen.dir)}: pids.max ${seen.limit ?? 'unknown'}, at most ${seen.peak} processes at once, `
    + `${seen.refusedForks} fork${seen.refusedForks === 1 ? '' : 's'} refused at the limit (pids.events max), ${seen.reads} reads${seen.gone ? ' until Docker removed it' : ''}`;
}

/** The last "started N refused M" line of spawn-forever.mjs, with its numbers, or null numbers when there is none. */
export function spawnProgress(stdout) {
  const line = String(stdout ?? '').trim().split('\n').filter((l) => l.startsWith('started ')).pop() ?? null;
  return { line, started: Number(line?.match(/^started (\d+)/)?.[1] ?? 0), refused: Number(line?.match(/refused (\d+)/)?.[1] ?? 0) };
}

/**
 * The endless-spawn scene (test/scenes.mjs). It passes when the loop is held at the cap until its
 * 20 s limit: it timed out with refusals inside and docker stats at or under the cap. Under gVisor the
 * cap also counts the sandbox kernel's own host threads, and the whole sandbox may stop before the
 * limit; that passes only when the cap was measured: by the host cgroup (capMeasured) or by the
 * loop's own progress line (processes started, then refused). A stop with neither fails as
 * "stopped, cause not measured", whatever Docker says about it.
 * @param {{limit: number, runtime?: string, ran: boolean, timedOut: boolean, secs: number, progress: {line: string|null, started: number, refused: number},
 *   pids: number, statsSecs: string, stopped: {oom: boolean, exit: string}|null, seen: PidsSeen|null, cgWhy?: string, execNote: string}} o
 * @returns {{pass: boolean, detail: string}}
 */
export function spawnVerdict({ limit, runtime, ran, timedOut, secs, progress, pids, statsSecs, stopped, seen, cgWhy = '', execNote }) {
  const last = `last progress "${progress.line ?? 'no progress line'}"`;
  const cg = pidsText(seen, cgWhy);
  if (ran && timedOut && progress.refused > 0 && pids > 0 && pids <= limit) {
    return { pass: true, detail: `held until the ${secs}s time limit: ${pids} processes (cap ${limit}) per docker stats, which answered in ${statsSecs}s; ${last}; ${cg}` };
  }
  if (runtime === 'runsc' && ran && !timedOut && stopped && !stopped.oom) {
    const what = `gVisor stopped the sandbox after ${secs}s, before the 20 s limit (container exit ${stopped.exit}, not OOM-killed; ${execNote})`;
    if (capMeasured(seen, limit)) return { pass: true, detail: `${what}, at the cap: ${cg}; ${last}` };
    if (progress.started > 0 && progress.refused > 0) return { pass: true, detail: `${what}, at the cap: the loop's last progress line "${progress.line}" shows ${progress.started} started and ${progress.refused} refused; ${cg}` };
    return { pass: false, detail: `stopped, cause not measured: ${what}; ${last}; ${cg}` };
  }
  return { pass: false, detail: `${Number.isFinite(pids) ? pids : 'unknown'} processes (cap ${limit}); ${last}; cut off after ${secs}s; docker stats answered in ${statsSecs}s${stopped?.oom ? '; the container stopped, OOM-killed' : ''}; ${cg}` };
}

/** Lines of a shell's stderr that say a fork was refused (dash, bash, busybox). */
export const FORK_REFUSED = /fork|resource temporarily unavailable/i;

/**
 * The containment fork bomb (test/containment.mjs): 700 background processes asked for. It passes
 * when docker stats shows at most `limit` processes and the shell reported a refused fork. Under
 * gVisor the whole sandbox may stop before 700 start; that passes only when the cap was measured:
 * by the host cgroup (capMeasured), or by a refused fork in the shell's stderr. Otherwise it fails as
 * "stopped, cause not measured".
 * @param {{limit: number, runtime?: string, pids: number, stderr: string, startedAll: boolean, stopped: {oom: boolean, exit: string}|null, seen: PidsSeen|null, cgWhy?: string}} o
 * @returns {{pass: boolean, detail: string}}
 */
export function forkBombVerdict({ limit, runtime, pids, stderr, startedAll, stopped, seen, cgWhy = '' }) {
  const refused = FORK_REFUSED.test(String(stderr ?? ''));
  const lastErr = String(stderr ?? '').trim().split('\n').pop() || 'no stderr';
  const cg = pidsText(seen, cgWhy);
  if (pids > 0 && pids <= limit && refused) {
    return { pass: true, detail: `${pids} processes after trying 700 (cap ${limit}) per docker stats; further forks refused ("${lastErr}"); ${cg}` };
  }
  if (runtime === 'runsc' && !startedAll && stopped && !stopped.oom) {
    const what = `gVisor stopped the sandbox before 700 processes started (container exit ${stopped.exit}, not OOM-killed; "${lastErr}")`;
    if (capMeasured(seen, limit)) return { pass: true, detail: `${what}, at the cap: ${cg}` };
    if (refused) return { pass: true, detail: `${what}, at the cap: the shell reported a refused fork; ${cg}` };
    return { pass: false, detail: `stopped, cause not measured: ${what}; ${cg}` };
  }
  return { pass: false, detail: `${Number.isFinite(pids) ? pids : 'unknown'} processes after trying 700 (cap ${limit}); ${refused ? 'further forks refused' : 'no refusal seen'}${startedAll ? '; all 700 started' : ''}${stopped?.oom ? '; the container stopped, OOM-killed' : ''}; ${cg}` };
}
