// Vultr Serverless Inference client (OpenAI-compatible chat completions with tool calling).
// Runs only in the orchestrator, outside every sandbox. The API key comes from the service's
// environment (systemd reads /etc/mantis-ring/secrets.env); it is read only inside chat() and ping(),
// never passed to a container or logged, and never put in an error message: errors carry at most 300
// characters of the provider's own text, with the key redacted, and never the request.
// Every call has a completion-token cap, a wall-clock timeout, a bounded retry policy and a budget
// check before each attempt. Usage and list-price cost go into a running tally. A price that is not
// known is never counted as $0: the tally's usd becomes null ("cost n/a"), and the spend guard decides
// whether such a call may run at all.
import { setTimeout as delay } from 'node:timers/promises';
import { PINNED_PRICES } from './prices.mjs';

/** Base URL of the API. The environment override is for tests only (a local fake gateway). */
export const INFERENCE_URL = (process.env.VULTR_INFERENCE_URL || 'https://api.vultrinference.com/v1').replace(/\/+$/, '');
export const PROVIDER = 'Vultr Serverless Inference';

// The key is sent only over TLS, or in plain HTTP to a test gateway on this machine, and never to a
// URL with credentials in it (fetch would quote that URL in its error).
const KEY_URL_OK = (() => {
  try {
    const u = new URL(INFERENCE_URL);
    if (u.username || u.password) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
})();
const BAD_URL_TEXT = 'the inference URL must use https (or http to 127.0.0.1 for a test gateway), without credentials';

const DEFAULT_REASONING = Object.freeze({ effort: 'low', max_tokens: 2048 });
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1500, 3000]; // before attempts 2 and 3, after a 502/503/504, a network error or a timeout
const PAUSE_AFTER_500_MS = 1500; // a 500 is retried once, after this pause
const RETRY_AFTER_DEFAULT_S = 5; // a 429 without a usable Retry-After header
const RETRY_AFTER_MAX_S = 65;
const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_RETRY_MS = 5 * 60_000; // after a failed catalogue fetch, try again at most this often
const PING_TIMEOUT_MS = 10_000;
const MAX_ERROR_TEXT = 300; // characters of the provider's own error text kept in a message
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * A failed inference call. `status`: the HTTP status (none for network errors and timeouts).
 * `retryable`: whether another attempt could have helped (chat() has already retried when it throws;
 * `attempts` says how often). `type`: the provider's metadata.error_type, or one of ours: 'timeout',
 * 'network', 'aborted', 'bad_response', 'model_mismatch' (with `served`), 'invalid_request', 'no_key',
 * 'bad_url'.
 */
export class InferenceError extends Error {
  constructor(message, { status, retryable = false, type, attempts, served } = {}) {
    super(message);
    this.name = 'InferenceError';
    this.status = status;
    this.retryable = retryable;
    this.type = type;
    if (attempts !== undefined) this.attempts = attempts;
    if (served !== undefined) this.served = served;
  }
}

const BUDGET_TEXT = {
  task: "this task's spend cap is reached",
  day: "today's spend cap is reached",
  total: 'the total spend cap is reached',
  tokens: 'the token budget is reached',
  price: 'the model has no known price, so its cost cannot be capped',
};

/**
 * A call refused by the spend guard before anything was sent. `scope` names the cap:
 * 'task' | 'day' | 'total' | 'tokens' | 'price'. Usage: `new BudgetError('day')` or with a message.
 */
export class BudgetError extends Error {
  constructor(scope, message) {
    super(message || BUDGET_TEXT[scope] || 'a spend cap is reached');
    this.name = 'BudgetError';
    this.scope = scope;
  }
}

// ---------------------------------------------------------------------------------------------
// Prices

let catalog = null; // model id -> { prompt, completion } in USD per token, from the live catalogue
let catalogLoading = null; // the fetch in flight, shared by concurrent callers
let catalogFailedAt = 0; // when the last fetch failed

/**
 * Per-token list prices from the public model catalogue (GET /models, which needs no key), fetched
 * once and cached for the life of the process. A model is listed only when both its prompt and its
 * completion token price are given: a missing price is unknown, never 0. On failure this resolves to
 * {} (or the earlier catalogue) and priceOf() falls back to the pinned prices; a failed fetch is tried
 * again at most every 5 minutes, or at once with `force`. Never throws.
 * @returns {Promise<Record<string, {prompt: number, completion: number}>>}
 */
export async function loadPricing({ force = false } = {}) {
  if (catalog && !force) return catalog;
  if (!force && catalogFailedAt && Date.now() - catalogFailedAt < CATALOG_RETRY_MS) return {};
  catalogLoading ??= fetchCatalog().finally(() => { catalogLoading = null; });
  return catalogLoading;
}

async function fetchCatalog() {
  try {
    const res = await fetch(`${INFERENCE_URL}/models`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`catalogue answered ${res.status}`);
    const { data } = await res.json();
    // The catalogue answers an empty list when it is unavailable: that is a failure, not "no prices".
    if (!Array.isArray(data) || data.length === 0) throw new Error('catalogue is empty');
    const prices = {};
    for (const m of data) {
      if (typeof m?.id !== 'string' || !MODEL_ID.test(m.id)) continue;
      const all = [...(m.input_modalities ?? []), ...(m.output_modalities ?? [])].flatMap((x) => x?.pricing ?? []);
      const price = (type) => perToken(all.find((p) => p?.type === type && p?.unit === 'token')?.cost_usd);
      const prompt = price('prompt');
      const completion = price('completion');
      if (prompt !== null && completion !== null) prices[m.id] = { prompt, completion };
    }
    catalog = prices;
    catalogFailedAt = 0;
    return catalog;
  } catch {
    // The catalogue only prices the receipt; the pinned prices cover the candidate models meanwhile.
    catalogFailedAt = Date.now();
    return catalog ?? {};
  }
}

/** A catalogue cost_usd ("0.00000015") as a number, or null when it is missing or not a price. */
function perToken(raw) {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const per1M = (usdPerToken) => Math.round(usdPerToken * 1e12) / 1e6; // 1.5e-7 -> 0.15, without float noise

/**
 * The list price of a model: from the live catalogue once loadPricing() has read it, otherwise from
 * the prices pinned on 4 Nov (prices.mjs); null when neither knows the model. `prompt`/`completion`
 * are USD per token (what the tally multiplies by); `promptPer1M`/`completionPer1M` are the same
 * prices per million tokens, for receipts.
 * @returns {{prompt: number, completion: number, promptPer1M: number, completionPer1M: number, source: 'catalog'|'pinned'} | null}
 */
export function priceOf(model) {
  if (typeof model !== 'string' || model === '') return null;
  const lower = model.toLowerCase();
  const fromCatalog = catalog && (Object.hasOwn(catalog, model) ? catalog[model] : Object.hasOwn(catalog, lower) ? catalog[lower] : null);
  if (fromCatalog) {
    const { prompt, completion } = fromCatalog;
    return { prompt, completion, promptPer1M: per1M(prompt), completionPer1M: per1M(completion), source: 'catalog' };
  }
  const pinned = Object.hasOwn(PINNED_PRICES, model) ? PINNED_PRICES[model] : Object.hasOwn(PINNED_PRICES, lower) ? PINNED_PRICES[lower] : null;
  if (pinned) {
    const { promptPer1M, completionPer1M } = pinned;
    return { prompt: promptPer1M / 1e6, completion: completionPer1M / 1e6, promptPer1M, completionPer1M, source: 'pinned' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Tally

/**
 * @typedef {{calls: number, promptTokens: number, completionTokens: number, reasoningTokens: number,
 *   usd: number|null, ms: number, price: {promptPer1M: number, completionPer1M: number, source: 'catalog'|'pinned'}|null}} TallyRow
 * @typedef {{calls: number, promptTokens: number, completionTokens: number, reasoningTokens: number,
 *   usd: number|null, ms: number, byModel: Record<string, TallyRow>}} Tally
 * @typedef {{ before(model: string, est: {promptTokens: number, maxCompletionTokens: number, usd: number|null}): void,
 *   after(model: string, usage: object, usd: number|null): void }} Guard   // before() throws BudgetError
 */

/**
 * A running total of billed calls, tokens, list-price cost and model time, shared by everything one
 * task does. byModel is keyed by the served model id. usd turns null for good once a call had no
 * known price. reasoningTokens are part of completionTokens (billed at the output price).
 * @returns {Tally}
 */
export function newTally() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, usd: 0, ms: 0, byModel: {} };
}

/** Add one tally into another, e.g. a probe's own tally into the caller's. Returns `into`. */
export function mergeTally(into, from) {
  if (!isTally(into) || !isTally(from)) throw new TypeError('mergeTally: both arguments must come from newTally()');
  addRow(into, from);
  for (const [model, row] of Object.entries(from.byModel)) {
    const dst = Object.hasOwn(into.byModel, model) ? into.byModel[model] : (into.byModel[model] = emptyRow(row.price ?? null));
    addRow(dst, row);
  }
  return into;
}

const isTally = (t) => !!t && typeof t === 'object' && typeof t.calls === 'number' && !!t.byModel && typeof t.byModel === 'object';
const emptyRow = (price) => ({ calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, usd: 0, ms: 0, price });
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

function addRow(t, a) {
  t.calls += a.calls;
  t.promptTokens += a.promptTokens;
  t.completionTokens += a.completionTokens;
  t.reasoningTokens += a.reasoningTokens;
  t.ms += a.ms;
  t.usd = t.usd === null || a.usd === null ? null : t.usd + a.usd;
}

function addToTally(tally, model, usage, usd, ms) {
  const key = MODEL_ID.test(model) ? model : 'unknown-model';
  const p = priceOf(key);
  const row = Object.hasOwn(tally.byModel, key)
    ? tally.byModel[key]
    : (tally.byModel[key] = emptyRow(p ? { promptPer1M: p.promptPer1M, completionPer1M: p.completionPer1M, source: p.source } : null));
  const add = {
    calls: 1, promptTokens: count(usage?.prompt_tokens), completionTokens: count(usage?.completion_tokens),
    reasoningTokens: count(usage?.completion_tokens_details?.reasoning_tokens), usd, ms,
  };
  addRow(tally, add);
  addRow(row, add);
}

// ---------------------------------------------------------------------------------------------
// Chat

/**
 * One chat completion, with retries:
 *  - 429: wait Retry-After seconds (5 when absent, at most 65), never past `signal`;
 *  - 500 (and other 5xx): once more, after 1.5 s;
 *  - 502/503/504, network errors, timeouts and unreadable answers: after 1.5 s, then 3 s;
 *  - anything else (400, 401, 403, 404, 413, …): no retry. At most 3 attempts.
 * `guard.before()` runs before every attempt (a BudgetError from it propagates, and nothing is sent);
 * `guard.after()` and the tally get every answer the provider billed, normally once per call.
 * The served model must be the requested one (case-insensitive), else a non-retryable InferenceError.
 * Assistant `reasoning` is dropped from the history before sending (stripForResend) unless
 * `keepReasoning` is set (only the probe's p3 does that). A `finish_reason` of 'length' is returned
 * as is. The caller's history must end with a user or tool message: a final assistant message would
 * be continued by the gateway instead of answered.
 * @param {{model: string, messages: object[], tools?: object[],
 *   toolChoice?: 'auto'|'required'|'none'|{type: 'function', function: {name: string}},
 *   maxTokens?: number, reasoning?: {effort?: string, max_tokens?: number}|null, temperature?: number,
 *   topP?: number, seed?: number, responseFormat?: object, timeoutMs?: number, signal?: AbortSignal,
 *   tally?: Tally, guard?: Guard, keepReasoning?: boolean}} o
 *   Defaults: maxTokens 8192 (max_completion_tokens, reasoning included), reasoning {effort:'low',
 *   max_tokens:2048} (null sends none), temperature 1.0, timeoutMs 300000 per attempt.
 * @returns {Promise<{message: {role: 'assistant', content: string, tool_calls?: object[], reasoning?: string},
 *   finishReason: string, usage: object, model: string, ms: number, attempts: number}>}  `model` is the served id
 * @throws {InferenceError|BudgetError}
 */
export async function chat(o = {}) {
  const {
    model, messages, tools, toolChoice, maxTokens = 8192, reasoning = DEFAULT_REASONING, temperature = 1.0,
    topP, seed, responseFormat, timeoutMs = 300_000, signal, tally, guard, keepReasoning = false,
  } = o ?? {};
  const problem = checkChatOptions({ model, messages, tools, toolChoice, maxTokens, reasoning, temperature, topP, seed, responseFormat, timeoutMs, signal, tally, guard });
  if (problem) throw new InferenceError(`invalid chat request: ${problem}`, { type: 'invalid_request' });
  if (signal?.aborted) throw abortedError(signal);
  const key = process.env.VULTR_INFERENCE_API_KEY;
  if (!key) throw new InferenceError('VULTR_INFERENCE_API_KEY is not set for the orchestrator', { type: 'no_key' });
  if (!KEY_URL_OK) throw new InferenceError(BAD_URL_TEXT, { type: 'bad_url' });

  await loadPricing();
  const sent = keepReasoning ? messages : stripForResend(messages);
  const body = { model, messages: sent, max_completion_tokens: maxTokens, temperature };
  if (reasoning) body.reasoning = reasoning;
  if (topP !== undefined) body.top_p = topP;
  if (seed !== undefined) body.seed = seed;
  if (responseFormat) body.response_format = responseFormat;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice ?? 'auto';
  }
  let payload, promptTokens;
  try {
    payload = JSON.stringify(body);
    promptTokens = Math.ceil(JSON.stringify({ messages: sent, tools: body.tools }).length / 3);
  } catch (err) {
    throw new InferenceError(`invalid chat request: the messages cannot be sent as JSON (${clip(String(err?.message), 100)})`, { type: 'invalid_request' });
  }
  // The estimate prices the whole prompt plus the full completion cap, so it is an upper bound.
  const price = priceOf(model);
  const est = { promptTokens, maxCompletionTokens: maxTokens, usd: price ? promptTokens * price.prompt + maxTokens * price.completion : null };

  const started = Date.now();
  let attempts = 0;
  let retried500 = false;
  for (;;) {
    guard?.before(model, est);
    attempts++;
    const step = await attempt({ payload, key, model, est, timeoutMs, signal, tally, guard });
    if (step.ok) return { ...step.value, ms: Date.now() - started, attempts };
    const err = step.error;
    let waitMs = null;
    if (err.retryable && attempts < MAX_ATTEMPTS) {
      if (err.status === 429) waitMs = step.retryAfterMs;
      else if ([502, 503, 504].includes(err.status) || ['network', 'timeout', 'bad_response'].includes(err.type)) waitMs = BACKOFF_MS[attempts - 1];
      else if (!retried500) {
        retried500 = true;
        waitMs = PAUSE_AFTER_500_MS;
      }
    }
    if (waitMs === null) {
      err.attempts = attempts;
      if (err.retryable) err.message += ` (gave up after ${attempts} attempt${attempts === 1 ? '' : 's'})`;
      throw err;
    }
    await pause(waitMs, signal);
  }
}

/**
 * A call that was sent but never answered (it timed out, or the caller stopped waiting) may still be
 * billed. The spend guard records the pre-call estimate (an upper bound), so calls that never answer
 * can never carry a task, the day or the total past its cap. The tally (the receipt's cost) is left
 * alone: it only counts answers.
 */
function chargeUnanswered(guard, model, est) {
  if (!guard || typeof est?.usd !== 'number') return;
  try {
    guard.after(model, { prompt_tokens: est.promptTokens, completion_tokens: est.maxCompletionTokens }, est.usd);
  } catch { /* after() records and never throws; a broken guard must not hide the real error */ }
}

/** One HTTP attempt. Resolves {ok:true, value} or {ok:false, error, retryAfterMs}; throws only when `signal` aborts. */
async function attempt({ payload, key, model, est, timeoutMs, signal, tally, guard }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(`${INFERENCE_URL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: payload,
      redirect: 'error', // the key goes to this host only
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted || timeout.aborted) chargeUnanswered(guard, model, est);
    if (signal?.aborted) throw abortedError(signal);
    if (timeout.aborted) return failed(new InferenceError(`${PROVIDER} did not answer within ${+(timeoutMs / 1000).toFixed(1)} s`, { retryable: true, type: 'timeout' }));
    return failed(new InferenceError(`could not reach ${PROVIDER}: ${networkReason(err)}`, { retryable: true, type: 'network' }));
  }

  if (!res.ok) {
    const { message, type } = errorBody(text);
    const error = new InferenceError(`${PROVIDER} answered ${res.status}${type ? ` (${type})` : ''}: ${message || 'no message'}`, {
      status: res.status, retryable: res.status === 429 || res.status >= 500, type,
    });
    return { ok: false, error, retryAfterMs: res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : 0 };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return failed(new InferenceError(`${PROVIDER} answered ${res.status} with a body that is not JSON`, { status: res.status, retryable: true, type: 'bad_response' }));
  }
  // The provider billed this answer, whatever comes next: record it before any check can fail.
  const served = typeof json?.model === 'string' ? json.model : null;
  let usage = json?.usage && typeof json.usage === 'object' ? json.usage : null;
  const billed = served ?? model;
  const p = priceOf(billed);
  const counted = Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens);
  let usd = p && counted ? usage.prompt_tokens * p.prompt + usage.completion_tokens * p.completion : null;
  // A priced model that answers without usage is charged the pre-call estimate (an upper bound):
  // the caps must fail closed, never count such a call as free.
  if (p && !counted && typeof est?.usd === 'number') {
    usage = { ...(usage ?? {}), prompt_tokens: est.promptTokens, completion_tokens: est.maxCompletionTokens, estimated: true };
    usd = est.usd;
  }
  if (tally) addToTally(tally, billed, usage, usd, Date.now() - t0);
  guard?.after(billed, usage ?? {}, usd);

  if (!served || served.toLowerCase() !== model.toLowerCase()) {
    return failed(new InferenceError(`model ${clip(model, 80)} not served (got ${served ? clip(providerText(served), 80) : 'no model id'})`, {
      status: res.status, type: 'model_mismatch', served,
    }));
  }
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  const msg = choice?.message;
  if (!msg || typeof msg !== 'object') {
    return failed(new InferenceError(`${PROVIDER} answered without a message`, { status: res.status, retryable: true, type: 'bad_response' }));
  }
  if (choice.finish_reason === 'error') {
    return failed(new InferenceError(`${PROVIDER} answered with finish_reason "error"`, { status: res.status, retryable: true, type: 'bad_response' }));
  }
  const message = { role: 'assistant', content: contentText(msg.content) };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) message.tool_calls = msg.tool_calls;
  const thought = msg.reasoning ?? msg.reasoning_content;
  if (typeof thought === 'string' && thought) message.reasoning = thought;
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';
  return { ok: true, value: { message, finishReason, usage: usage ?? {}, model: served } };
}

const failed = (error) => ({ ok: false, error, retryAfterMs: 0 });

const TOOL_CHOICES = ['auto', 'required', 'none'];

/** Caller mistakes, caught before anything is sent (never worth a retry). Returns a problem or null. */
function checkChatOptions(o) {
  if (typeof o.model !== 'string' || !o.model.trim()) return 'model is required';
  if (!Array.isArray(o.messages) || o.messages.length === 0) return 'messages must be a non-empty array';
  if (!Number.isInteger(o.maxTokens) || o.maxTokens < 1) return 'maxTokens must be a positive integer';
  if (o.reasoning !== null) {
    if (typeof o.reasoning !== 'object' || Array.isArray(o.reasoning)) return 'reasoning must be an object or null';
    const budget = o.reasoning.max_tokens;
    if (budget !== undefined && !(Number.isInteger(budget) && budget >= 1 && budget < o.maxTokens)) {
      return `reasoning.max_tokens must be a positive integer below maxTokens (${o.maxTokens})`;
    }
  }
  if (o.tools !== undefined && o.tools !== null && !Array.isArray(o.tools)) return 'tools must be an array';
  if (o.toolChoice !== undefined) {
    const named = typeof o.toolChoice === 'object' && o.toolChoice?.type === 'function' && typeof o.toolChoice.function?.name === 'string';
    if (!TOOL_CHOICES.includes(o.toolChoice) && !named) return "toolChoice must be 'auto', 'required', 'none' or {type: 'function', function: {name}}";
    if (o.toolChoice !== 'none' && !o.tools?.length) return 'toolChoice needs tools';
  }
  if (typeof o.temperature !== 'number' || !Number.isFinite(o.temperature)) return 'temperature must be a number';
  if (o.topP !== undefined && (typeof o.topP !== 'number' || !Number.isFinite(o.topP))) return 'topP must be a number';
  if (o.seed !== undefined && !Number.isInteger(o.seed)) return 'seed must be an integer';
  if (o.responseFormat !== undefined && o.responseFormat !== null && typeof o.responseFormat !== 'object') return 'responseFormat must be an object';
  if (!(typeof o.timeoutMs === 'number' && o.timeoutMs > 0 && Number.isFinite(o.timeoutMs))) return 'timeoutMs must be a positive number';
  if (o.signal !== undefined && o.signal !== null && !(o.signal instanceof AbortSignal)) return 'signal must be an AbortSignal';
  if (o.tally !== undefined && o.tally !== null && !isTally(o.tally)) return 'tally must come from newTally()';
  if (o.guard !== undefined && o.guard !== null && (typeof o.guard.before !== 'function' || typeof o.guard.after !== 'function')) {
    return 'guard must have before() and after()';
  }
  return null;
}

/** The provider's error text and metadata.error_type from an error body (OpenRouter's envelope, or anything else). */
function errorBody(text) {
  let message = '';
  let type;
  try {
    const j = JSON.parse(text);
    const e = j && typeof j === 'object' ? (j.error ?? j) : j;
    if (typeof e === 'string') message = e;
    else if (e && typeof e === 'object') {
      if (typeof e.message === 'string') message = e.message;
      if (typeof e.metadata?.error_type === 'string') type = clip(e.metadata.error_type, 60);
    }
  } catch {
    message = String(text ?? '').replace(/<[^>]*>/g, ' '); // e.g. a proxy's HTML error page
  }
  return { message: providerText(message), type };
}

/** Provider text made safe for an error message: the key and any bearer token redacted, one line, at most 300 characters. */
function providerText(s) {
  return clip(redact(String(s ?? '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(), MAX_ERROR_TEXT);
}

function redact(s) {
  const key = process.env.VULTR_INFERENCE_API_KEY;
  let out = String(s);
  if (key && key.length >= 8) out = out.split(key).join('[redacted]');
  return out.replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]');
}

function clip(s, n) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function networkReason(err) {
  const c = err?.cause;
  return clip(redact(String(c?.code || c?.message || err?.message || 'unknown error')), 120);
}

function abortedError(signal) {
  const r = signal?.reason;
  const why = typeof r === 'string' ? r : r?.name === 'TimeoutError' ? 'timeout' : r?.message;
  return new InferenceError(`the inference call was stopped${why ? ` (${clip(String(why), 60)})` : ''}`, { type: 'aborted' });
}

/** Wait, but give up as soon as `signal` aborts. */
async function pause(ms, signal) {
  try {
    await delay(ms, undefined, signal ? { signal } : {});
  } catch (err) {
    if (signal?.aborted) throw abortedError(signal);
    throw err;
  }
}

/** Retry-After as milliseconds: seconds or an HTTP date, 5 s when absent, between 1 s and 65 s. */
function retryAfterMs(value) {
  let s = NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    s = Number(value);
    if (!Number.isFinite(s)) {
      const at = Date.parse(value);
      if (Number.isFinite(at)) s = (at - Date.now()) / 1000;
    }
  }
  if (!Number.isFinite(s)) s = RETRY_AFTER_DEFAULT_S;
  return Math.round(Math.min(Math.max(s, 1), RETRY_AFTER_MAX_S) * 1000);
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

/**
 * A copy of the history without the assistant messages' reasoning (`reasoning`, and the
 * `reasoning_content`/`reasoning_details` spellings other gateways use). Whether this gateway accepts
 * echoed reasoning is undocumented (the probe's p3 checks), so it is never sent back by default.
 * Other messages are kept as they are; the input is not changed.
 * @param {object[]} messages
 * @returns {object[]}
 */
export function stripForResend(messages) {
  if (!Array.isArray(messages)) throw new TypeError('stripForResend: messages must be an array');
  return messages.map((m) => {
    if (!m || typeof m !== 'object' || m.role !== 'assistant') return m;
    if (!('reasoning' in m) && !('reasoning_content' in m) && !('reasoning_details' in m)) return m;
    const { reasoning, reasoning_content, reasoning_details, ...rest } = m;
    return rest;
  });
}

// ---------------------------------------------------------------------------------------------
// Health

/**
 * Reachability and key check for /status: GET /health with the key. A wrong or missing key gives 401,
 * so this detects a bad key, and it spends no tokens. Never throws; the error text never holds the key.
 * @returns {Promise<{ok: boolean, status?: number, ms?: number, error?: string}>}
 */
export async function ping() {
  const key = process.env.VULTR_INFERENCE_API_KEY;
  if (!key) return { ok: false, error: 'no API key is set for the orchestrator' };
  if (!KEY_URL_OK) return { ok: false, error: BAD_URL_TEXT };
  const started = Date.now();
  try {
    const res = await fetch(`${INFERENCE_URL}/health`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (res.ok) return { ok: true, status: res.status, ms };
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, ms, error: 'the API key was refused' };
    const { message } = errorBody(text);
    return { ok: false, status: res.status, ms, error: clip(message || `${PROVIDER} answered ${res.status}`, 120) };
  } catch (err) {
    const ms = Date.now() - started;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, ms, error: timedOut ? `no answer within ${PING_TIMEOUT_MS / 1000} s` : `could not reach ${PROVIDER}: ${networkReason(err)}` };
  }
}
