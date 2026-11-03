// Tool-calling and vision probes for the candidate models (build spec §6.3). The app runs them through
// the local-admin POST /admin/probe, once per model before the bake-off. Every step is one small real
// call through chat(), so it passes the same spend guard and lands in the same tally as a task.
// A model that fails p1 or p2 is dropped from the bake-off; p3-p5 and v1 are recorded for decisions
// (sending reasoning back, forced tool_choice, vision). A result holds statuses, the served model id,
// finish reasons, tokens, list-price cost and short notes: never a request, a header or the key.
import { BudgetError, chat, InferenceError, mergeTally, newTally } from './inference.mjs';
import { TOOL_SCHEMAS } from './tools.mjs';

const MAX_TOKENS = 1024; // max_completion_tokens of every probe call (§6.3)
const REASONING = Object.freeze({ effort: 'low', max_tokens: 512 }); // the thinking budget must stay below MAX_TOKENS
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const MAX_MODELS = 12;

const SYSTEM = 'You are testing a tool interface.';
const USER = 'The project has one file, index.html. Read it with read_file, then call finish with one sentence about it.';
const READ_RESULT = '    1  <h1>Hello</h1>\n(1 lines)';
const STAND_IN_REASONING = 'The user wants me to read index.html with read_file first, then call finish.';
const FORCE_FINISH = Object.freeze({ type: 'function', function: Object.freeze({ name: 'finish' }) });

// v1 uses the Appendix B prompt and schema (agent/vision.mjs holds the production copy) on two drawn
// crops: BEFORE has a dark 300×40 bar at y=120, AFTER has nothing, and the diff hides the element.
// The right answer is cover_up.
const VISION_SYSTEM = 'You review a UI fix. You get two crops of the same area of a web page, BEFORE and AFTER a code change, the issue a measuring tool reported before the change, and the code diff. Decide whether that issue was really fixed. Coloured outlines and numbers on the images were drawn by the measuring tool; ignore them. Answer only with JSON that matches the schema.';
const VISION_ISSUE = 'Issue: clipped-text on #promo-banner. Page /, mobile 390×844, light theme, language en. Reported before the change: the text of #promo-banner is cut off at its right edge.';
const VISION_LABELS = 'fixed = the content is still visible, readable and usable, and the problem is gone. cover_up = the problem is gone because the content was hidden, removed, clipped, shrunk until hard to read, or covered. regressed = the area got worse in another way. unclear = the images do not show enough.';
const VISION_DIFF = '--- a/styles.css\n+++ b/styles.css\n@@ -88 +88,2 @@\n .promo p { margin: 0; }\n+#promo-banner { display: none; }\n';
const VISION_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'ui_fix_verdict',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['fixed', 'cover_up', 'regressed', 'unclear'] },
        target_visible_after: { type: 'boolean' },
        evidence: { type: 'string' },
        new_problems: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'target_visible_after', 'evidence', 'new_problems'],
      additionalProperties: false,
    },
  },
};

/**
 * @typedef {{name: string, ok: boolean, status?: number, ms: number, finishReason?: string, note: string,
 *   tokens?: {prompt: number, completion: number, reasoning: number}}} ProbeStep
 * @typedef {{model: string, kind: 'tools'|'vision', ok: boolean, skipped?: boolean, note?: string, steps: ProbeStep[],
 *   served: string|null, tokens: {prompt: number, completion: number, reasoning: number}, usd: number|null}} ProbeResult
 */

/**
 * The tool-calling probe of one model, with the real TOOL_SCHEMAS:
 *  p1  a fresh request: the first call must be read_file {path: "index.html"} with an id starting
 *      "call_", finish_reason tool_calls, and the served model must be the requested one;
 *  p2  p1's history plus the read_file result (reasoning stripped): must call finish with a summary;
 *  p3  p2 with the assistant's reasoning kept: records whether the gateway accepts it back (200 or 400);
 *  p4  p2 with tool_choice forcing finish (the loop's last turn): records whether it is accepted;
 *  p5  p1 with tool_choice forcing finish: honoured only when the model calls finish, not read_file.
 * ok = p1 and p2 passed. When p1 gets no answer, or the guard refuses, or `signal` aborts, the
 * remaining steps are recorded as not run. Never throws for a model's behaviour or an API error.
 * @param {string} model
 * @param {{tally?: import('./inference.mjs').Tally, guard?: import('./inference.mjs').Guard, signal?: AbortSignal}} [opts]
 *   tally gets this probe's calls added at the end; guard is the spend guard (the admin budget)
 * @returns {Promise<ProbeResult>}
 */
export async function probeModel(model, opts = {}) {
  const { tally, guard, signal } = opts ?? {};
  checkTally(tally);
  const run = newRun(model, 'tools');
  if (typeof model !== 'string' || !MODEL_ID.test(model)) {
    run.stop = 'invalid model id';
    for (const name of ['p1', 'p2', 'p3', 'p4', 'p5']) await runStep(run, name);
    return run.result;
  }
  const local = newTally();
  const call = (o) => chat({ model, tools: TOOL_SCHEMAS, maxTokens: MAX_TOKENS, reasoning: REASONING, signal, guard, tally: local, ...o });
  try {
    const p1Messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }];
    const p1 = await runStep(run, 'p1', () => call({ messages: p1Messages }), judgeFirstRead);
    if (!p1) run.stop ??= 'p1 got no answer';

    // The rest builds on p1's read_file call; when p1 had none, a stand-in call keeps the history valid.
    const readCall = p1?.message.tool_calls?.find((c) => c?.function?.name === 'read_file' && typeof c.id === 'string' && c.id);
    const call1 = readCall ?? { id: 'call_probe_read_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"index.html"}' } };
    const standIn = readCall ? '' : ' (p1 made no read_file call, so a stand-in call was sent back)';
    const assistant = { role: 'assistant', content: p1?.message.content ?? '', tool_calls: [call1] };
    const toolResult = { role: 'tool', tool_call_id: call1.id, content: READ_RESULT };
    const p2Messages = [...p1Messages, assistant, toolResult];

    await runStep(run, 'p2', () => call({ messages: p2Messages }), (res) => judgeFinish(res, standIn));

    const ownReasoning = p1?.message.reasoning;
    const p3Messages = [...p1Messages, { ...assistant, reasoning: ownReasoning || STAND_IN_REASONING }, toolResult];
    await runStep(run, 'p3', () => call({ messages: p3Messages, keepReasoning: true }), (res) => ({
      ok: true,
      note: `accepted the assistant's reasoning sent back${ownReasoning ? '' : ' (a stand-in text: p1 returned none)'}; ${firstCall(res)}`,
    }));

    await runStep(run, 'p4', () => call({ messages: p2Messages, toolChoice: FORCE_FINISH }), (res) => {
      const forced = isFinish(res.message.tool_calls?.[0]);
      return { ok: forced, note: forced ? 'accepted; the first call is finish (here the model may choose it anyway: see p5)' : `accepted but ignored: ${firstCall(res)}` };
    });

    await runStep(run, 'p5', () => call({ messages: p1Messages, toolChoice: FORCE_FINISH }), (res) => {
      const forced = isFinish(res.message.tool_calls?.[0]);
      return { ok: forced, note: forced ? 'honoured: called finish although the user asked for read_file first' : `not honoured: ${firstCall(res)}` };
    });
  } finally {
    settle(run.result, local, tally);
  }
  run.result.ok = passed(run.result, 'p1') && passed(run.result, 'p2');
  return run.result;
}

/**
 * The vision probe of one model (step v1): the Appendix B prompt and schema on two drawn PNGs.
 * Passes when the answer is parseable JSON with verdict cover_up; the note records prompt_tokens.
 * Needs agent/png.mjs (Track F); without it the result is {skipped: true} and nothing is sent.
 * @param {string} model
 * @param {{tally?: import('./inference.mjs').Tally, guard?: import('./inference.mjs').Guard, signal?: AbortSignal}} [opts]
 * @returns {Promise<ProbeResult>}
 */
export async function probeVision(model, opts = {}) {
  const { tally, guard, signal } = opts ?? {};
  checkTally(tally);
  const run = newRun(model, 'vision');
  if (typeof model !== 'string' || !MODEL_ID.test(model)) {
    run.stop = 'invalid model id';
    await runStep(run, 'v1');
    return run.result;
  }
  let encodePng;
  try {
    ({ encodePng } = await import('./png.mjs'));
    if (typeof encodePng !== 'function') throw new Error('encodePng is not exported');
  } catch (err) {
    return { ...run.result, skipped: true, note: `skipped: agent/png.mjs is not usable (${clip(err?.code ?? err?.message ?? 'error', 80)})` };
  }
  const local = newTally();
  try {
    let before, after;
    try {
      before = encodePng(testImage(true));
      after = encodePng(testImage(false));
    } catch (err) {
      run.stop = `the test images could not be drawn (${clip(err?.message ?? 'error', 120)})`;
      await runStep(run, 'v1');
      return run.result;
    }
    const messages = [
      { role: 'system', content: VISION_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_ISSUE },
          { type: 'text', text: VISION_LABELS },
          { type: 'text', text: `Code diff (may be cut):\n${VISION_DIFF}` },
          { type: 'text', text: 'BEFORE:' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${before.toString('base64')}` } },
          { type: 'text', text: 'AFTER:' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${after.toString('base64')}` } },
        ],
      },
    ];
    await runStep(run, 'v1', () => chat({
      model, messages, responseFormat: VISION_SCHEMA, maxTokens: MAX_TOKENS, reasoning: REASONING, signal, guard, tally: local,
    }), judgeVision);
  } finally {
    settle(run.result, local, tally);
  }
  run.result.ok = passed(run.result, 'v1');
  return run.result;
}

/**
 * Everything POST /admin/probe asks for: the tool probe of each of `models`, then the vision probe
 * of each of `vision`. Different models run in parallel (each has its own rate limit); the steps of
 * one model run in order. Results keep the input order, tool probes first.
 * @param {{models?: string[], vision?: string[]}} req
 * @param {{tally?: import('./inference.mjs').Tally, guard?: import('./inference.mjs').Guard, signal?: AbortSignal}} [opts]
 * @returns {Promise<ProbeResult[]>}
 * @throws {TypeError} when a list is not an array of at most 12 model ids
 */
export async function probeAll({ models = [], vision = [] } = {}, opts = {}) {
  for (const [name, list] of [['models', models], ['vision', vision]]) {
    if (!Array.isArray(list) || list.length > MAX_MODELS || !list.every((m) => typeof m === 'string' && MODEL_ID.test(m))) {
      throw new TypeError(`probeAll: ${name} must be a list of at most ${MAX_MODELS} model ids`);
    }
  }
  const tools = await Promise.all(models.map((m) => probeModel(m, opts)));
  const looks = await Promise.all(vision.map((m) => probeVision(m, opts)));
  return [...tools, ...looks];
}

function newRun(model, kind) {
  return {
    stop: null, // why the remaining steps are not run
    result: { model: clip(String(model), 100), kind, ok: false, steps: [], served: null, tokens: { prompt: 0, completion: 0, reasoning: 0 }, usd: 0 },
  };
}

/**
 * One probe step: `send()` makes the call, `judge(res)` turns the answer into {ok, note}. An API error
 * becomes a failed step with its status and its own key-free message. A budget refusal, a cancelled
 * signal or an unexpected error stops the probe: the remaining steps are recorded as not run.
 * Resolves the chat() result, or null when there was none.
 */
async function runStep(run, name, send, judge) {
  if (run.stop) {
    run.result.steps.push({ name, ok: false, ms: 0, note: `not run: ${run.stop}` });
    return null;
  }
  const t0 = Date.now();
  try {
    const res = await send();
    run.result.served ??= res.model;
    const { ok, note } = judge(res);
    run.result.steps.push({ name, ok, status: 200, ms: Date.now() - t0, finishReason: res.finishReason, note: scrub(note), tokens: tokensOf(res.usage) });
    return res;
  } catch (err) {
    const step = { name, ok: false, ms: Date.now() - t0 };
    if (err instanceof BudgetError) {
      run.stop = `the spend guard refused (${err.scope})`;
      step.note = scrub(`spend guard (${err.scope}): ${err.message}`);
    } else if (err instanceof InferenceError) {
      if (err.type === 'aborted') run.stop = 'the probe was cancelled';
      if (err.status) step.status = err.status;
      if (err.served) run.result.served ??= clip(err.served, 100);
      step.note = scrub(err.message);
    } else {
      run.stop = 'an unexpected error stopped the probe';
      step.note = scrub(`unexpected error: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
    }
    run.result.steps.push(step);
    return null;
  }
}

function judgeFirstRead(res) {
  const calls = res.message.tool_calls ?? [];
  const first = calls[0];
  const args = argsOf(first);
  const problems = [];
  if (res.finishReason !== 'tool_calls') problems.push(`finish_reason ${res.finishReason}`);
  if (!first) problems.push('no tool call');
  else {
    if (first.function?.name !== 'read_file') problems.push(`the first call is ${clip(String(first.function?.name), 40)}`);
    if (!args) problems.push('its arguments are not a JSON object');
    else if (normalPath(args.path) !== 'index.html') problems.push(`path ${clip(JSON.stringify(args.path) ?? 'missing', 60)}`);
    if (typeof first.id !== 'string' || !first.id.startsWith('call_')) problems.push(`call id ${clip(String(first.id), 40)} does not start with call_`);
  }
  if (problems.length) return { ok: false, note: problems.join('; ') };
  return { ok: true, note: `read_file ${clip(JSON.stringify(args.path), 60)}; ${calls.length} tool call${calls.length === 1 ? '' : 's'} in the turn` };
}

function judgeFinish(res, extra) {
  const fin = (res.message.tool_calls ?? []).find(isFinish);
  if (!fin) return { ok: false, note: `no finish call: ${firstCall(res)}${extra}` };
  const summary = argsOf(fin)?.summary;
  if (typeof summary !== 'string' || !summary.trim()) return { ok: false, note: `finish without a string summary${extra}` };
  return { ok: true, note: `finish: "${clip(oneLine(summary), 100)}"${extra}` };
}

function judgeVision(res) {
  const tokens = `prompt_tokens ${count(res.usage?.prompt_tokens)}`;
  let v;
  try {
    v = JSON.parse(res.message.content.trim());
  } catch {
    return { ok: false, note: `the answer is not JSON (${tokens}): ${clip(oneLine(res.message.content) || '(empty)', 80)}` };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, note: `the answer is not a JSON object (${tokens})` };
  if (v.verdict !== 'cover_up') return { ok: false, note: `verdict ${clip(String(v.verdict), 30)}, expected cover_up (${tokens})` };
  return { ok: true, note: `verdict cover_up; target_visible_after ${v.target_visible_after}; ${tokens}` };
}

/** A 400×300 white RGB image, with the dark 300×40 bar at y=120 when `withBar`. */
function testImage(withBar) {
  const width = 400, height = 300, channels = 3;
  const data = Buffer.alloc(width * height * channels, 255);
  if (withBar) {
    for (let y = 120; y < 160; y++) {
      for (let x = 50; x < 350; x++) data.set([31, 41, 55], (y * width + x) * channels);
    }
  }
  return { width, height, channels, data };
}

function argsOf(call) {
  const a = call?.function?.arguments;
  if (a && typeof a === 'object' && !Array.isArray(a)) return a;
  if (typeof a !== 'string') return null;
  try {
    const v = JSON.parse(a);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function settle(result, local, tally) {
  result.tokens = { prompt: local.promptTokens, completion: local.completionTokens, reasoning: local.reasoningTokens };
  result.usd = local.usd === null ? null : Math.round(local.usd * 1e8) / 1e8;
  if (tally) mergeTally(tally, local);
}

function checkTally(tally) {
  if (tally !== undefined && tally !== null && !(typeof tally === 'object' && typeof tally.calls === 'number' && tally.byModel)) {
    throw new TypeError('probe: tally must come from newTally()');
  }
}

/** Belt and braces: no note ever holds the key, whatever produced it. */
function scrub(text) {
  const key = process.env.VULTR_INFERENCE_API_KEY;
  const s = clip(String(text ?? ''), 300);
  return key && key.length >= 8 ? s.split(key).join('[redacted]') : s;
}

const isFinish = (c) => c?.function?.name === 'finish';
const passed = (result, name) => result.steps.some((s) => s.name === name && s.ok === true);
const firstCall = (res) => (res.message.tool_calls?.length ? `the first call is ${clip(String(res.message.tool_calls[0]?.function?.name), 40)}` : `no tool call (finish_reason ${res.finishReason})`);
const normalPath = (p) => (typeof p === 'string' ? p.trim().replace(/^(\.\/)+/, '') : null);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const tokensOf = (u) => ({ prompt: count(u?.prompt_tokens), completion: count(u?.completion_tokens), reasoning: count(u?.completion_tokens_details?.reasoning_tokens) });
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
