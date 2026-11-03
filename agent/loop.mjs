// The agent loop (runFix): one task, from a fresh sandbox to a receipt.
//
// The model sees the project only through the file tools and asks for checks. Every check is
// Mantis re-measuring the whole matrix against the baseline run R0 (`--baseline <R0 dir>`, never
// "auto"). The orchestrator, never the model, decides what stays:
// - a cover-up is rolled back and explained when the gate is on; with the gate off (the admin-only
//   control arm) it is kept, and the cover-up and "lost" lines are hidden from the model;
// - on a sample project with the gate on, a control or heading that disappeared ("lost") is rolled
//   back and explained the same way;
// - an edit aimed at the measurement itself (data-mantis-ignore, headless checks) is rolled back in
//   both arms, and so is a check that could not measure every screen R0 measured (a page that no
//   longer loads would otherwise simply drop out of the comparison);
// - every cap (checks, turns, tool calls, tokens, money, wall clock) is enforced here;
// - edits that were never measured never reach the patch.
// The sandbox is destroyed on every exit path, and a hard timer destroys it at the deadline.
// Spec: BUILD-SPEC.md §1.7 and §2.
import { BudgetError, INFERENCE_URL, PROVIDER, priceOf } from './inference.mjs';
import { PINNED_AT } from './prices.mjs';
import {
  PROMPT_VERSION, checkMessage, compactedToolResult, editsLockedMessage, forcedCheckPreamble, lastCheckMessage,
  noChangeMessage, nudgeMessage, systemPrompt, taskMessage,
} from './prompt.mjs';
import { buildReceipt, diffStats, receiptLine, receiptMarkdown } from './receipt.mjs';
import { FILE_TOOL_NAMES, TOOL_SCHEMAS, ToolError, WRITE_TOOL_NAMES, fileTools, parseToolCall } from './tools.mjs';
import { changedSince, initWorkspace, isClean, patchApplies, patchSince, revertTo, snapshot, stageAll, tamperHits } from './workspace.mjs';
import { LIMITS, Sandbox, networkText } from '../runner/sandbox.mjs';
import { baseUrl, bringIn, describePlan, devServerUp, inspectProject, installDeps, look, startCommand, startDevServer } from '../runner/run-task.mjs';

/** Caps of a public task (§2.4). Admin tasks may raise them up to ADMIN_MAX. */
export const DEFAULT_CAPS = Object.freeze({
  maxChecks: 3, maxTurns: 36, maxTurnsPerCheck: 14, maxCallsPerTurn: 12, maxCompletionTokens: 8192,
  reasoning: Object.freeze({ effort: 'low', max_tokens: 2048 }), maxPromptTokens: 1_200_000, maxUsd: 0.6,
  wallClockSec: 900, lookTimeoutSec: 300,
});
const ADMIN_MAX = {
  maxChecks: 3, maxTurns: 60, maxTurnsPerCheck: 20, maxCallsPerTurn: 12, maxCompletionTokens: 16_384,
  maxPromptTokens: 3_000_000, maxUsd: 2, wallClockSec: 2400, lookTimeoutSec: 600,
};
const GITHUB_WALL_CLOCK_SEC = 1200;
const PORT = 3000;
const SUMMARY_MAX = 1500;
const PATCH_MAX = 1_048_576;
const PNG_MAX = 20 * 2 ** 20;
const JSON_MAX = 8 * 2 ** 20;
const TRANSCRIPT_LINE_MAX = 16_384;
const MIN_LOOK_SEC = 10; // below this, a look is not started (it could not finish)
const MIN_CALL_MS = 20_000; // below this much time before the soft stop, no model call is started
const VISION_TIMEOUT_MS = 180_000;
const COMPACTABLE = new Set(['read_file', 'search_code', 'list_files']);
const SHOT = /^shots\/[A-Za-z0-9_.-]+\.png$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const LOOK_REASONS = {
  unreachable: 'the app did not answer',
  timeout: 'the measurement timed out',
  'no-report': 'the checker wrote no report',
  stale: 'the checker returned an old report',
  usage: 'the checker refused the request',
};
const FAILURE = {
  sandbox: 'The sandbox could not be started.',
  clone: 'The project could not be brought into the sandbox.',
  install: "The project's dependencies could not be installed.",
  serve: 'The app did not start inside the sandbox.',
  baseline: 'The app could not be measured.',
  fix: 'The run stopped because of an internal error while fixing.',
  gate: 'The run stopped because of an internal error while checking the result.',
  wrapup: 'The run stopped because of an internal error while writing the receipt.',
};
const STEP_OF = { sandbox: 'clone', clone: 'clone', install: 'install', serve: 'install', baseline: 'look', fix: 'fix', gate: 'gate', wrapup: 'gate' };
const STOP_TEXT = {
  finish: 'the model called finish', checks: 'no checks left', turns: 'turn limit reached', time: 'time limit close',
  budget: 'budget reached', inference: 'the model service failed', 'no-tools': 'the model stopped calling tools', 'no-issues': 'nothing to fix',
};

/** Thrown when the task was aborted (hard deadline or cancel); run() turns it into timeout/cancelled. */
class Stopped extends Error {
  constructor() {
    super('the task was stopped');
    this.name = 'Stopped';
  }
}

/** Thrown inside a heavy step when, after waiting for its slot, too little time is left to start it. */
class NoTime extends Error {
  constructor() {
    super('no time was left to measure');
    this.name = 'NoTime';
  }
}

/** An error with a one-sentence text that may be shown to the person who started the task. */
function failure(publicMessage, cause) {
  const err = new Error(cause?.message ? String(cause.message) : publicMessage);
  err.publicMessage = publicMessage;
  return err;
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const secs = (ms) => Math.round(ms / 100) / 10;
const firstLine = (s) => String(s ?? '').trim().split('\n')[0].slice(0, 200);
const lastLine = (s) => String(s ?? '').trim().split('\n').pop().slice(0, 200);
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) : t; };
const isOk = (result) => !/^(error|skipped|ignored)\b/.test(String(result));
const asError = (text) => (/^error\b/.test(String(text)) ? String(text) : `error: ${text}`);
const lookReason = (err) => LOOK_REASONS[err?.reason] ?? 'the checker failed';
const durationText = (sec) => (sec >= 120 ? `${Math.round(sec / 60)}-minute` : `${sec}-second`);

function clipBytes(s, max) {
  const text = String(s ?? '');
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, max).toString('utf8').replace(/�$/, '')}… (cut)`;
}

/** Resolve with `promise`, or reject with Stopped as soon as `signal` aborts. The promise's own rejection is always handled. */
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Stopped());
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** "3 GB RAM, 2 CPUs, 512 processes" from the runner's LIMITS. */
function limitsText(l = LIMITS) {
  const mem = String(l?.memory ?? '?');
  const memText = /^\d+(\.\d+)?g$/i.test(mem) ? `${parseFloat(mem)} GB` : /^\d+(\.\d+)?m$/i.test(mem) ? `${parseFloat(mem)} MB` : mem;
  return `${memText} RAM, ${l?.cpus ?? '?'} CPUs, ${l?.pids ?? '?'} processes`;
}

/**
 * Tool-call arguments as they go back to the gateway: the text of one JSON object. Some
 * OpenAI-compatible servers (vLLM, SGLang) parse every echoed `arguments` before they apply the chat
 * template, so arguments the model wrote as invalid JSON (a raw newline in a string, a call cut off
 * by the token limit) would make every later request fail with a 400. Double-encoded arguments are
 * unwrapped, as parseToolCall does; anything that is not an object becomes '{}'.
 */
function canonicalArgs(raw) {
  let v = raw ?? {};
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
      if (typeof v === 'string') v = JSON.parse(v);
    } catch {
      return '{}';
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '{}';
  try { return JSON.stringify(v); } catch { return '{}'; }
}

/**
 * The reply's tool calls in two forms with the same ids (unique in the turn): `calls` go back to the
 * gateway in the history (arguments as the text of a JSON object, a name made of tool-name
 * characters, without the "functions." some open models put in front); `originals` keep what the
 * model sent, for parseToolCall and its error messages.
 * @param {unknown} raw  message.tool_calls as the gateway returned it
 * @param {number} turn
 * @returns {{calls: object[], originals: object[]}}
 */
export function normalizeCalls(raw, turn) {
  const calls = [];
  const originals = [];
  if (!Array.isArray(raw)) return { calls, originals };
  const seen = new Set();
  raw.forEach((c, i) => {
    let id = typeof c?.id === 'string' && c.id.length > 0 && c.id.length <= 200 ? c.id : '';
    if (!id || seen.has(id)) id = `call_ring_${turn}_${i}`;
    seen.add(id);
    const fn = c?.function ?? {};
    const args = canonicalArgs(fn.arguments);
    const given = typeof fn.name === 'string' ? fn.name.trim().replace(/^functions\./, '') : '';
    calls.push({ id, type: 'function', function: { name: /^[A-Za-z0-9_-]{1,64}$/.test(given) ? given : 'unknown_tool', arguments: args } });
    originals.push({ id, type: 'function', function: { name: fn.name, arguments: fn.arguments } });
  });
  return { calls, originals };
}

function toolTarget(args) {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.path === 'string') return args.path;
  if (typeof args.dir === 'string') return args.dir || '.';
  if (typeof args.pattern === 'string') return typeof args.file_glob === 'string' ? `${args.pattern} in ${args.file_glob}` : args.pattern;
  return '';
}

/** A short note for the live log: never file contents. */
function toolNote(name, result) {
  const text = String(result ?? '');
  if (!isOk(text)) return firstLine(text);
  if (name === 'read_file') return `${text.length} characters returned`;
  if (name === 'list_files') return `${text.split('\n').filter(Boolean).length} entries`;
  if (name === 'search_code') return text === 'no matches' ? 'no matches' : `${text.split('\n').filter(Boolean).length} matching lines`;
  return firstLine(text);
}

function lookEvent(kind, L, check) {
  const s = L?.report?.summary ?? {};
  const b = L?.report?.baseline;
  return {
    kind, ...(check ? { check } : {}), runId: L?.runId ?? null, cells: num(s.cells), errors: num(s.errors), warnings: num(s.warnings),
    exitCode: L?.exitCode ?? null, ms: num(L?.ms),
    ...(b ? { compare: { fixed: b.fixed?.length ?? 0, new: b.new?.length ?? 0, coverUps: num(b.coverUps), lost: num(b.lost), line: receiptLine(b) } } : {}),
  };
}

function sameNumbers(a, b) {
  const key = (r) => [num(r?.summary?.errors), num(r?.summary?.warnings), r?.baseline?.fixed?.length ?? 0, r?.baseline?.new?.length ?? 0,
    num(r?.baseline?.coverUps), num(r?.baseline?.lost)].join('/');
  return key(a) === key(b);
}

/** The screens of a run that Mantis measured: `<route>|<viewport>/<scheme>/<locale>` of every cell with status 'ok'. */
function okCells(report) {
  return new Set((Array.isArray(report?.cells) ? report.cells : [])
    .filter((c) => c?.status === 'ok' && typeof c.route === 'string' && typeof c.key === 'string')
    .map((c) => `${c.route}|${c.key}`));
}

/** "2 screens did not load or could not be measured (/settings.html mobile/light/en, …)" for the model and the log. */
function screensText({ count, names }) {
  const shown = names.slice(0, 3).map((k) => k.replace('|', ' ')).join(', ');
  const more = names.length > 3 ? ', …' : '';
  return `${count} screen${count === 1 ? '' : 's'} did not load or could not be measured${shown ? ` (${shown}${more})` : ''}`;
}

function tallyNumbers(t) {
  return {
    calls: num(t?.calls), promptTokens: num(t?.promptTokens), completionTokens: num(t?.completionTokens),
    reasoningTokens: num(t?.reasoningTokens), usd: typeof t?.usd === 'number' && Number.isFinite(t.usd) ? t.usd : null,
  };
}

/** A copy of the tally's numbers, so a task's own usage is the difference at the end even if the tally is shared. */
function snapshotTally(t) {
  const out = tallyNumbers(t);
  out.byModel = Object.fromEntries(Object.entries(t?.byModel ?? {}).map(([k, v]) => [k, tallyNumbers(v)]));
  return out;
}

function minus(a, b) {
  return {
    calls: a.calls - num(b?.calls), promptTokens: a.promptTokens - num(b?.promptTokens),
    completionTokens: a.completionTokens - num(b?.completionTokens), reasoningTokens: a.reasoningTokens - num(b?.reasoningTokens),
    usd: a.usd === null || (b && b.usd === null) ? null : round6(a.usd - num(b?.usd)),
  };
}

/** What was used between two tally snapshots, in total and per model. */
function deltaOf(from, to) {
  const d = minus(to, from);
  d.byModel = Object.fromEntries(Object.entries(to.byModel).map(([k, v]) => [k, minus(v, from.byModel[k])]));
  return d;
}

/** List price for the receipt, in USD per 1M tokens, or null when the price is unknown ("cost n/a"). */
function priceBlock(model, date) {
  let p = null;
  try { p = priceOf(model); } catch { p = null; }
  const per1M = (given, perToken) => (Number.isFinite(given) ? round6(given) : Number.isFinite(perToken) ? round6(perToken * 1e6) : null);
  const promptPer1M = per1M(p?.promptPer1M, p?.prompt);
  const completionPer1M = per1M(p?.completionPer1M, p?.completion);
  if (promptPer1M === null || completionPer1M === null) return null;
  const pinned = p.source === 'pinned';
  return { promptPer1M, completionPer1M, source: `${pinned ? 'pinned' : 'catalog'} list price, ${pinned ? PINNED_AT : date}` };
}

function modelRow(role, model, delta, date) {
  const key = Object.keys(delta.byModel).find((k) => k.toLowerCase() === String(model).toLowerCase());
  const m = key ? delta.byModel[key] : { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, usd: 0 };
  return {
    role, id: key ?? model, provider: PROVIDER, calls: m.calls, promptTokens: m.promptTokens, completionTokens: m.completionTokens,
    reasoningTokens: m.reasoningTokens, usd: m.usd, price: priceBlock(model, date),
  };
}

function cutPatch(patch, max) {
  const buf = Buffer.from(patch, 'utf8').subarray(0, max);
  const end = buf.lastIndexOf(0x0a);
  return buf.subarray(0, end >= 0 ? end + 1 : buf.length).toString('utf8');
}

/** The screenshot of the pair's cell in one run, when it is a plain file under shots/. */
function shotOf(report, pair, which) {
  const given = pair?.[`${which}Shot`];
  const route = pair?.route ?? pair?.issue?.route;
  const cellKey = pair?.cell ?? pair?.cellKey;
  const shot = typeof given === 'string' ? given : report?.cells?.find((c) => c.route === route && c.key === cellKey)?.screenshot;
  return typeof shot === 'string' && SHOT.test(shot) ? shot : null;
}

/**
 * The task's caps: the public defaults (§2.4) overridden by `caps`, each clamped to the admin
 * maximum. A GitHub task gets 20 minutes of wall clock unless its caps say otherwise. Throws on a
 * value that is not a positive number.
 * @param {object} [caps]
 * @param {{github?: boolean}} [o]
 * @returns {object}
 */
export function resolveCaps(caps = {}, { github = false } = {}) {
  const out = { ...DEFAULT_CAPS, reasoning: { ...DEFAULT_CAPS.reasoning } };
  if (github) out.wallClockSec = GITHUB_WALL_CLOCK_SEC;
  for (const [key, max] of Object.entries(ADMIN_MAX)) {
    const v = caps?.[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`caps.${key} must be a positive number`);
    out[key] = Math.min(v, max);
  }
  for (const key of ['maxChecks', 'maxTurns', 'maxTurnsPerCheck', 'maxCallsPerTurn', 'maxCompletionTokens', 'maxPromptTokens', 'wallClockSec', 'lookTimeoutSec']) {
    out[key] = Math.max(1, Math.floor(out[key]));
  }
  if (caps?.reasoning !== undefined) {
    const r = caps.reasoning;
    if (r !== null && (typeof r !== 'object' || Array.isArray(r))) throw new Error('caps.reasoning must be an object or null');
    out.reasoning = r === null ? null : { ...r };
  }
  // chat() refuses a reasoning budget that is not below the completion budget.
  if (out.reasoning && Number.isInteger(out.reasoning.max_tokens) && out.reasoning.max_tokens >= out.maxCompletionTokens) {
    out.reasoning.max_tokens = Math.max(1, Math.floor(out.maxCompletionTokens / 2));
  }
  return out;
}

function checkTask(task, deps) {
  if (!task || typeof task.id !== 'string' || task.id === '') throw new Error('task.id is missing');
  const s = task.source;
  if (s?.kind === 'sample') {
    if (typeof s.dir !== 'string' || !s.dir.startsWith('/')) throw new Error('a sample task needs source.dir, an absolute host path');
  } else if (s?.kind === 'github') {
    if (typeof s.owner !== 'string' || typeof s.name !== 'string' || !s.owner || !s.name) throw new Error('a GitHub task needs source.owner and source.name');
  } else {
    throw new Error('task.source.kind must be "sample" or "github"');
  }
  const m = task.matrix;
  for (const k of ['routes', 'viewports', 'schemes', 'locales']) {
    if (!Array.isArray(m?.[k]) || m[k].some((x) => typeof x !== 'string' || x === '' || x.includes(','))) throw new Error(`task.matrix.${k} must be a list of names`);
  }
  if (m.routes.length === 0) throw new Error('task.matrix.routes is empty');
  if (typeof task.model !== 'string' || task.model === '') throw new Error('task.model is missing');
  if (typeof deps?.chat !== 'function' || typeof deps.createSandbox !== 'function' || typeof deps.store?.put !== 'function') {
    throw new Error('runFix needs deps.chat, deps.createSandbox and deps.store.put');
  }
}

/** One task. Fields are the loop's state; methods are the steps of §2, in order. */
class FixRun {
  constructor(task, deps) {
    this.task = task;
    this.deps = deps ?? {};
    this.caps = null;
    // Set by run(): start, hard deadline, soft stop, the time a final check needs, the time kept for
    // wrap-up, and the least time before the soft stop that a model call may start with.
    this.t0 = 0; this.deadline = 0; this.soft = 0; this.finalCheckMargin = 0; this.reserveMs = 0; this.minCallMs = 0;
    this.ac = new AbortController();
    this.timedOut = false;
    this.hard = null;
    this.onCancel = () => this.ac.abort('cancelled');
    this.box = null;
    this.rt = 'unknown';
    this.cleanedUp = false;
    this.containment = null;
    this.phase = 'sandbox';
    this.phases = { sandbox: 0, clone: 0, install: 0, serve: 0, baseline: 0, model: 0, tools: 0, checks: 0, verify: 0, proof: 0, copyOut: 0, destroy: 0, vision: 0 };
    this.tally0 = snapshotTally(this.deps.tally);
    this.tallyBeforeVision = null; // set after destroy, so the receipt can tell fix calls from vision calls
    // setup results. `expected`: the R0 screens every later run must measure again (status 'ok' and a
    // state in R0's state.json, so Mantis can compare them); a run that loses one is not accepted.
    // `origin`: where the app answers in its sandbox ({host, port}), as startDevServer() found it.
    this.src = null; this.start = null; this.serverKind = 'static files'; this.matrixArgs = null; this.origin = null;
    this.R0 = null; this.R0dir = null; this.r0Crashed = 0; this.noIssues = false; this.expected = new Set(); this.r0State = null;
    // conversation. `seenCompactable`: how many compactable tool results the model has already been sent.
    this.messages = []; this.compactable = []; this.seenCompactable = 0; this.tools = null;
    this.turns = 0; this.turnsSinceCheck = 0; this.noToolStreak = 0; this.overBudget = false; this.forcedChoiceRefused = false;
    this.toolCalls = 0; this.invalidCalls = 0; this.toolErrors = 0;
    this.summary = ''; this.stopReason = null;
    // checks and workspace
    this.base = null; this.upstream = null; this.accepted = null; this.revertedSinceAccept = false;
    this.checks = 0; this.checkRows = []; this.lastRunId = null; this.dirty = false;
    this.touchedAll = new Set(); this.touchedRound = new Set(); this.createdRound = new Set();
    this.coverUpAttempts = 0; this.tamperAttempts = 0; this.lostAttempts = 0; this.reverts = 0;
    // result
    this.RF = null; this.patch = ''; this.storedPatch = ''; this.patchOk = null; this.patchTruncated = false;
    this.proofPath = null; this.proof = null; this.receipt = null;
    this.transcript = []; this.transcriptCount = 0; this.appendChain = Promise.resolve();
    this.ac.signal.addEventListener('abort', () => this.destroyNow(), { once: true });
  }

  get checksLeft() { return this.caps.maxChecks - this.checks; }

  // ---- events, journal, storage ----

  emit(type, data) {
    try { this.deps.emit?.(type, data); } catch { /* a broken listener must not stop the task */ }
  }

  journal(text) {
    try { this.deps.log?.(`task=${this.task?.id} ${text}`); } catch { /* same */ }
  }

  /** One human line for the live log (and the journal). */
  say(text, extra = {}) {
    this.emit('log', { text, ...extra });
    this.journal(text);
  }

  step(step, status, since, note) {
    this.emit('step', { step, status, ...(since ? { ms: Date.now() - since } : {}), ...(note ? { note: clip(note, 200) } : {}) });
  }

  /** Store one artifact; a storage failure is logged, never fatal. */
  async save(name, data) {
    try {
      await this.deps.store.put(name, data);
      return true;
    } catch (err) {
      this.journal(`could not store ${name}: ${firstLine(err?.message)}`);
      return false;
    }
  }

  async timed(name, fn) {
    const t = Date.now();
    try { return await fn(); } finally { this.phases[name] += Date.now() - t; }
  }

  /** Install, look and proof go through the app's semaphore; waiting for it ends at once on abort. */
  heavy(fn) {
    const p = this.deps.heavy ? this.deps.heavy.run(fn) : fn();
    return abortable(p, this.ac.signal);
  }

  destroyNow() {
    if (!this.box) return;
    try { Promise.resolve(this.box.destroy()).catch(() => {}); } catch { /* run() destroys again and checks */ }
  }

  // ---- transcript (admin only): every message as sent, plus the model's reasoning, clipped ----

  push(message, meta = {}) {
    this.messages.push(message);
    if (meta.compactable) this.compactable.push(message);
    let line = '';
    for (let budget = 8000; ; budget = Math.floor(budget / 2)) {
      const entry = { i: this.transcriptCount, turn: this.turns, role: message.role };
      if (message.tool_call_id) entry.tool_call_id = message.tool_call_id;
      entry.content = clipBytes(message.content, budget);
      if (message.tool_calls) {
        const each = Math.max(100, Math.floor((budget * 3) / 8 / message.tool_calls.length));
        entry.tool_calls = message.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: clipBytes(c.function.arguments, each) }));
      }
      if (meta.reasoning) entry.reasoning = clipBytes(meta.reasoning, Math.min(4096, Math.floor(budget / 2)));
      if (meta.finishReason) entry.finishReason = meta.finishReason;
      line = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(line, 'utf8') <= TRANSCRIPT_LINE_MAX || budget < 400) break;
    }
    this.transcriptCount++;
    if (typeof this.deps.store?.append === 'function') {
      this.appendChain = this.appendChain
        .then(() => this.deps.store.append('transcript.jsonl', line))
        .catch((err) => this.journal(`could not append to the transcript: ${firstLine(err?.message)}`));
    } else {
      this.transcript.push(line);
    }
  }

  /** Without store.append the transcript is written once, at the end (empty when there was no conversation). */
  async flushTranscript() {
    await this.appendChain;
    if (typeof this.deps.store?.append !== 'function') await this.save('transcript.jsonl', this.transcript.join(''));
  }

  // ---- the task ----

  /** §2.8: every exit path ends here, with the sandbox destroyed and `done` emitted last. */
  async run() {
    let status = 'done';
    let error;
    try {
      this.caps = resolveCaps(this.task?.caps, { github: this.task?.source?.kind === 'github' });
      checkTask(this.task, this.deps);
    } catch (err) {
      error = `The task settings are invalid: ${firstLine(err.message)}`;
      this.journal(error);
      this.emit('done', { status: 'failed', error });
      return { status: 'failed', receipt: null, error };
    }

    // §2.1.1 timers. The soft stop and the final-check margin shrink with very short wall clocks
    // (tests), so the model is still reached; with the defaults they are the spec's 150 s and 120 s.
    this.t0 = Date.now();
    const wall = this.caps.wallClockSec;
    this.deadline = this.t0 + wall * 1000;
    this.soft = this.deadline - Math.min(150_000, wall * 250);
    this.finalCheckMargin = Math.min(120_000, wall * 200);
    this.reserveMs = Math.min(30_000, wall * 100); // left for proof, copy-out and destroy after a look
    this.minCallMs = Math.min(MIN_CALL_MS, wall * 50);
    if (this.deps.signal?.aborted) this.ac.abort('cancelled');
    else this.deps.signal?.addEventListener('abort', this.onCancel, { once: true });
    this.hard = setTimeout(() => {
      this.timedOut = true;
      this.journal(`hard deadline (${wall} s): destroying the sandbox`);
      this.ac.abort('timeout');
    }, wall * 1000);

    try {
      if (this.ac.signal.aborted) throw new Stopped();
      await this.setup();
      if (this.noIssues) {
        this.stopReason = 'no-issues';
        this.say('the baseline has no issues: nothing to fix, no model call');
        this.step('fix', 'skip', undefined, 'no issues');
        this.step('gate', 'skip');
      } else {
        await this.converse();
        await this.finalState();
      }
      await this.wrapUp();
    } catch (err) {
      this.receipt = null;
      if (this.timedOut) {
        status = 'timeout';
        error = `The run reached its ${durationText(wall)} time limit and was stopped.`;
      } else if (this.ac.signal.aborted) {
        status = 'cancelled';
        error = 'The run was cancelled.';
      } else {
        status = 'failed';
        error = err?.publicMessage ?? FAILURE[this.phase] ?? FAILURE.fix;
      }
      if (!(err instanceof Stopped)) this.journal(`stopped during ${this.phase}: ${firstLine(err?.message)}`);
      this.step(STEP_OF[this.phase] ?? 'fix', 'fail', undefined, status === 'failed' ? error : status);
    } finally {
      clearTimeout(this.hard);
      this.deps.signal?.removeEventListener('abort', this.onCancel);
      if (this.box && !this.cleanedUp) await this.destroyAndConfirm();
      await this.flushTranscript();
      this.emit('done', { status, ...(error ? { error } : {}) });
    }
    return { status, receipt: status === 'done' ? this.receipt : null, ...(error ? { error } : {}) };
  }

  /** §2.1 steps 2–5: sandbox, clone, install, dev server, baseline R0. */
  async setup() {
    const { task, deps } = this;
    const s = task.source;
    const m = task.matrix;
    const list = (a) => (a.length ? a.join(',') : undefined);
    this.matrixArgs = { port: PORT, routes: list(m.routes) };
    for (const k of ['viewports', 'schemes', 'locales']) if (list(m[k])) this.matrixArgs[k] = list(m[k]);

    const tc = Date.now();
    this.step('clone', 'start');
    this.phase = 'sandbox';
    // Not raced with the abort: the sandbox must be known to be destroyed, so wait for it.
    try {
      this.box = await deps.createSandbox({ runtime: deps.runtime, labels: { 'mantis-ring.owner': 'app', 'mantis-ring.task': task.id } });
    } catch (err) {
      // create() removes what it made, but a `docker run` that gave up can leave a container the
      // daemon finished later, and its network with it. This task never got the box, so nothing else
      // would remove them before the app restarts: they go here, by this task's own label only.
      await this.removeByLabel();
      throw err;
    }
    if (this.ac.signal.aborted) throw new Stopped();
    try {
      this.rt = String((await this.box.runtimeName()) ?? '').trim() || 'unknown';
    } catch (err) {
      if (this.ac.signal.aborted) throw new Stopped();
      this.journal(`runtime check failed: ${firstLine(err?.message)}`);
    }
    this.phases.sandbox += Date.now() - tc;
    this.say(`sandbox ${this.box.name} created · runtime ${this.rt} · ${limitsText()} · network ${this.box.network ?? 'unknown'} (this task only) → allowlist proxy`, { sandbox: { name: this.box.name, runtime: this.rt } });

    this.phase = 'clone';
    try {
      this.src = await this.timed('clone', () => bringIn(this.box, s.kind === 'github' ? { kind: 'github', owner: s.owner, name: s.name } : { kind: 'local', dir: s.dir }));
    } catch (err) {
      if (this.ac.signal.aborted) throw new Stopped();
      // The runner's own sentence when it has one: a missing or private repository, one too big, a slow clone.
      throw failure(err?.publicMessage ?? (s.kind === 'github' ? 'The repository could not be cloned from GitHub.' : 'The sample could not be copied into the sandbox.'), err);
    }
    const commit = this.src?.commit ? String(this.src.commit).slice(0, 12) : null;
    this.say(s.kind === 'github' ? `clone done · ${s.owner}/${s.name} at commit ${commit ?? 'unknown'}` : `sample ${s.name} copied in`);
    this.step('clone', 'done', tc, commit ? `commit ${commit}` : undefined);

    this.phase = 'install';
    const ti = Date.now();
    this.step('install', 'start');
    let kind;
    let installed = null;
    try {
      // A monorepo, a broken package.json or nothing to serve is refused here, with the runner's sentence.
      kind = await this.timed('install', () => inspectProject(this.box, { port: PORT }));
      this.start = startCommand(kind, { port: PORT });
      this.say(describePlan(kind));
      installed = await this.timed('install', () => this.heavy(() => installDeps(this.box, kind)));
    } catch (err) {
      if (err instanceof Stopped || this.ac.signal.aborted) throw new Stopped();
      throw failure(err?.publicMessage ?? (/time(d)? ?out/i.test(String(err?.message)) ? "The project's dependencies could not be installed in time." : FAILURE.install), err);
    }
    this.serverKind = /static-server/.test(String(this.start)) ? 'static files' : 'its dev server';
    this.say(kind?.static ? 'static files: nothing to install'
      : kind?.install === false ? 'no dependencies: nothing to install'
        : `dependencies installed through the proxy in ${secs(Date.now() - ti)} s${installed?.ran?.length ? ` (${installed.ran.at(-1).split(' --')[0]})` : ''}`);
    this.phase = 'serve';
    try {
      this.origin = await this.timed('serve', () => startDevServer(this.box, this.start, PORT, () => this.ac.signal.aborted, { routes: m.routes }));
    } catch (err) {
      if (this.ac.signal.aborted) throw new Stopped();
      throw failure(err?.publicMessage ?? `The app did not start inside the sandbox (no answer on port ${PORT}).`, err);
    }
    this.useOrigin(this.origin);
    this.say(`dev server up at ${baseUrl(this.matrixArgs)} (${this.serverKind})${this.matrixArgs.port !== PORT ? `; it chose port ${this.matrixArgs.port} itself` : ''}`);
    if (this.origin?.warm) this.journal(`warm-up: ${this.origin.warm}`);
    this.step('install', 'done', ti);

    this.phase = 'baseline';
    const tl = Date.now();
    this.step('look', 'start');
    let R0;
    try {
      R0 = await this.timed('baseline', () => this.heavy(() => look(this.box, { ...this.matrixArgs, baseline: 'none', timeoutSec: this.caps.lookTimeoutSec })));
    } catch (err) {
      if (err instanceof Stopped || this.ac.signal.aborted) throw new Stopped();
      throw failure(`The app could not be measured: ${lookReason(err)}.`, err);
    }
    const s0 = R0?.report?.summary;
    if (!s0 || typeof R0.runDir !== 'string' || typeof R0.runId !== 'string') throw failure('The app could not be measured: the checker returned no usable report.');
    if (num(s0.cells) > 0 && num(s0.crashedCells) >= num(s0.cells)) throw failure('The app could not be measured: every screen crashed while loading.');
    this.R0 = R0;
    this.R0dir = R0.runDir;
    this.r0Crashed = num(s0.crashedCells);
    this.lastRunId = R0.runId;
    await this.save('r0.report.json', JSON.stringify(R0.report));
    this.emit('look', lookEvent('baseline', R0));
    // Every later run must measure these screens again; with none, nothing could ever be compared.
    this.expected = await this.measurableCells(R0);
    if (this.expected.size === 0) throw failure('The app could not be measured: no screen loaded at the starting point.');
    this.say(`baseline R0 ${R0.runId}: ${num(s0.errors)} errors, ${num(s0.warnings)} warnings in ${num(s0.cells)} screens`
      + `${this.expected.size < num(s0.cells) ? ` (${this.expected.size} of them could be measured and are compared from now on)` : ''}`);
    this.step('look', 'done', tl, `${num(s0.errors)} errors, ${num(s0.warnings)} warnings`);
    this.noIssues = num(s0.errors) + num(s0.warnings) === 0;
  }

  /** R0's screens that later runs must measure again: status 'ok', and a state Mantis can compare with (R0's state.json). */
  async measurableCells(R0) {
    const ok = okCells(R0.report);
    try {
      const state = await this.readJson(`${R0.runDir}/state.json`);
      this.r0State = state;
      const cells = state?.cells && typeof state.cells === 'object' ? state.cells : {};
      return new Set([...ok].filter((k) => Object.hasOwn(cells, k)));
    } catch (err) {
      if (this.ac.signal.aborted) throw new Stopped();
      this.journal(`R0 state.json not read (${firstLine(err?.message)}); every screen with status ok is expected`);
      return ok;
    }
  }

  /**
   * The R0 screens that run L did not measure: a cell that is not 'ok' in it (the page failed to load,
   * answered HTTP 400 or more, crashed, or lost its translation), or one left out of its comparison
   * with R0. Mantis compares only the cells it could measure, so without this check an edit that
   * breaks a whole route would look like "1 fixed · 0 new".
   */
  unmeasured(L) {
    const ok = okCells(L?.report);
    const names = [...this.expected].filter((k) => !ok.has(k));
    const compared = num(L?.report?.baseline?.cellsCompared);
    return { count: Math.max(names.length, this.expected.size - compared), names };
  }

  /** §2.1.6 and §2.2: the workspace, then turns until a stop rule fires. */
  async converse() {
    const { task, caps } = this;
    this.phase = 'fix';
    const tf = Date.now();
    this.step('fix', 'start');
    let ws;
    try {
      ws = await this.timed('clone', () => initWorkspace(this.box, this.src ?? { kind: 'local' }));
    } catch (err) {
      if (this.ac.signal.aborted) throw new Stopped();
      throw failure('The project could not be prepared for edits.', err);
    }
    this.base = ws.base;
    this.upstream = ws.upstream;
    this.accepted = { sha: this.base, look: null, check: 0 };
    this.say(`workspace ready · base snapshot ${this.base.slice(0, 12)}${this.upstream ? ` on top of commit ${this.upstream.slice(0, 12)}` : ''}`);
    this.tools = fileTools(this.box, { onWrite: (rel, info) => this.onWrite(rel, info) });

    this.push({ role: 'system', content: systemPrompt({ maxChecks: caps.maxChecks }) });
    this.push({
      role: 'user',
      content: taskMessage({
        projectLabel: task.source.label || task.source.name, serverKind: this.serverKind, port: this.matrixArgs?.port ?? PORT, matrix: task.matrix,
        report: this.R0.report, maxChecks: caps.maxChecks,
      }),
    });

    for (;;) {
      if (this.ac.signal.aborted) throw new Stopped();
      if (this.overBudget) { this.stopReason = 'budget'; break; }
      if (Date.now() > this.soft) { this.stopReason = 'time'; break; }
      if (this.turns >= caps.maxTurns) { this.stopReason = 'turns'; break; }
      // After the last check the model gets exactly one more turn, to call finish.
      if (this.checksLeft <= 0 && this.turnsSinceCheck >= 1) { this.stopReason = 'checks'; break; }
      if (this.turnsSinceCheck >= caps.maxTurnsPerCheck && this.dirty && this.checksLeft > 0) {
        const text = await this.runCheck({ forced: true });
        this.push({ role: 'user', content: `${forcedCheckPreamble()}\n${text}` });
        continue;
      }
      const reply = await this.callModel();
      if (!reply) break; // budget or inference: stopReason is set
      if (reply.calls.length === 0) {
        // No tool call (finish_reason "length" included): nudge once, then take the text as the summary.
        this.noToolStreak++;
        if (this.noToolStreak >= 2) {
          this.summary = clip(reply.content, SUMMARY_MAX);
          this.stopReason = 'no-tools';
          break;
        }
        this.push({ role: 'user', content: nudgeMessage() });
        continue;
      }
      this.noToolStreak = 0;
      if (await this.runTools(reply.calls, reply.originals)) { this.stopReason = 'finish'; break; }
    }
    this.say(`model loop ended: ${STOP_TEXT[this.stopReason] ?? this.stopReason} · ${this.turns} turns, ${this.checks} checks`);
    this.step('fix', 'done', tf, this.stopReason);
  }

  /** §2.2 steps 9–10: one model call. Returns null when the run must stop (budget, inference, time). */
  async callModel() {
    const { task, caps, deps } = this;
    // A call may only use the time left before the soft stop, retries included. A call that started
    // just before it (a long answer, or a queue at the gateway) would otherwise run into the hard
    // deadline, and the run would end with no receipt although earlier checks were accepted.
    const left = this.soft - Date.now();
    if (left < this.minCallMs) {
      this.stopReason = 'time';
      this.say('too little time is left for another model call: the run stops here and keeps what was measured');
      return null;
    }
    const budget = AbortSignal.timeout(left);
    const signal = AbortSignal.any([this.ac.signal, budget]);
    // After the last check, finish is forced, unless the gateway already refused a forced tool_choice.
    let toolChoice = this.checksLeft <= 0 && !this.forcedChoiceRefused ? { type: 'function', function: { name: 'finish' } } : 'auto';
    const sampling = {};
    for (const k of ['temperature', 'topP']) if (Number.isFinite(task.sampling?.[k])) sampling[k] = task.sampling[k];
    if (Number.isInteger(task.sampling?.seed)) sampling.seed = task.sampling.seed;
    const before = tallyNumbers(deps.tally);
    const t = Date.now();
    // The model has now been sent every tool result so far: a check may compact those (§2.3.8).
    this.seenCompactable = this.compactable.length;
    let res;
    for (;;) {
      try {
        res = await abortable(deps.chat({
          model: task.model, messages: this.messages, tools: TOOL_SCHEMAS, toolChoice,
          maxTokens: caps.maxCompletionTokens, reasoning: caps.reasoning, ...sampling,
          signal, timeoutMs: Math.min(300_000, left), tally: deps.tally, guard: deps.guard,
        }), this.ac.signal);
        break;
      } catch (err) {
        if (err instanceof Stopped || this.ac.signal.aborted) {
          this.phases.model += Date.now() - t;
          throw new Stopped();
        }
        if (budget.aborted) {
          this.phases.model += Date.now() - t;
          this.stopReason = 'time';
          this.say('the model call ran into the time limit: the run stops here and keeps what was measured');
          this.journal(`model call stopped at the soft time limit: ${firstLine(err?.message)}`);
          return null;
        }
        // Forced tool_choice is not confirmed on this gateway (fact §0.5 #6) and the loop must not depend
        // on it: when it is refused as a bad request, ask once more with 'auto' and stop forcing it.
        if (toolChoice !== 'auto' && (err?.status === 400 || err?.status === 422) && !(err instanceof BudgetError)) {
          this.forcedChoiceRefused = true;
          this.journal(`the gateway refused the forced tool_choice (HTTP ${err.status}); asking again with tool_choice auto`);
          toolChoice = 'auto';
          continue;
        }
        this.phases.model += Date.now() - t;
        if (err instanceof BudgetError || err?.name === 'BudgetError') {
          this.stopReason = 'budget';
          this.say(`budget reached (${err?.scope ?? 'task'}): no further model call`);
        } else {
          this.stopReason = 'inference';
          this.say(`the model service did not answer${err?.status ? ` (HTTP ${err.status})` : ''}; the run stops here`);
        }
        this.journal(`model call failed: ${firstLine(err?.message)}`);
        return null;
      }
    }
    const ms = Date.now() - t;
    this.phases.model += ms;
    this.turns++;
    this.turnsSinceCheck++;

    const msg = res?.message ?? {};
    const { calls, originals } = normalizeCalls(msg.tool_calls, this.turns);
    const content = typeof msg.content === 'string' ? msg.content : '';
    const assistant = { role: 'assistant', content };
    if (calls.length) assistant.tool_calls = calls;
    this.push(assistant, { reasoning: msg.reasoning ?? msg.reasoning_content, finishReason: res?.finishReason });

    const usage = res?.usage ?? {};
    const after = tallyNumbers(deps.tally);
    this.emit('model', {
      turn: this.turns, check: this.checks, model: res?.model ?? task.model, provider: PROVIDER, ms: num(res?.ms) || ms,
      promptTokens: num(usage.prompt_tokens), completionTokens: num(usage.completion_tokens),
      reasoningTokens: num(usage.completion_tokens_details?.reasoning_tokens),
      usd: before.usd === null || after.usd === null ? null : round6(after.usd - before.usd),
      finishReason: res?.finishReason ?? null, calls: calls.map((c) => c.function.name),
    });
    // The guard enforces the caps before each call; this catches a guard that let one through.
    const spent = minus(after, this.tally0);
    if (spent.promptTokens >= caps.maxPromptTokens || (spent.usd !== null && spent.usd >= caps.maxUsd)) {
      this.overBudget = true;
      this.say(`task budget used up (${spent.promptTokens} prompt tokens${spent.usd === null ? '' : `, $${spent.usd.toFixed(4)}`}): this is the last turn`);
    }
    return { calls, originals, content };
  }

  /**
   * §2.2 step 12: the calls of one reply, in order. check_ui is deferred to the end of the batch
   * so later edits are measured too. One tool message per call, in the original order.
   * @param {object[]} calls  as echoed in the history
   * @param {object[]} originals  as the model sent them (same ids), for parseToolCall
   * @returns {Promise<boolean>} whether the model called finish
   */
  async runTools(calls, originals = calls) {
    const { caps } = this;
    const results = new Array(calls.length);
    const names = new Array(calls.length).fill('');
    let checkAt = -1;
    let finished = false;
    this.toolCalls += calls.length;
    for (let i = 0; i < calls.length; i++) {
      if (i >= caps.maxCallsPerTurn) { results[i] = `skipped: at most ${caps.maxCallsPerTurn} tool calls per turn`; continue; }
      if (finished) { results[i] = 'ignored: task finished'; continue; }
      let p;
      try { p = parseToolCall(originals[i]); } catch { p = { name: calls[i].function.name, error: 'the tool call could not be read' }; }
      names[i] = p.name;
      if (p.error) {
        this.invalidCalls++;
        results[i] = this.toolDone(p.name || '(none)', '', asError(p.error), 0);
        continue;
      }
      if (p.name === 'check_ui') {
        if (checkAt >= 0) results[i] = 'already measured in this turn';
        else checkAt = i;
        continue;
      }
      if (p.name === 'finish') {
        finished = true;
        this.summary = clip(typeof p.args?.summary === 'string' ? p.args.summary : '', SUMMARY_MAX);
        results[i] = this.toolDone('finish', '', 'ok', 0);
        continue;
      }
      results[i] = await this.runFileTool(p);
    }
    if (checkAt >= 0) results[checkAt] = await this.checkTool();
    for (let i = 0; i < calls.length; i++) {
      this.push({ role: 'tool', tool_call_id: calls[i].id, content: String(results[i]) }, { compactable: COMPACTABLE.has(names[i]) });
    }
    return finished;
  }

  /** Emit the `tool` event for one finished call and return its result. */
  toolDone(name, target, result, ms) {
    const ok = isOk(result);
    if (!ok && /^error\b/.test(result)) this.toolErrors++;
    this.emit('tool', { turn: this.turns, name, target: clip(target, 120), ok, ms, note: clip(toolNote(name, result), 160) });
    return result;
  }

  async runFileTool(p) {
    const target = toolTarget(p.args);
    if (!FILE_TOOL_NAMES.includes(p.name) || typeof this.tools?.[p.name] !== 'function') {
      this.invalidCalls++;
      return this.toolDone(p.name, target, `error: unknown tool ${p.name}`, 0);
    }
    if (WRITE_TOOL_NAMES.includes(p.name) && this.checksLeft <= 0) return this.toolDone(p.name, target, editsLockedMessage(), 0);
    const t = Date.now();
    let result;
    try {
      result = await this.tools[p.name](p.args);
      if (typeof result !== 'string') result = String(result ?? '');
    } catch (err) {
      if (this.ac.signal.aborted) throw new Stopped();
      if (err instanceof ToolError || err?.name === 'ToolError') {
        result = asError(err.message);
      } else {
        // Never show the model a stack trace or a host path; the journal keeps the detail.
        this.journal(`tool ${p.name} failed: ${firstLine(err?.message)}`);
        result = 'error: the tool failed inside the sandbox; try again or use another tool';
      }
    }
    const ms = Date.now() - t;
    this.phases.tools += ms;
    return this.toolDone(p.name, target, result, ms);
  }

  /** The deferred check_ui of a batch. */
  async checkTool() {
    if (this.checksLeft <= 0) return this.toolDone('check_ui', '', 'error: no checks left. Call finish.', 0);
    if (!this.dirty) return this.toolDone('check_ui', '', noChangeMessage({ checksLeft: this.checksLeft }), 0);
    const t = Date.now();
    const text = await this.runCheck({});
    const row = this.checkRows.at(-1);
    this.emit('tool', {
      turn: this.turns, name: 'check_ui', target: `check ${row.check}`, ok: row.decision === 'accepted' || row.decision === 'kept',
      ms: Date.now() - t, note: clip(`${row.decision}${row.line ? ` · ${row.line}` : ''}`, 160),
    });
    return text;
  }

  /** fileTools' onWrite: the touched sets of §2.5 and the "unmeasured edits" flag. */
  onWrite(rel, info = {}) {
    if (typeof rel !== 'string' || rel === '') return;
    const p = rel.startsWith('/work/app/') ? rel.slice('/work/app/'.length) : rel;
    this.touchedAll.add(p);
    this.touchedRound.add(p);
    if (info?.created) this.createdRound.add(p);
    this.dirty = true;
  }

  restoredTo() {
    return this.accepted.check === 0 ? 'the start' : `check ${this.accepted.check}`;
  }

  /**
   * Whether lost controls reject a check like a cover-up does: with the gate on, for a sample
   * project. A sample is static, so a control or heading that was visible at the start and is gone
   * now was removed or hidden by the edit. On a live site the same signal can come from changing
   * content, so a GitHub run only reports it (its verdict is then at best partial).
   */
  lostGate() {
    return Boolean(this.task.gate) && this.task.source?.kind === 'sample';
  }

  endRound() {
    this.dirty = false;
    this.touchedRound.clear();
    this.createdRound.clear();
  }

  /** A look may use the time that is left, minus what proof, copy-out and destroy need. */
  lookTimeoutSec() {
    return Math.min(this.caps.lookTimeoutSec, Math.floor((this.deadline - Date.now() - this.reserveMs) / 1000));
  }

  /**
   * Measure where startDevServer() found the app: 127.0.0.1 or ::1, port 3000 or the port the server
   * chose itself. Anything else (an older runner that returned nothing) means 127.0.0.1:3000.
   */
  useOrigin(o) {
    const host = o?.host === '::1' ? '::1' : '127.0.0.1';
    const port = Number.isInteger(o?.port) && o.port >= 1 && o.port <= 65535 ? o.port : PORT;
    this.origin = { ...(o && typeof o === 'object' ? o : {}), host, port };
    this.matrixArgs.host = host;
    this.matrixArgs.port = port;
  }

  /** Restart the dev server if it stopped answering (the model's edit, or the S7b test hook). */
  async ensureServer() {
    let up = false;
    try { up = await devServerUp(this.box, { host: this.matrixArgs.host ?? '127.0.0.1', port: this.matrixArgs.port }); } catch { up = false; }
    if (up) return;
    if (this.ac.signal.aborted) throw new Stopped();
    this.say('the dev server was not answering; restarting it');
    this.useOrigin(await startDevServer(this.box, this.start, PORT, () => this.ac.signal.aborted));
    this.say(`dev server up again at ${baseUrl(this.matrixArgs)}`);
  }

  /** Cover-up issues of a check that were not already there in the accepted state (gate OFF keeps old ones). */
  coverUpsAdded(L) {
    const now = (L.report.issues ?? []).filter((i) => i.type === 'cover-up');
    const prevLook = this.accepted.look;
    if (now.length === 0) return Math.max(0, num(L.report.baseline?.coverUps) - num(prevLook?.report?.baseline?.coverUps));
    const key = (i) => i.fingerprint ?? `${i.route} ${i.selector}`;
    const seen = new Set((prevLook?.report?.issues ?? []).filter((i) => i.type === 'cover-up').map(key));
    return now.filter((i) => !seen.has(key(i))).length;
  }

  /**
   * §2.3: one measured round, always against R0. Decides accepted / kept / reverted / tamper /
   * failed, snapshots or reverts, records the round, compacts old file output and returns the
   * text for the model.
   */
  async runCheck({ forced = false, final = false } = {}) {
    const t = Date.now();
    const k = ++this.checks;
    this.turnsSinceCheck = 0;
    const restoredTo = this.restoredTo();
    this.say(`check ${k} of ${this.caps.maxChecks}${forced ? ' (forced: many turns without a check)' : final ? ' (final measurement)' : ''}: measuring against R0`);

    const staged = await stageAll(this.box, [...this.touchedRound]);
    for (const p of staged) this.touchedAll.add(p);
    const diff = await changedSince(this.box, this.accepted.sha, [...new Set([...this.touchedRound, ...staged])]);
    const hits = tamperHits(diff);

    await this.deps.onCheck?.({ check: k, phase: 'before', box: this.box });
    let L = null;
    let failReason = null;
    try {
      await this.ensureServer();
    } catch (err) {
      if (err instanceof Stopped || this.ac.signal.aborted) throw new Stopped();
      failReason = 'the dev server did not start again';
      this.journal(`check ${k}: dev server restart failed: ${firstLine(err?.message)}`);
    }
    if (!failReason) {
      try {
        // The time limit is taken once the heavy slot is free: waiting for it can take a whole look.
        L = await this.heavy(() => {
          const timeoutSec = this.lookTimeoutSec();
          if (timeoutSec < MIN_LOOK_SEC) throw new NoTime();
          return look(this.box, { ...this.matrixArgs, baseline: this.R0dir, prevRunId: this.lastRunId, timeoutSec });
        });
      } catch (err) {
        if (err instanceof Stopped || this.ac.signal.aborted) throw new Stopped();
        if (err instanceof NoTime) {
          failReason = err.message;
        } else {
          failReason = lookReason(err);
          this.journal(`check ${k}: look failed (${err?.reason ?? 'error'}): ${firstLine(err?.message)}`);
        }
      }
    }
    const b = L?.report?.baseline ?? null;
    if (L && !b && !failReason) failReason = 'the comparison with the starting point failed';

    let decision;
    let missing = null;
    if (hits.length) decision = 'tamper';
    else if (failReason) decision = 'failed';
    else if (L.crashed && num(L.report.summary?.crashedCells) > this.r0Crashed) { decision = 'failed'; failReason = 'some screens crashed while loading'; }
    else if ((missing = this.unmeasured(L)).count > 0) { decision = 'failed'; failReason = screensText(missing); }
    else if (num(b.coverUps) > 0) decision = this.task.gate ? 'reverted' : 'kept';
    else if (num(b.lost) > 0 && this.lostGate()) decision = 'lost';
    else decision = 'accepted';

    const added = b ? this.coverUpsAdded(L) : 0;
    if (decision === 'tamper' || decision === 'failed' || decision === 'reverted' || decision === 'lost') {
      const created = this.createdRound.size;
      await revertTo(this.box, this.accepted.sha);
      const clean = await isClean(this.box, this.accepted.sha);
      this.say(`check ${k}: ${decision}${failReason ? ` (${failReason})` : ''} · every edit since ${restoredTo} undone${created ? ` (${created} new file${created === 1 ? '' : 's'} removed)` : ''} · git diff --quiet ${this.accepted.sha.slice(0, 12)}: ${clean ? 'clean' : 'NOT clean'}`);
      if (!clean) throw new Error(`the revert to ${restoredTo} left a difference`);
      this.revertedSinceAccept = true;
      if (decision === 'tamper') this.tamperAttempts++;
      if (decision === 'reverted') { this.reverts++; this.coverUpAttempts += added; }
      if (decision === 'lost') { this.reverts++; this.lostAttempts++; }
      await this.deps.onCheck?.({ check: k, phase: 'after', decision, box: this.box });
    } else {
      const sha = await snapshot(this.box, `check ${k}`);
      if (decision === 'kept') this.coverUpAttempts += added;
      this.accepted = { sha, look: L, check: k };
      this.revertedSinceAccept = false;
      this.say(`check ${k}: ${decision} · ${receiptLine(b)} · snapshot ${sha.slice(0, 12)}`);
    }

    const ms = Date.now() - t;
    this.phases.checks += ms;
    this.checkRows.push({ check: k, decision, line: b ? receiptLine(b) : null, runId: L?.runId ?? null, ms, forced, final, ...(failReason ? { reason: failReason } : {}) });
    if (L) {
      await this.save(`check-${k}.report.json`, JSON.stringify(L.report));
      this.emit('look', lookEvent('check', L, k));
      this.lastRunId = L.runId;
    }
    const issuesOf = (type) => (L?.report?.issues ?? []).filter((i) => i.type === type).slice(0, 20);
    const coverUps = issuesOf('cover-up')
      .map((i) => ({ type: i.evidence?.was?.type ?? 'cover-up', selector: i.selector ?? null, kind: i.evidence?.kind ?? null, cells: [...(i.cells ?? [])] }));
    const lost = decision === 'lost'
      ? issuesOf('lost').map((i) => ({ control: i.evidence?.control ?? (Number.isFinite(i.evidence?.count) ? `${i.evidence.count} controls` : null), selector: i.selector ?? null, cells: [...(i.cells ?? [])] }))
      : [];
    this.emit('gate', {
      check: k, decision,
      ...(decision === 'accepted' || decision === 'kept' ? {} : { restoredTo }),
      ...(coverUps.length ? { coverUps } : {}),
      ...(lost.length ? { lost } : {}),
      ...(hits.length ? { tamperHits: hits } : {}),
      ...(decision === 'failed' ? { reason: failReason } : {}),
    });
    this.journal(`check ${k} ${decision}${b ? ` ${receiptLine(b)}` : ''}${failReason ? ` (${failReason})` : ''}`);
    this.endRound();

    // §2.3.8: file output the model has already been sent is replaced, so the prompt stays small.
    // Results it has not seen yet (a forced check right after a batch) stay for its next turn.
    const seen = Math.min(this.seenCompactable, this.compactable.length);
    for (const m of this.compactable.slice(0, seen)) m.content = compactedToolResult(k);
    this.compactable = this.compactable.slice(seen);
    this.seenCompactable = 0;

    if (final) return '';
    let text = checkMessage({
      check: k, maxChecks: this.caps.maxChecks, outcome: decision, look: L ? { report: L.report } : null, r0: { report: this.R0.report },
      view: this.task.gate ? 'gate' : 'plain', restoredTo, tamperHits: hits, failReason,
    });
    if (this.checksLeft <= 0) text += `\n${lastCheckMessage()}`;
    return text;
  }

  /** §2.5: measure or discard unmeasured edits, settle the final run RF, build and verify the patch. */
  async finalState() {
    this.phase = 'gate';
    const tg = Date.now();
    this.step('gate', 'start');
    if (this.dirty) {
      if (this.checksLeft > 0 && this.deadline - Date.now() > this.finalCheckMargin) {
        await this.runCheck({ final: true });
      } else {
        const restoredTo = this.restoredTo();
        await stageAll(this.box, [...this.touchedRound]); // so files created since the last check are removed too
        await revertTo(this.box, this.accepted.sha);
        this.revertedSinceAccept = true;
        this.endRound();
        this.say(`unmeasured edits discarded: files restored to ${restoredTo}`);
      }
    }

    if (this.accepted.look) this.RF = this.revertedSinceAccept ? await this.verifyLook() : this.accepted.look;
    if (this.RF) {
      await this.save('rf.report.json', JSON.stringify(this.RF.report));
      const tv = Date.now();
      try {
        // Only the paths the model touched: files the install or the dev server wrote never pollute it.
        this.patch = await patchSince(this.box, this.base, [...this.touchedAll]);
        if (this.patch) {
          try {
            this.patchOk = await patchApplies(this.box, this.patch, this.upstream ?? this.base);
          } catch (err) {
            if (this.ac.signal.aborted) throw new Stopped();
            this.patchOk = false;
            this.journal(`patch check could not run: ${firstLine(err?.message)}`);
          }
        }
      } finally {
        this.phases.verify += Date.now() - tv;
      }
    }
    const bytes = Buffer.byteLength(this.patch, 'utf8');
    this.storedPatch = bytes > PATCH_MAX ? cutPatch(this.patch, PATCH_MAX) : this.patch;
    this.patchTruncated = bytes > PATCH_MAX;
    if (this.patch) {
      const st = diffStats(this.patch);
      this.say(`patch: ${st.files} file(s), +${st.insertions} −${st.deletions} · applies to the original: ${this.patchOk ? 'yes' : 'NO'}${this.patchTruncated ? ' · stored truncated to 1 MB' : ''}`);
    } else {
      this.say('no change kept: the project is back at its starting point');
    }
    this.step('gate', 'done', tg, receiptLine(this.RF?.report?.baseline ?? null));
  }

  /** §2.5.2: after a revert, measure the final files once more (not counted as a check). */
  async verifyLook() {
    const prev = this.accepted.look;
    const k = this.accepted.check;
    const tooLate = () => {
      this.say(`verify look skipped (not enough time left): the final files are what check ${k} measured`);
      return prev;
    };
    if (this.lookTimeoutSec() < MIN_LOOK_SEC) return tooLate();
    const t = Date.now();
    try {
      await this.ensureServer();
      const v = await this.heavy(() => {
        const timeoutSec = this.lookTimeoutSec();
        if (timeoutSec < MIN_LOOK_SEC) throw new NoTime();
        return look(this.box, { ...this.matrixArgs, baseline: this.R0dir, prevRunId: this.lastRunId, timeoutSec });
      });
      this.lastRunId = v.runId;
      this.emit('look', lookEvent('verify', v));
      if (!v?.report?.baseline) { this.say(`verify look gave no comparison; using check ${k}`); return prev; }
      if (v.crashed && num(v.report.summary?.crashedCells) > this.r0Crashed) { this.say(`verify look had crashed screens; using check ${k}`); return prev; }
      const missing = this.unmeasured(v);
      if (missing.count > 0) { this.say(`verify look: ${screensText(missing)}; using check ${k}`); return prev; }
      this.say(sameNumbers(v.report, prev.report)
        ? `verify matches check ${k}: ${receiptLine(v.report.baseline)}`
        : `verify differs from check ${k}: ${receiptLine(v.report.baseline)} (check ${k}: ${receiptLine(prev.report.baseline)}); using the verify run`);
      return v;
    } catch (err) {
      if (err instanceof Stopped || this.ac.signal.aborted) throw new Stopped();
      if (err instanceof NoTime) return tooLate();
      this.say(`verify look failed (${lookReason(err)}): the final files are what check ${k} measured`);
      return prev;
    } finally {
      this.phases.verify += Date.now() - t;
    }
  }

  /** §2.7: proof, copy-out, destroy, vision, receipt. */
  async wrapUp() {
    this.phase = 'wrapup';
    if (this.RF) await this.makeProof();
    await this.copyArtifacts();
    const plan = await this.prepareVision();
    await this.destroyAndConfirm();
    clearTimeout(this.hard); // the sandbox is gone: nothing left for the hard deadline to contain
    // The receipt splits the tally here, so the fix and vision rows stay apart even when both roles use one model.
    this.tallyBeforeVision = snapshotTally(this.deps.tally);
    const vision = await this.runVision(plan);
    await this.writeReceipt(vision);
  }

  async makeProof() {
    const proofSec = () => Math.min(90, Math.floor((this.deadline - Date.now() - this.reserveMs) / 1000));
    const skipped = () => this.say('proof sheet skipped: not enough time left');
    if (proofSec() < 5) { skipped(); return; }
    const t = Date.now();
    try {
      // The time limit is taken once the heavy slot is free. Absolute run dirs: the latest/prev
      // aliases only resolve against cwd/.mantis.
      const r = await this.heavy(() => {
        const timeoutSec = proofSec();
        if (timeoutSec < 5) throw new NoTime();
        return this.box.execArgs(['sh', '-c',
          'mkdir -p /work/.ring && cd /work && exec timeout -k 5 "$1" mantis proof --before "$2" --after "$3" --out /work/.ring/proof.png',
          'proof', String(timeoutSec), this.R0dir, this.RF.runDir], { timeoutMs: (timeoutSec + 15) * 1000 });
      });
      if (r.code === 0) this.proofPath = '/work/.ring/proof.png';
      else { this.say('the proof sheet could not be made'); this.journal(`proof failed (exit ${r.code}): ${lastLine(r.stderr)}`); }
    } catch (err) {
      if (err instanceof Stopped || this.ac.signal.aborted) throw new Stopped();
      if (err instanceof NoTime) skipped();
      else this.journal(`proof failed: ${firstLine(err?.message)}`);
    } finally {
      this.phases.proof += Date.now() - t;
    }
  }

  /** Copy one PNG out with readFile (regular file, size-capped) into a name the host chooses. */
  async copyPng(abs, name) {
    try {
      const buf = await this.box.readFile(abs, { maxBytes: PNG_MAX });
      if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 4).equals(PNG_MAGIC)) {
        this.journal(`${name} not stored: not a PNG`);
        return null;
      }
      return (await this.save(name, buf)) ? buf : null;
    } catch (err) {
      if (this.ac.signal.aborted) throw new Stopped();
      this.journal(`${name} not copied: ${firstLine(err?.message)}`);
      return null;
    }
  }

  async readJson(abs) {
    const buf = await this.box.readFile(abs, { maxBytes: JSON_MAX });
    return JSON.parse(Buffer.from(buf).toString('utf8'));
  }

  async copyArtifacts() {
    const t = Date.now();
    try {
      if (this.proofPath && (await this.copyPng(this.proofPath, 'proof.png'))) this.proof = 'proof.png';
      await this.copyPng(`${this.R0dir}/contact-sheet.png`, 'contact-before.png');
      if (this.RF) await this.copyPng(`${this.RF.runDir}/contact-sheet.png`, 'contact-after.png');
    } finally {
      this.phases.copyOut += Date.now() - t;
    }
  }

  /**
   * Vision on (task.visionModel and deps.vision): while the sandbox still exists, read both runs'
   * state.json and the screenshots of the pairs vision.mjs picks, and set each pair's `before`/`after`
   * to the PNG bytes. vision.mjs is loaded only here, so a problem in it can only skip the vision check.
   */
  async prepareVision() {
    if (!this.RF || !this.task.visionModel || typeof this.deps.vision !== 'function') return null;
    const t = Date.now();
    try {
      const { pickPairs } = await import('./vision.mjs');
      const r0State = this.r0State ?? await this.readJson(`${this.R0dir}/state.json`);
      const rfState = await this.readJson(`${this.RF.runDir}/state.json`);
      await this.save('r0.state.json', JSON.stringify(r0State));
      await this.save('rf.state.json', JSON.stringify(rfState));
      const r0 = { report: this.R0.report, state: r0State, runDir: this.R0dir };
      const rf = { report: this.RF.report, state: rfState, runDir: this.RF.runDir };
      const picked = pickPairs({ r0, rf, max: 4 });
      const pairs = [];
      for (const [k, pair] of (Array.isArray(picked) ? picked : []).slice(0, 4).entries()) {
        // vision.mjs numbers pairs from 1 (`i`); the number names shot-/crop-before-<i>.png.
        const i = Number.isInteger(pair?.i) && pair.i >= 1 && pair.i <= 9 ? pair.i : k + 1;
        const beforeShot = shotOf(this.R0.report, pair, 'before');
        const afterShot = shotOf(this.RF.report, pair, 'after');
        if (!beforeShot || !afterShot) continue;
        const before = await this.copyPng(`${this.R0dir}/${beforeShot}`, `shot-before-${i}.png`);
        const after = await this.copyPng(`${this.RF.runDir}/${afterShot}`, `shot-after-${i}.png`);
        if (before && after) pairs.push({ ...pair, i, before, after });
      }
      return { pairs, r0, rf };
    } catch (err) {
      if (err instanceof Stopped || this.ac.signal.aborted) throw new Stopped();
      this.journal(`vision preparation failed: ${firstLine(err?.message)}`);
      return { pairs: [], error: 'the vision check could not be prepared' };
    } finally {
      this.phases.copyOut += Date.now() - t;
    }
  }

  /** §2.9, after destroy: the second opinion. It never changes counts, the gate or the publish bar. */
  async runVision(plan) {
    const model = this.task.visionModel ?? null;
    const skipped = { model, provider: PROVIDER, verdict: 'skipped', agree: null, pairs: [] };
    if (!plan) { this.step('vision', 'skip'); return skipped; }
    if (!plan.pairs.length) {
      this.step('vision', 'skip', undefined, plan.error ?? 'no fixed issue to show');
      return plan.error ? { ...skipped, verdict: 'error', note: plan.error } : skipped;
    }
    const t = Date.now();
    this.step('vision', 'start');
    const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(VISION_TIMEOUT_MS)]);
    try {
      // The app's deps.vision adds chat, tally and guard (visionCheck in vision.mjs); `store` keeps the crops.
      const v = await abortable(this.deps.vision({
        model, pairs: plan.pairs, diffText: this.patch, r0: plan.r0, rf: plan.rf, sampling: this.task.sampling ?? {}, signal, store: this.deps.store,
      }), signal);
      const result = {
        model, provider: PROVIDER, verdict: v?.verdict ?? 'unclear', agree: typeof v?.agree === 'number' ? v.agree : null,
        pairs: (v?.pairs ?? []).map((p) => ({ issue: p.issue, mantis: p.mantis, vision: p.vision, evidence: clip(p.evidence, 300) })),
        usd: typeof v?.usd === 'number' ? v.usd : null,
      };
      this.emit('vision', { model, provider: PROVIDER, verdict: result.verdict, agree: result.agree, pairs: result.pairs });
      this.say(`second opinion · ${model} on ${PROVIDER}: ${String(result.verdict).toUpperCase()}. Mantis's measurement decides.`);
      this.step('vision', 'done', t, result.verdict);
      return result;
    } catch (err) {
      if (this.ac.signal.aborted) throw new Stopped();
      this.journal(`vision failed: ${firstLine(err?.message)}`);
      this.step('vision', 'fail', t, 'the second opinion did not answer');
      return { ...skipped, verdict: 'error', note: 'the second opinion did not answer' };
    } finally {
      this.phases.vision += Date.now() - t;
    }
  }

  /**
   * Remove every container and sandbox network that carries this task's own label (never another
   * task's or a self-test's). Never throws.
   */
  async removeByLabel() {
    try {
      const n = await Sandbox.removeAll(`mantis-ring.task=${this.task.id}`);
      if (n.containers || n.networks) this.journal(`removed by this task's label: ${n.containers} container(s), ${n.networks} network(s)`);
    } catch (err) {
      this.journal(`removal by label failed: ${firstLine(err?.message)}`);
    }
  }

  /**
   * §2.7.3 and §2.8: destroy (the container, then its own network), then confirm with `docker ps -a`.
   * Never throws.
   */
  async destroyAndConfirm() {
    const t = Date.now();
    let gone = false;
    let failed = false;
    const isGone = async () => {
      try { return (await this.box.gone()) === true; } catch (err) { this.journal(`gone check failed: ${firstLine(err?.message)}`); return false; }
    };
    try { await this.box.destroy(); } catch (err) { failed = true; this.journal(`destroy failed: ${firstLine(err?.message)}`); }
    gone = await isGone();
    if (!gone || failed) {
      // One more try, by name and then by this task's own label (never another task's or a self-test's
      // container or network), so neither the sandbox nor its network stays until the app restarts.
      try { await this.box.destroy(); } catch (err) { this.journal(`destroy retry failed: ${firstLine(err?.message)}`); }
      await this.removeByLabel();
      gone = await isGone();
    }
    this.phases.destroy += Date.now() - t;
    this.cleanedUp = true;
    this.containment = {
      runtime: this.rt, sandbox: this.box.name, limits: { ...LIMITS }, network: networkText(this.box.network), destroyed: gone,
      goneCheck: gone ? 'docker ps -a: gone' : 'docker ps -a: still listed', goneAt: gone ? new Date().toISOString() : null,
    };
    this.say(gone ? `container ${this.box.name} destroyed · docker ps -a: gone` : `container ${this.box.name} could not be confirmed gone (docker ps -a still lists it)`);
    this.step('cleanup', gone ? 'done' : 'fail', t);
    return gone;
  }

  async writeReceipt(vision) {
    const { task } = this;
    const end = snapshotTally(this.deps.tally);
    const mid = this.tallyBeforeVision ?? end;
    const delta = deltaOf(this.tally0, end); // everything this task used: the totals
    const date = new Date(this.t0).toISOString().slice(0, 10);
    const models = [modelRow('fix', task.model, deltaOf(this.tally0, mid), date)];
    if (task.visionModel && vision.verdict !== 'skipped') models.push(modelRow('vision', task.visionModel, deltaOf(mid, end), date));
    const s = task.source;
    const receipt = buildReceipt({
      taskId: task.id, startedAt: this.t0, finishedAt: Date.now(),
      source: s.kind === 'github' ? { kind: 'github', name: `${s.owner}/${s.name}`, commit: this.src?.commit ?? null } : { kind: 'sample', name: s.name, commit: null },
      matrix: task.matrix, r0Report: this.R0.report, rfReport: this.RF?.report ?? null, cellsExpected: this.expected.size,
      gate: { enabled: Boolean(task.gate), coverUpAttempts: this.coverUpAttempts, tamperAttempts: this.tamperAttempts, lostAttempts: this.lostAttempts, reverts: this.reverts },
      checks: this.checkRows, stopReason: this.stopReason,
      models, tokens: { prompt: delta.promptTokens, completion: delta.completionTokens, reasoning: delta.reasoningTokens }, usd: delta.usd,
      turns: this.turns, toolCalls: this.toolCalls, invalidToolCalls: this.invalidCalls, toolErrors: this.toolErrors,
      phasesMs: this.phases, patch: this.patch, patchApplies: this.patchOk, patchTruncated: this.patchTruncated,
      proof: this.proof, vision, summary: this.summary, containment: this.containment,
      inferenceUrl: INFERENCE_URL, promptVersion: PROMPT_VERSION,
    });
    this.receipt = receipt;
    await this.save('receipt.json', `${JSON.stringify(receipt, null, 2)}\n`);
    await this.save('receipt.md', receiptMarkdown(receipt));
    await this.save('patch.diff', this.storedPatch);
    this.say(`receipt: ${receipt.line} · verdict ${receipt.verdict} · ${receipt.usd === null ? 'cost n/a' : `$${receipt.usd.toFixed(4)} (list price)`}`);
    // §2.7.5: `receipt`, then `done` (emitted by run() once the transcript is stored).
    this.emit('receipt', {
      line: receipt.line, verdict: receipt.verdict, fixed: receipt.counts.fixed, new: receipt.counts.new, coverUps: receipt.counts.coverUps,
      lost: receipt.counts.lost, usd: receipt.usd, tokens: receipt.tokens.prompt + receipt.tokens.completion, tokenBreakdown: receipt.tokens,
      seconds: receipt.time.totalSec, patchBytes: receipt.diff.bytes,
    });
  }
}

/**
 * @typedef {{routes:string[], viewports:string[], schemes:string[], locales:string[]}} Matrix
 * @typedef {{maxChecks:number, maxTurns:number, maxTurnsPerCheck:number, maxCallsPerTurn:number, maxCompletionTokens:number,
 *            reasoning:{effort:string, max_tokens:number}|null, maxPromptTokens:number, maxUsd:number,
 *            wallClockSec:number, lookTimeoutSec:number}} Caps
 * @typedef {{ id:string,
 *   source: {kind:'sample', name:string, dir:string, label:string} | {kind:'github', owner:string, name:string, label:string},
 *   matrix: Matrix, model:string, sampling:{temperature?:number, topP?:number, seed?:number},
 *   visionModel: string|null, gate: boolean, caps: Partial<Caps> }} FixTask
 * @typedef {{ status:'done'|'failed'|'timeout'|'cancelled', receipt: object|null, error?: string }} FixResult
 */

/**
 * Run one fix task end to end (§2). Never throws: every outcome is a FixResult, the sandbox is
 * destroyed on every path, and the last event emitted is `done`.
 * @param {FixTask} task
 * @param {{ chat: Function, createSandbox: (o: {runtime?: string, labels: Record<string, string>}) => Promise<object>,
 *   emit: (type: string, data: object) => void, store: { put(name: string, data: Buffer|string): Promise<void>, append?: Function },
 *   guard: object, tally: object, signal?: AbortSignal, runtime?: string, heavy?: { run(fn: Function): Promise<unknown> },
 *   vision?: (input: object) => Promise<object>, onCheck?: (info: object) => Promise<void>, log?: (line: string) => void }} deps
 * @returns {Promise<FixResult>}
 */
export async function runFix(task, deps) {
  return new FixRun(task, deps).run();
}
