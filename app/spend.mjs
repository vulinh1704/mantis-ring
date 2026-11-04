// The spend ledger and the budget guard. Every model call the provider billed is one line in
// <STATE_DIR>/spend.jsonl: {ts, day (UTC), taskId, origin, model, promptTokens, completionTokens,
// reasoningTokens, usd|null}. The file is append-only, so spend survives restarts; the totals are
// recomputed from it at startup. Costs are list prices (Vultr catalogue), which billing may not match.
// guardFor(task) gives chat() a guard that checks, before every attempt and using chat()'s upper-bound
// estimate, the task's own caps, then today's cap for the task's origin, then the total cap. It fails
// closed: a call to a model without a known price is refused (BudgetError 'price'), except that public
// tasks fall back to a daily token budget; a ledger that cannot be read or written stops all spending.
// A speech call (POST /admin/speech, the video's voice) is an admin line with kind 'speech', the
// seconds of audio billed and the characters spoken; speechGuard() adds its own per-call and daily caps.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BudgetError } from '../agent/inference.mjs';

/** Caps in USD (list price) and tokens. Spend({caps}) and setCaps() take any subset of these keys. */
export const DEFAULT_SPEND_CAPS = Object.freeze({
  publicDayUsd: 5, // all public tasks, per UTC day
  adminDayUsd: 15, // all admin tasks (bake-off, measurement runs, probes), per UTC day
  totalUsd: 60, // everything in the ledger (until 13 Nov): hard stop
  taskUsd: 0.6, // per task when the task sets no maxUsd; also the most a public task may have
  adminTaskUsdMax: 2, // the most an admin task may set as caps.maxUsd
  taskPromptTokens: 1_200_000, // prompt tokens per task by default; also the public maximum
  adminTaskPromptTokensMax: 3_000_000, // the most an admin task may set as caps.maxPromptTokens
  publicUnpricedDayTokens: 3_000_000, // public calls to a model with no known price, per UTC day; 0 refuses them
});

const ORIGINS = ['public', 'admin'];
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const round = (usd) => Math.round(usd * 1e10) / 1e10; // ledger precision
const money = (usd) => Math.round(usd * 1e6) / 1e6; // what totals report
const dollars = (usd) => `$${money(Math.max(0, usd))}`;
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const emptyTotals = () => ({ calls: 0, usd: 0, unpricedCalls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, unpricedTokens: 0 });

function checkOrigin(origin, who) {
  if (!ORIGINS.includes(origin)) throw new TypeError(`${who}: origin must be 'public' or 'admin'`);
}

/** Defaults overlaid with `caps`; unknown keys and values that are not numbers ≥ 0 throw. */
function mergeCaps(caps) {
  const given = caps ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) throw new TypeError('spend caps must be an object');
  for (const [k, v] of Object.entries(given)) {
    if (!Object.hasOwn(DEFAULT_SPEND_CAPS, k)) throw new TypeError(`unknown spend cap: ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError(`spend cap ${k} must be a number of at least 0`);
  }
  return Object.freeze({ ...DEFAULT_SPEND_CAPS, ...given });
}

/** A task's own limits: its caps.maxUsd / caps.maxPromptTokens (defaults when unset), never above its origin's maximum. */
function taskLimits(task, caps) {
  const admin = task.origin === 'admin';
  const want = task.caps ?? {};
  const maxUsd = want.maxUsd ?? caps.taskUsd;
  const maxPromptTokens = want.maxPromptTokens ?? caps.taskPromptTokens;
  if (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd < 0) throw new TypeError('task.caps.maxUsd must be a number of at least 0');
  if (typeof maxPromptTokens !== 'number' || !Number.isFinite(maxPromptTokens) || maxPromptTokens < 0) {
    throw new TypeError('task.caps.maxPromptTokens must be a number of at least 0');
  }
  return {
    maxUsd: Math.min(maxUsd, admin ? caps.adminTaskUsdMax : caps.taskUsd),
    maxPromptTokens: Math.min(maxPromptTokens, admin ? caps.adminTaskPromptTokensMax : caps.taskPromptTokens),
  };
}

function validEntry(e) {
  return !!e && typeof e === 'object' && typeof e.day === 'string' && DAY.test(e.day) && ORIGINS.includes(e.origin)
    && typeof e.model === 'string' && (e.usd === null || (typeof e.usd === 'number' && Number.isFinite(e.usd) && e.usd >= 0))
    && [e.promptTokens, e.completionTokens, e.reasoningTokens].every((n) => n === undefined || (Number.isFinite(n) && n >= 0));
}

function validEstimate(est) {
  return !!est && typeof est === 'object'
    && Number.isFinite(est.promptTokens) && est.promptTokens >= 0
    && Number.isFinite(est.maxCompletionTokens) && est.maxCompletionTokens >= 0
    && (est.usd === null || (typeof est.usd === 'number' && Number.isFinite(est.usd) && est.usd >= 0));
}

export class Spend {
  /**
   * Opens (or creates) <dir>/spend.jsonl and recomputes the totals from it. A ledger that cannot be
   * read does not stop the app: it stops spending (every check refuses) and says why through `log`.
   * @param {{dir: string, caps?: Partial<typeof DEFAULT_SPEND_CAPS>, log?: (line: string) => void, now?: () => number}} o
   */
  constructor({ dir, caps, log = () => {}, now = Date.now } = {}) {
    if (typeof dir !== 'string' || dir === '') throw new TypeError('Spend: dir is required');
    if (typeof log !== 'function' || typeof now !== 'function') throw new TypeError('Spend: log and now must be functions');
    this.file = path.join(dir, 'spend.jsonl');
    this.log = log;
    this.now = now;
    this.limits = mergeCaps(caps);
    this.ledgerError = null; // set when the ledger cannot be read or written: all spending stops
    this.days = new Map(); // day -> { public: totals, admin: totals }
    this.rows = new Map(); // "day origin model" -> totals by day × origin × model
    this.speechDays = new Map(); // day -> { calls, usd, seconds } of the speech calls (kind 'speech')
    this.allUsd = 0;
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.stop(`the state folder cannot be created (${err.code ?? 'error'})`);
      return;
    }
    this.load();
  }

  /** The caps in force (defaults overlaid with the configured ones). */
  get caps() {
    return this.limits;
  }

  /** Replace the configured caps, e.g. after POST /admin/config. Throws TypeError on unknown keys or bad values. */
  setCaps(caps) {
    this.limits = mergeCaps(caps);
    return this.limits;
  }

  /**
   * Today's spend (UTC day). publicUsd/adminUsd/totalUsd are list-price USD of the calls with a known
   * price (unpricedCalls counts the others); totalUsd is today's public + admin. tokens = prompt +
   * completion tokens today, both origins. The all-time total is total().
   * @returns {{day: string, publicUsd: number, adminUsd: number, totalUsd: number, tokens: number,
   *   publicTokens: number, adminTokens: number, unpricedCalls: number}}
   */
  today() {
    const day = utcDay(this.now());
    const pub = this.dayTotals('public', day);
    const adm = this.dayTotals('admin', day);
    const tokens = (t) => t.promptTokens + t.completionTokens;
    return {
      day, publicUsd: money(pub.usd), adminUsd: money(adm.usd), totalUsd: money(pub.usd + adm.usd),
      tokens: tokens(pub) + tokens(adm), publicTokens: tokens(pub), adminTokens: tokens(adm), unpricedCalls: pub.unpricedCalls + adm.unpricedCalls,
    };
  }

  /** All-time list-price USD in the ledger, both origins (compare with caps.totalUsd). */
  total() {
    return money(this.allUsd);
  }

  /**
   * Today's speech calls (UTC day): how many, their USD (the list price, or the provider's own cost
   * when that is higher) and the seconds of audio billed. They also count in today() and total(), as
   * admin spend.
   * @returns {{day: string, calls: number, usd: number, seconds: number}}
   */
  speechToday() {
    const day = utcDay(this.now());
    const s = this.speechDays.get(day) ?? { calls: 0, usd: 0, seconds: 0 };
    return { day, calls: s.calls, usd: money(s.usd), seconds: Math.round(s.seconds * 1000) / 1000 };
  }

  /**
   * May a task of this origin start now? Refused when today's spend for the origin plus one task's cap
   * would pass the origin's daily cap, or the total plus that would pass the total cap.
   * @param {'public'|'admin'} origin
   * @param {{maxUsd?: number}} [o]  the task's own cap; default: the most a task of this origin may spend
   * @returns {{ok: boolean, scope?: 'day'|'total', reason?: string}}  reason is one plain sentence for logs, not for the public
   */
  canStart(origin, { maxUsd } = {}) {
    checkOrigin(origin, 'canStart');
    if (maxUsd !== undefined && (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd < 0)) {
      throw new TypeError('canStart: maxUsd must be a number of at least 0');
    }
    if (this.ledgerError) return { ok: false, scope: 'total', reason: `Spending is stopped: ${this.ledgerError}.` };
    const caps = this.limits;
    const most = origin === 'public' ? caps.taskUsd : caps.adminTaskUsdMax;
    const perTask = Math.min(maxUsd ?? most, most);
    const dayCap = origin === 'public' ? caps.publicDayUsd : caps.adminDayUsd;
    const spentToday = this.dayTotals(origin).usd;
    if (spentToday + perTask > dayCap) {
      return { ok: false, scope: 'day', reason: `Today's ${origin} budget has ${dollars(dayCap - spentToday)} left, less than one task's cap of ${dollars(perTask)}.` };
    }
    if (this.allUsd + perTask > caps.totalUsd) {
      return { ok: false, scope: 'total', reason: `The total budget has ${dollars(caps.totalUsd - this.allUsd)} left, less than one task's cap of ${dollars(perTask)}.` };
    }
    return { ok: true };
  }

  /**
   * The guard chat() calls for one task (or one probe run). before() throws BudgetError when the next
   * attempt could pass a cap, checking in order: the ledger works; the task's prompt tokens; a known
   * price (else 'price', or the public token fallback); the task's USD; today's USD for the origin;
   * the total USD. after() records a billed call in the ledger and never throws.
   * @param {{id: string, origin: 'public'|'admin', caps?: {maxUsd?: number, maxPromptTokens?: number}}} task
   * @returns {import('../agent/inference.mjs').Guard & {spent(): {calls: number, usd: number, unpricedCalls: number,
   *   promptTokens: number, completionTokens: number, reasoningTokens: number}}}
   */
  guardFor(task) {
    if (!task || typeof task !== 'object') throw new TypeError('guardFor: task is required');
    const { id, origin } = task;
    if (typeof id !== 'string' || !TASK_ID.test(id)) throw new TypeError('guardFor: task.id must be a short id (letters, digits, _ . : -)');
    checkOrigin(origin, 'guardFor');
    taskLimits(task, this.limits); // a task with impossible caps fails here, before it starts
    const spend = this;
    const spent = { calls: 0, usd: 0, unpricedCalls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
    return {
      before(model, est) {
        if (spend.ledgerError) throw new BudgetError('total', `spending is stopped: ${spend.ledgerError}`);
        if (!validEstimate(est)) throw new BudgetError('price', 'the call came without a valid cost estimate');
        const caps = spend.limits;
        const { maxUsd, maxPromptTokens } = taskLimits(task, caps);
        if (spent.promptTokens + est.promptTokens > maxPromptTokens) {
          throw new BudgetError('tokens', `this task has used ${spent.promptTokens} of its ${maxPromptTokens} prompt tokens, and the next call could pass that`);
        }
        if (est.usd === null) {
          if (origin === 'public' && caps.publicUnpricedDayTokens > 0) {
            const used = spend.dayTotals('public').unpricedTokens;
            if (used + est.promptTokens + est.maxCompletionTokens > caps.publicUnpricedDayTokens) {
              throw new BudgetError('tokens', `today's ${caps.publicUnpricedDayTokens}-token budget for models without a known price is used up`);
            }
            return;
          }
          throw new BudgetError('price', `${String(model).slice(0, 80)} has no known price, so its cost cannot be capped`);
        }
        if (spent.usd + est.usd > maxUsd) {
          throw new BudgetError('task', `this task has spent ${dollars(spent.usd)} of its ${dollars(maxUsd)} cap, and the next call could pass it`);
        }
        const dayCap = origin === 'public' ? caps.publicDayUsd : caps.adminDayUsd;
        if (spend.dayTotals(origin).usd + est.usd > dayCap) throw new BudgetError('day', `today's ${origin} budget of ${dollars(dayCap)} is used up`);
        if (spend.allUsd + est.usd > caps.totalUsd) throw new BudgetError('total', `the total budget of ${dollars(caps.totalUsd)} is used up`);
      },
      after(model, usage, usd, speech) {
        const ms = spend.now();
        const e = {
          ts: new Date(ms).toISOString(), day: utcDay(ms), taskId: id, origin,
          model: typeof model === 'string' && model ? model.slice(0, 100) : 'unknown',
          promptTokens: count(usage?.prompt_tokens), completionTokens: count(usage?.completion_tokens),
          reasoningTokens: count(usage?.completion_tokens_details?.reasoning_tokens),
          usd: typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? round(usd) : null,
        };
        // speech() passes the seconds billed and the characters spoken; `estimated` marks a charge of
        // the pre-call estimate (a call that was never answered, or answered without its usage).
        if (speech && typeof speech === 'object') {
          e.kind = 'speech';
          e.audioSeconds = typeof speech.seconds === 'number' && Number.isFinite(speech.seconds) && speech.seconds >= 0 ? speech.seconds : null;
          e.chars = count(speech.chars);
          if (speech.estimated === true) e.estimated = true;
        }
        spent.calls++;
        spent.promptTokens += e.promptTokens;
        spent.completionTokens += e.completionTokens;
        spent.reasoningTokens += e.reasoningTokens;
        if (e.usd === null) spent.unpricedCalls++;
        else spent.usd += e.usd;
        spend.add(e);
        spend.append(e);
      },
      spent: () => ({ ...spent, usd: money(spent.usd) }),
    };
  }

  /**
   * The guard for one speech call (POST /admin/speech): guardFor()'s checks for an admin call whose own
   * cap is `callUsd` (today's admin budget and the total cap included), then today's speech budget
   * `dayUsd`, all against speech()'s pre-call estimate. after() records the call as kind 'speech'.
   * @param {{id: string, callUsd: number, dayUsd: number}} o
   * @returns {import('../agent/inference.mjs').Guard & {spent(): object}}
   */
  speechGuard({ id, callUsd, dayUsd } = {}) {
    for (const [name, v] of [['callUsd', callUsd], ['dayUsd', dayUsd]]) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new TypeError(`speechGuard: ${name} must be a number above 0`);
    }
    const base = this.guardFor({ id, origin: 'admin', caps: { maxUsd: callUsd, maxPromptTokens: 0 } });
    const spend = this;
    return {
      before(model, est) {
        if (typeof est?.usd === 'number' && est.usd > callUsd) {
          throw new BudgetError('task', `this call could cost up to ${dollars(est.usd)}, more than the ${dollars(callUsd)} one speech call may cost`);
        }
        base.before(model, est); // a model without a price (usd null) is refused here
        const used = spend.speechDays.get(utcDay(spend.now()))?.usd ?? 0;
        if (used + est.usd > dayUsd) {
          throw new BudgetError('day', `today's speech budget of ${dollars(dayUsd)} has ${dollars(dayUsd - used)} left, less than this call could cost (${dollars(est.usd)})`);
        }
      },
      after: (model, usage, usd, speech) => base.after(model, usage, usd, { ...(speech && typeof speech === 'object' ? speech : {}) }),
      spent: () => base.spent(),
    };
  }

  /**
   * Totals by UTC day × origin × model (GET /admin/spend), oldest first. usd sums the calls with a
   * known price; unpricedCalls and unpricedTokens count the others. A speech model's row also has
   * audioSeconds, the seconds of audio billed.
   * @returns {{day: string, origin: string, model: string, calls: number, promptTokens: number, completionTokens: number,
   *   reasoningTokens: number, usd: number, unpricedCalls: number, unpricedTokens: number, audioSeconds?: number}[]}
   */
  breakdown() {
    return [...this.rows.values()]
      .map((r) => ({ ...r, usd: money(r.usd) }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.origin.localeCompare(b.origin) || a.model.localeCompare(b.model));
  }

  /** Today's (or `day`'s) running totals for one origin. Internal, but harmless to read. */
  dayTotals(origin, day = utcDay(this.now())) {
    return this.days.get(day)?.[origin] ?? emptyTotals();
  }

  load() {
    let text = '';
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.stop(`the spend ledger cannot be read (${err.code ?? 'error'})`);
      return;
    }
    let bad = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        bad++;
        continue;
      }
      if (validEntry(e)) this.add(e);
      else bad++;
    }
    if (bad) this.log(`spend: skipped ${bad} unreadable line(s) in ${path.basename(this.file)}`);
    // A crash in the middle of a write leaves a line without its newline; end it, so the next entry
    // starts on a line of its own instead of being glued to the broken one.
    if (text.length && !text.endsWith('\n')) this.write('\n');
  }

  add(e) {
    const day = this.days.get(e.day) ?? { public: emptyTotals(), admin: emptyTotals() };
    this.days.set(e.day, day);
    const key = `${e.day} ${e.origin} ${e.model}`;
    const row = this.rows.get(key) ?? { day: e.day, origin: e.origin, model: e.model, ...emptyTotals() };
    this.rows.set(key, row);
    for (const t of [day[e.origin], row]) {
      t.calls++;
      t.promptTokens += count(e.promptTokens);
      t.completionTokens += count(e.completionTokens);
      t.reasoningTokens += count(e.reasoningTokens);
      if (e.usd === null) {
        t.unpricedCalls++;
        t.unpricedTokens += count(e.promptTokens) + count(e.completionTokens);
      } else t.usd += e.usd;
    }
    if (e.usd !== null) this.allUsd += e.usd;
    if (e.kind === 'speech') {
      const seconds = typeof e.audioSeconds === 'number' && Number.isFinite(e.audioSeconds) && e.audioSeconds > 0 ? e.audioSeconds : 0;
      const s = this.speechDays.get(e.day) ?? { calls: 0, usd: 0, seconds: 0 };
      s.calls++;
      if (e.usd !== null) s.usd += e.usd;
      s.seconds += seconds;
      this.speechDays.set(e.day, s);
      row.audioSeconds = (row.audioSeconds ?? 0) + seconds;
    }
  }

  append(e) {
    this.write(`${JSON.stringify(e)}\n`);
  }

  write(text) {
    try {
      appendFileSync(this.file, text, { mode: 0o640 });
    } catch (err) {
      this.stop(`the spend ledger cannot be written (${err.code ?? 'error'})`);
    }
  }

  stop(why) {
    if (!this.ledgerError) this.log(`spend: ${why}; every further model call is refused until the app restarts`);
    this.ledgerError ??= why;
  }
}
