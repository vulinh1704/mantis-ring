// Task records, their event streams, the run queue, and the check that turns a request body into a task.
// Each task has a folder <STATE_DIR>/tasks/<id>/ holding task.json (replaced atomically), events.jsonl
// (append-only, read back for SSE replays) and the artifacts the agent loop stores. File writes are
// synchronous: they are small, and it keeps event numbers and the files in step without a write queue.
// The queue starts tasks as slots free up and owns the semaphore for heavy steps (install, look, proof).
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPT_VARIANTS } from '../agent/prompt.mjs';
import {
  CAP_RANGES, GITHUB_WALL_CLOCK_SEC, LOCALES, SAMPLES, SCHEMES, VIEWPORTS,
  checkCaps, checkSampling, isModelId, samplingFor,
} from './config.mjs';

export const TASK_ID = /^t_[0-9a-f]{32}$/;
const ARTIFACT_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const RESERVED = /^(task\.json|events\.jsonl)/;          // the store's own files, never written by the loop
const MAX_ARTIFACT_BYTES = 32 * 2 ** 20;                  // the loop caps PNGs at 20 MB and JSON at 8 MB
const MAX_EVENT_CHARS = 64 * 1024;
export const INTERRUPTED = 'This run was interrupted by a restart of the demo. Please start it again.';

/** A request that cannot become a task. The message is one sentence, fit to show to the person who sent it. */
export class TaskInputError extends Error {}

/** The task store: one folder per task, task.json + events.jsonl, and live subscribers per task. */
export class TaskStore {
  /** @param {{dir:string, maxEvents?:number, now?:() => number, log?:(line:string) => void}} o */
  constructor({ dir, maxEvents = 5000, now = Date.now, log = (line) => console.log(line) } = {}) {
    if (!dir) throw new Error('TaskStore needs a dir');
    this.root = dir;
    this.maxEvents = maxEvents;
    this.now = now;
    this.log = log;
    this.tasks = new Map();   // id -> record (the same as task.json on disk)
    this.counters = new Map(); // id -> { seq, count, capped }
    this.subscribers = new Map(); // id -> Set<fn>
    mkdirSync(dir, { recursive: true, mode: 0o750 });
  }

  /**
   * Read every task.json. Tasks that a previous process left queued or running are marked
   * `interrupted` (their sandboxes are gone after a restart). Returns the ids it marked.
   */
  load() {
    let names = [];
    try {
      names = readdirSync(this.root);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const interrupted = [];
    for (const name of names) {
      if (!TASK_ID.test(name)) continue;
      let rec;
      try {
        rec = JSON.parse(readFileSync(path.join(this.root, name, 'task.json'), 'utf8'));
      } catch (err) {
        this.log(`tasks: skipping ${name}: ${err.code ?? err.message}`);
        continue;
      }
      if (rec?.id !== name) { this.log(`tasks: skipping ${name}: its task.json names another id`); continue; }
      this.tasks.set(name, rec);
      if (rec.state === 'queued' || rec.state === 'running') interrupted.push(name);
    }
    for (const id of interrupted) {
      this.update(id, { state: 'interrupted', position: null, result: { status: 'interrupted', verdict: null, line: null, error: INTERRUPTED } });
      this.appendEvent(id, 'state', { state: 'interrupted' });
      this.appendEvent(id, 'done', { status: 'interrupted', error: INTERRUPTED });
    }
    return interrupted;
  }

  /** Folder of one task. Throws on anything that is not a task id, so no path can be built from user input. */
  dir(id) {
    if (!TASK_ID.test(String(id))) throw new Error('not a task id');
    return path.join(this.root, id);
  }

  /** Path of one artifact in a task folder; the name must pass the allowlist (§3.4). */
  file(id, name) {
    if (!ARTIFACT_NAME.test(String(name)) || name.includes('..')) throw new Error(`refused file name: ${name}`);
    return path.join(this.dir(id), name);
  }

  /** Create a task: its folder and task.json. Returns a copy of the stored record. */
  create(rec) {
    const dir = this.dir(rec?.id);
    mkdirSync(dir, { mode: 0o750 });          // EEXIST on an id collision: never overwrite a task
    const at = new Date(this.now()).toISOString();
    const full = { ...rec, createdAt: rec.createdAt ?? at, updatedAt: at };
    this.#write(full);
    this.tasks.set(full.id, full);
    this.counters.set(full.id, { seq: 0, count: 0, capped: false });
    return structuredClone(full);
  }

  /** A copy of one record, or null. */
  get(id) {
    const rec = this.tasks.get(id);
    return rec ? structuredClone(rec) : null;
  }

  /** Shallow-merge `patch` into a record and write it atomically. Returns a copy of the result. */
  update(id, patch) {
    const cur = this.tasks.get(id);
    if (!cur) throw new Error(`no task ${id}`);
    const next = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date(this.now()).toISOString() };
    this.#write(next);
    this.tasks.set(id, next);
    return structuredClone(next);
  }

  /** Records, newest first, optionally filtered by state, label and origin. */
  list({ state, label, origin } = {}) {
    return [...this.tasks.values()]
      .filter((t) => (!state || t.state === state) && (!label || t.label === label) && (!origin || t.origin === origin))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((t) => structuredClone(t));
  }

  /**
   * Append one event and send it to live subscribers. Returns its seq. After `maxEvents` events only
   * `done` is still stored, so a chatty task cannot fill the disk or a viewer's browser.
   */
  appendEvent(id, type, data = {}) {
    if (!this.tasks.has(id)) throw new Error(`no task ${id}`);
    const c = this.#counter(id);
    if (c.count >= this.maxEvents && type !== 'done') {
      if (!c.capped) { c.capped = true; this.log(`task=${id} events capped at ${this.maxEvents}; only done is stored from now on`); }
      return c.seq;
    }
    const ev = { seq: c.seq + 1, ts: new Date(this.now()).toISOString(), type, data };
    let line;
    try { line = JSON.stringify(ev); } catch { line = ''; }
    if (!line || line.length > MAX_EVENT_CHARS) {
      ev.data = { note: line ? 'event too large to store' : 'event could not be stored' };
      line = JSON.stringify(ev);
    }
    appendFileSync(path.join(this.dir(id), 'events.jsonl'), `${line}\n`, { mode: 0o640 });
    c.seq = ev.seq;
    c.count += 1;
    for (const fn of this.subscribers.get(id) ?? []) {
      try { fn(ev); } catch (err) { this.log(`task=${id} event subscriber failed: ${err.message}`); }
    }
    return ev.seq;
  }

  /** Stored events with seq > afterSeq, oldest first. A torn last line (crash mid-write) is skipped. */
  events(id, afterSeq = 0) {
    let text;
    try {
      text = readFileSync(path.join(this.dir(id), 'events.jsonl'), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.seq > afterSeq) out.push(ev);
    }
    return out;
  }

  /** Call `fn(event)` for every new event of one task. Returns the unsubscribe function. */
  subscribe(id, fn) {
    let set = this.subscribers.get(id);
    if (!set) this.subscribers.set(id, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.subscribers.get(id) === set) this.subscribers.delete(id);
    };
  }

  /**
   * Store one artifact the loop produced. PNGs are created once (flag wx); everything else is replaced
   * atomically, so the loop may rewrite transcript.jsonl turn by turn. Never follows a planted symlink:
   * wx refuses an existing path, and rename replaces the link itself.
   */
  put(id, name, data) {
    const file = this.file(id, name);
    if (RESERVED.test(name)) throw new Error(`refused file name: ${name}`);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (!Buffer.isBuffer(buf)) throw new Error(`artifact ${name}: data must be a Buffer or a string`);
    if (buf.length > MAX_ARTIFACT_BYTES) throw new Error(`artifact ${name} is too large (${buf.length} bytes)`);
    if (name.endsWith('.png')) {
      writeFileSync(file, buf, { flag: 'wx', mode: 0o640 });
      return;
    }
    const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, buf, { flag: 'wx', mode: 0o640 });
    renameSync(tmp, file);
  }

  /**
   * Append to an artifact (the loop writes transcript.jsonl one line per message this way). The file
   * may not grow past MAX_ARTIFACT_BYTES; a symlink in its place is refused.
   */
  append(id, name, data) {
    const file = this.file(id, name);
    if (RESERVED.test(name) || name.endsWith('.png')) throw new Error(`refused file name for append: ${name}`);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (!Buffer.isBuffer(buf)) throw new Error(`artifact ${name}: data must be a Buffer or a string`);
    let have = 0;
    try {
      const st = lstatSync(file);
      if (!st.isFile()) throw new Error(`artifact ${name} is not a regular file`);
      have = st.size;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (have + buf.length > MAX_ARTIFACT_BYTES) throw new Error(`artifact ${name} would pass ${MAX_ARTIFACT_BYTES} bytes`);
    appendFileSync(file, buf, { mode: 0o640 });
  }

  /** Size of a regular file in a task folder, or -1 when it is missing or not a regular file. */
  size(id, name) {
    try {
      const st = lstatSync(this.file(id, name));
      return st.isFile() ? st.size : -1;
    } catch {
      return -1;
    }
  }

  /** Names of the regular files in a task folder that match `re`. */
  names(id, re) {
    try {
      return readdirSync(this.dir(id), { withFileTypes: true }).filter((d) => d.isFile() && re.test(d.name)).map((d) => d.name).sort();
    } catch {
      return [];
    }
  }

  /**
   * Retention (§3.4): keep tasks younger than `maxAgeDays` and among the newest `maxTasks`, whichever
   * is fewer. Queued and running tasks, and the ids in `keep`, always stay. Returns how many were removed.
   */
  prune({ maxAgeDays = 14, maxTasks = 300, keep = new Set() } = {}) {
    const cutoff = this.now() - maxAgeDays * 86_400_000;
    const newestFirst = [...this.tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    let removed = 0;
    newestFirst.forEach((t, i) => {
      if (keep.has(t.id) || t.state === 'queued' || t.state === 'running') return;
      if (i < maxTasks && Date.parse(t.createdAt) >= cutoff) return;
      try {
        rmSync(this.dir(t.id), { recursive: true, force: true });
        this.tasks.delete(t.id);
        this.counters.delete(t.id);
        removed += 1;
      } catch (err) {
        this.log(`tasks: could not remove ${t.id}: ${err.message}`);
      }
    });
    return removed;
  }

  #counter(id) {
    let c = this.counters.get(id);
    if (!c) {
      const evs = this.events(id, 0);
      c = { seq: evs.length ? evs[evs.length - 1].seq : 0, count: evs.length, capped: false };
      this.counters.set(id, c);
    }
    return c;
  }

  #write(rec) {
    const file = path.join(this.dir(rec.id), 'task.json');
    writeFileSync(`${file}.tmp`, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o640 });
    renameSync(`${file}.tmp`, file);
  }
}

/** The queue is full; the server answers 503. */
export class QueueFullError extends Error {}

/**
 * FIFO run queue with priority (admin) entries first, at most `maxRunning` tasks at once and at most
 * `maxQueued` waiting. Emits 'change' whenever positions may have moved.
 */
export class Queue extends EventEmitter {
  /** @param {{maxRunning?:number, heavySlots?:number, maxQueued?:number, log?:(line:string) => void}} o */
  constructor({ maxRunning = 2, heavySlots = 2, maxQueued = 8, log = (line) => console.log(line) } = {}) {
    super();
    this.maxRunning = maxRunning;
    this.maxQueued = maxQueued;
    this.log = log;
    this.waiting = [];          // [{ id, priority, run }]
    this.active = new Map();    // id -> { ac: AbortController, startedAt: ms }
    this.paused = 0;            // > 0: nothing new starts (exclusive lock or shutdown)
    this.idleWaiters = [];
    this.exclusiveTail = Promise.resolve();
    this.heavyFree = heavySlots;
    this.heavyWaiters = [];
    /** Semaphore for install, look and proof, handed to runFix as deps.heavy. */
    this.heavy = { run: (fn) => this.#heavyRun(fn) };
  }

  /**
   * Add a task. `run(signal)` is called when a slot is free; the slot frees when its promise settles.
   * Returns the position: 0 = started, 1 = next in line. Throws QueueFullError when the line is full.
   */
  enqueue(id, { priority = false, run } = {}) {
    if (typeof run !== 'function') throw new Error('enqueue needs a run(signal) function');
    if (this.active.has(id) || this.waiting.some((w) => w.id === id)) throw new Error(`task ${id} is already in the queue`);
    if (this.waiting.length >= this.maxQueued) throw new QueueFullError(`the queue is full (${this.maxQueued} waiting)`);
    const item = { id, priority: !!priority, run };
    if (item.priority) {
      const i = this.waiting.findIndex((w) => !w.priority);
      this.waiting.splice(i < 0 ? this.waiting.length : i, 0, item);
    } else {
      this.waiting.push(item);
    }
    this.#pump();
    this.emit('change');
    return this.position(id);
  }

  /** 0 = running, 1.. = place in line, null = not in the queue. */
  position(id) {
    if (this.active.has(id)) return 0;
    const i = this.waiting.findIndex((w) => w.id === id);
    return i < 0 ? null : i + 1;
  }

  running() { return [...this.active.keys()]; }
  queued() { return this.waiting.map((w) => w.id); }
  full() { return this.waiting.length >= this.maxQueued; }

  /** Take a waiting task out of line, or abort a running one. Returns 'queued', 'running' or null. */
  cancel(id, reason = 'cancelled') {
    const i = this.waiting.findIndex((w) => w.id === id);
    if (i >= 0) {
      this.waiting.splice(i, 1);
      this.emit('change');
      return 'queued';
    }
    const a = this.active.get(id);
    if (a) {
      a.ac.abort(reason);
      return 'running';
    }
    return null;
  }

  /** Shutdown: start nothing new, drop the line (the ids are returned) and abort every running task. */
  abortAll(reason = 'shutdown') {
    this.paused += 1;
    const dropped = this.queued();
    this.waiting = [];
    for (const a of this.active.values()) a.ac.abort(reason);
    this.emit('change');
    return dropped;
  }

  /** Change how many tasks may run at once (admin config). */
  setMaxRunning(n) {
    this.maxRunning = n;
    this.#pump();
    this.emit('change');
  }

  /** Resolves when no task is running. */
  idle() {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise((ok) => this.idleWaiters.push(ok));
  }

  /**
   * Wait until no task runs, keep new ones from starting, and return `release()` (§4.3 /admin/selftest).
   * Two callers are served one after the other.
   */
  async pauseForExclusive() {
    this.paused += 1;
    const turn = this.exclusiveTail;
    let done;
    this.exclusiveTail = new Promise((ok) => { done = ok; });
    await turn;
    await this.idle();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.paused -= 1;
      done();
      this.#pump();
      this.emit('change');
    };
  }

  #pump() {
    while (this.paused === 0 && this.active.size < this.maxRunning && this.waiting.length > 0) {
      const { id, run } = this.waiting.shift();
      const ac = new AbortController();
      this.active.set(id, { ac, startedAt: Date.now() });
      Promise.resolve()
        .then(() => run(ac.signal))
        .catch((err) => this.log(`task=${id} queue: run failed: ${err?.message ?? err}`))
        .finally(() => {
          this.active.delete(id);
          if (this.active.size === 0) for (const ok of this.idleWaiters.splice(0)) ok();
          this.#pump();
          this.emit('change');
        });
    }
  }

  async #heavyRun(fn) {
    if (this.heavyFree > 0) this.heavyFree -= 1;
    else await new Promise((ok) => this.heavyWaiters.push(ok));
    try {
      return await fn();
    } finally {
      const next = this.heavyWaiters.shift();
      if (next) next(); else this.heavyFree += 1;
    }
  }
}

/**
 * Durations of the last finished tasks (<STATE_DIR>/stats.json), for the ETA and the "about N min"
 * text. Only rows marked `comparable` count (a run like the next public one: the sample's own
 * matrix, the default caps and a normal end), so a one-screen smoke test or a run stopped by its
 * budget never makes a new run look shorter than it is. Rows from before this flag do not count.
 */
export class RunStats {
  constructor(file, { keep = 20 } = {}) {
    this.file = file;
    this.keep = keep;
    this.rows = null;
  }

  /** Record one finished task: {id, kind: 'sample'|'github', origin, comparable, sec, at}. A failed write only loses the ETA. */
  add(row) {
    this.rows = [...this.#load(), row].slice(-this.keep);
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o750 });
      writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.rows)}\n`, { mode: 0o640 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      console.error(`stats: could not write ${this.file}: ${err.message}`);
    }
  }

  /** Comparable finished runs on record (of one kind, when given). */
  count(kind) { return this.#usable(kind).length; }

  /** Median seconds of the comparable runs, or null with no history. */
  median(kind) {
    const xs = this.#usable(kind).map((r) => r.sec).sort((a, b) => a - b);
    if (xs.length === 0) return null;
    const mid = xs.length >> 1;
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  }

  #usable(kind) {
    return this.#load().filter((r) => r.comparable === true && (!kind || r.kind === kind));
  }

  #load() {
    if (this.rows) return this.rows;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      this.rows = Array.isArray(data) ? data.filter((r) => r && Number.isFinite(r.sec) && r.sec > 0) : [];
    } catch {
      this.rows = [];
    }
    return this.rows;
  }
}

// ---------------------------------------------------------------------------------------------
// Request body → task (§4.2, §4.3, §4.6)
// ---------------------------------------------------------------------------------------------
const REPO = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
const ROUTE = /^\/[A-Za-z0-9._~!$&'()*+;=:@%/-]{0,100}$/;
const LABEL = /^[A-Za-z0-9 ._:+-]{1,80}$/;
const ADMIN_KEYS = new Set(['sample', 'repo', 'routes', 'viewports', 'schemes', 'locales', 'model', 'visionModel', 'gate', 'caps', 'sampling', 'label', 'priority', 'promptVariant']);
export const SAY_BAD_REPO = 'Only public repositories on github.com are supported, written as https://github.com/owner/name.';
export const SAY_REPO_PAGE = "Give the repository's own address, https://github.com/owner/name, not a link to a branch, folder, file or other page in it.";
export const SAY_BAD_MATRIX = 'Routes must be paths like /pricing (up to 3); languages must come from the list.';
// A link to a page inside a repository (a branch, folder, file, pull request, …) rather than to the repository.
const REPO_PAGE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:tree|blob|raw|commit|commits|pull|pulls|issues|releases|tags|wiki|actions|compare|archive|discussions|security|pulse|graphs|settings)(?:\/|$)/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The owner and name of a GitHub repository from an address as people paste it. Spaces around it,
 * http://, www., no scheme at all, a trailing slash or .git, and a #fragment or ?query (#readme,
 * ?tab=…) are accepted; the rest must match REPO (BUILD-SPEC §4.6). The clone URL is rebuilt from the
 * two parts later, so nothing else of what was typed is ever used.
 * @param {unknown} input
 * @returns {{owner: string, name: string}}
 * @throws {TaskInputError} with SAY_REPO_PAGE for a link to a page inside a repository, else SAY_BAD_REPO
 */
export function repoFromInput(input) {
  if (typeof input !== 'string' || input.length > 300) throw new TaskInputError(SAY_BAD_REPO);
  const plain = /^(?:https?:\/\/)?(?:www\.)?github\.com(\/[^?#]*)?(?:[?#][\s\S]*)?$/i.exec(input.trim());
  if (!plain) throw new TaskInputError(SAY_BAD_REPO);
  const url = `https://github.com${plain[1] ?? ''}`;
  if (REPO_PAGE.test(url)) throw new TaskInputError(SAY_REPO_PAGE);
  const m = REPO.exec(url);
  if (!m || m[2] === '.' || m[2] === '..') throw new TaskInputError(SAY_BAD_REPO);
  return { owner: m[1], name: m[2] };
}

/** A list given as an array of strings or a comma-separated string; null when absent. */
function listOf(v) {
  if (v === undefined || v === null || v === '') return null;
  const items = typeof v === 'string' ? v.split(',') : Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : null;
  if (!items) return undefined;
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}

function pick(v, allowed, max, sentence) {
  const items = listOf(v);
  if (items === null) return null;
  if (items === undefined || items.length === 0 || items.length > max || !items.every((x) => allowed.includes(x))) throw new TaskInputError(sentence);
  return items;
}

/**
 * Validate a POST /api/tasks (public) or /admin/tasks (admin) body against the sample allowlist, the
 * input limits and the admin maxima. Returns the task fields; throws TaskInputError with one sentence.
 * A public body may name only the project, routes and languages: everything else is fixed, so a
 * public task always has the gate on and the neutral task message, whatever else the body says.
 * @returns {{source:object, matrix:object, model:string, sampling:object, visionModel:string|null,
 *            gate:boolean, caps:object, label:string|null, priority:boolean, promptVariant:'neutral'|'pressure'}}
 */
export function taskFromBody(body, { admin = false, cfg }) {
  if (!isObject(body)) throw new TaskInputError('Send a JSON object.');
  if (admin) {
    const unknown = Object.keys(body).filter((k) => !ADMIN_KEYS.has(k));
    if (unknown.length) throw new TaskInputError(`Unknown field(s): ${unknown.join(', ')}.`);
  }
  const hasSample = body.sample !== undefined && body.sample !== null;
  const hasRepo = body.repo !== undefined && body.repo !== null;
  if (hasSample === hasRepo) throw new TaskInputError('Choose a sample or give a GitHub repository, not both.');

  let source, matrix;
  if (hasSample) {
    const sample = typeof body.sample === 'string' && Object.hasOwn(SAMPLES, body.sample) ? SAMPLES[body.sample] : null;
    if (!sample) throw new TaskInputError('That sample does not exist. Pick one from the list.');
    source = { kind: 'sample', name: body.sample, label: sample.label };
    matrix = { routes: [...sample.routes], viewports: [...sample.viewports], schemes: [...sample.schemes], locales: [...sample.locales] };
  } else {
    const { owner, name } = repoFromInput(body.repo);
    // The host never fetches this URL: the clone runs inside the sandbox, from a URL rebuilt out of these parts.
    source = { kind: 'github', owner, name, label: `${owner}/${name}` };
    matrix = { routes: ['/'], viewports: ['mobile', 'desktop'], schemes: ['light', 'dark'], locales: ['en'] };
  }

  const routes = listOf(body.routes);
  if (routes !== null) {
    if (routes === undefined || routes.length === 0 || routes.length > 3 || !routes.every((r) => ROUTE.test(r) && !r.includes('//'))) throw new TaskInputError(SAY_BAD_MATRIX);
    matrix.routes = routes;
  }
  matrix.locales = pick(body.locales, LOCALES, 2, SAY_BAD_MATRIX) ?? matrix.locales;

  if (!admin) {
    const model = cfg.fixModel;
    return {
      source, matrix, model, sampling: samplingFor(model, cfg), visionModel: cfg.visionModel ?? null,
      gate: true, caps: capsFor(source, cfg.caps), label: null, priority: false, promptVariant: 'neutral',
    };
  }

  // Admin only: screen sizes, schemes, model choice, the gate switch, caps, sampling, label, priority,
  // and the task message's variant (the bench's pressure arm).
  matrix.viewports = pick(body.viewports, VIEWPORTS, VIEWPORTS.length, `viewports must come from: ${VIEWPORTS.join(', ')}.`) ?? matrix.viewports;
  matrix.schemes = pick(body.schemes, SCHEMES, SCHEMES.length, `schemes must come from: ${SCHEMES.join(', ')}.`) ?? matrix.schemes;

  const model = body.model ?? cfg.fixModel;
  if (!isModelId(model) || !cfg.allowedModels.includes(model)) throw new TaskInputError(`model must be one of allowedModels: ${cfg.allowedModels.join(', ')}.`);

  let visionModel = cfg.visionModel ?? null;
  if (body.visionModel !== undefined) {
    if (body.visionModel === null || body.visionModel === false) visionModel = null;
    else if (isModelId(body.visionModel) && (cfg.allowedModels.includes(body.visionModel) || body.visionModel === cfg.visionModel)) visionModel = body.visionModel;
    else throw new TaskInputError('visionModel must be null or a model from allowedModels.');
  }

  if (body.gate !== undefined && typeof body.gate !== 'boolean') throw new TaskInputError('gate must be true or false.');

  let caps = capsFor(source, cfg.caps);
  if (body.caps !== undefined) {
    try {
      caps = checkCaps(body.caps, caps);
    } catch (err) {
      throw new TaskInputError(`${err.message}.`);
    }
  }

  let sampling = samplingFor(model, cfg, { bench: true });
  if (body.sampling !== undefined) {
    try {
      sampling = { ...sampling, ...checkSampling(body.sampling) };
    } catch (err) {
      throw new TaskInputError(`${err.message}.`);
    }
  }

  if (body.label !== undefined && body.label !== null && !(typeof body.label === 'string' && LABEL.test(body.label))) {
    throw new TaskInputError('label must be 1 to 80 letters, digits, spaces or . _ : + -');
  }
  if (body.priority !== undefined && typeof body.priority !== 'boolean') throw new TaskInputError('priority must be true or false.');
  const promptVariant = body.promptVariant ?? 'neutral';
  if (!PROMPT_VARIANTS.includes(promptVariant)) throw new TaskInputError(`promptVariant must be one of: ${PROMPT_VARIANTS.join(', ')}.`);

  return {
    source, matrix, model, sampling, visionModel, gate: body.gate ?? true, caps, label: body.label ?? null, priority: body.priority ?? false, promptVariant,
  };
}

/** Default caps for a source: 15 minutes for a sample, 20 for a GitHub repository (§2.4). */
function capsFor(source, base) {
  const caps = structuredClone(base);
  if (source.kind === 'github') caps.wallClockSec = Math.min(Math.max(caps.wallClockSec, GITHUB_WALL_CLOCK_SEC), CAP_RANGES.wallClockSec[1]);
  return caps;
}
