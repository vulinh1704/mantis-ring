#!/usr/bin/env node
// A stand-in for Vultr Serverless Inference in tests: an OpenAI-compatible HTTP server on 127.0.0.1
// that answers chat completions from a script instead of a model, and POST /v1/audio/speech with a WAV
// of silence (or a scripted answer). Tests point VULTR_INFERENCE_URL at it (and set a fake key) BEFORE
// importing agent/inference.mjs, so the real chat(), speech(), guard and tally run end to end and no
// token is ever spent. Every request is recorded for assertions; the Authorization header is only
// compared with the fake key, never stored.
//
// Usage in a test:
//   const gw = await startFakeGateway([callTools([{ name: 'read_file', args: { path: 'index.html' } }])]);
//   process.env.VULTR_INFERENCE_URL = `${gw.url}/v1`; process.env.VULTR_INFERENCE_API_KEY = FAKE_KEY;
//   const { chat } = await import('../agent/inference.mjs');
// Standalone, for a local app run against a fake model that always calls finish:
//   node test/fake-gateway.mjs [--port 18999]
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const FAKE_KEY = 'sk-fake-test';
const MAX_BODY = 32 * 2 ** 20; // vision requests carry two PNGs as data URIs

/**
 * The catalogue served at GET /v1/models, in the shape agent/inference.mjs parses: prices sit in
 * input_modalities[].pricing (prompt) and output_modalities[].pricing (completion), `cost_usd` per
 * token. fake-coder costs 0.15 / 0.60 USD per 1M tokens; fake-vision has no price at all, so a
 * call to it must make the tally's cost unknown (null).
 */
export const FAKE_CATALOG = {
  object: 'list',
  data: [
    {
      id: 'fake-coder', object: 'model', name: 'Fake Coder (tests)', owned_by: 'mantis-ring-tests', context_length: 131072,
      input_modalities: [{ type: 'text', pricing: [{ type: 'prompt', unit: 'token', cost_usd: 1.5e-7 }] }],
      output_modalities: [{ type: 'text', pricing: [{ type: 'completion', unit: 'token', cost_usd: 6e-7 }] }],
      supported_parameters: ['tools', 'reasoning', 'max_completion_tokens', 'temperature', 'top_p', 'seed', 'response_format'],
    },
    {
      id: 'fake-vision', object: 'model', name: 'Fake Vision (tests, no price)', owned_by: 'mantis-ring-tests', context_length: 32768,
      input_modalities: [{ type: 'text', pricing: [] }, { type: 'image', pricing: [] }],
      output_modalities: [{ type: 'text', pricing: [] }],
      supported_parameters: ['reasoning', 'max_completion_tokens', 'temperature', 'response_format'],
    },
    // Speech models in the real catalogue's shape (4 Nov): priced per second of audio, as a string.
    fakeSpeechModel('fake-speech', '0.0003'),
    fakeSpeechModel('fake-speech-pricey', '0.01'),
    fakeSpeechModel('fake-speech-unpriced', null),
  ],
};

/** fake-coder's prices in USD per 1M tokens, for assertions on the tally. */
export const FAKE_PRICES = { 'fake-coder': { promptPer1M: 0.15, completionPer1M: 0.60 } };
/** The fake speech models' prices in USD per second of audio (fake-speech-unpriced has none). */
export const FAKE_SPEECH_PRICES = { 'fake-speech': 0.0003, 'fake-speech-pricey': 0.01 };

function fakeSpeechModel(id, perSecond) {
  return {
    id, object: 'model', name: `${id} (tests)`, owned_by: 'mantis-ring-tests',
    input_modalities: [{ type: 'text', supported_inputs: { max_prompt_length: { value: 4800, unit: 'character' } } }],
    output_modalities: [{
      type: 'speech', streaming: true,
      supported_parameters: { voice: { type: 'enum', values: ['default', 'clone'] }, response_format: { type: 'enum', values: ['mp3', 'opus', 'flac', 'wav', 'pcm'] } },
      pricing: perSecond === null ? [] : [{ type: 'completion', unit: 'second', cost_usd: perSecond }],
    }],
  };
}

const SPEECH_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/ogg' };

/** A 16-bit mono PCM WAV with `seconds` of silence. */
export function wavBytes(seconds, sampleRate = 24000) {
  const dataSize = Math.round(seconds * sampleRate) * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + dataSize, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // byte rate
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(dataSize, 40);
  return b;
}

/**
 * The default answer to POST /v1/audio/speech, as the real service gives it: the audio itself (a WAV
 * of silence for "wav", a few marker bytes otherwise), one second for every 15 characters, with
 * X-Usage-Seconds and, for a priced model, X-Usage-Cost.
 */
export function speechAnswer(body, { seconds, headers = {} } = {}) {
  const format = typeof body?.response_format === 'string' ? body.response_format : 'mp3';
  const secs = seconds ?? Math.max(1, Math.ceil(String(body?.input ?? '').length / 15));
  const audio = format === 'wav' ? wavBytes(secs) : Buffer.from(`FAKE ${format} AUDIO, ${secs} s`);
  const perSecond = FAKE_SPEECH_PRICES[body?.model];
  const usage = { 'x-usage-seconds': String(secs), ...(perSecond === undefined ? {} : { 'x-usage-cost': (secs * perSecond).toFixed(6) }) };
  return { status: 200, headers: { 'content-type': SPEECH_TYPES[format] ?? 'application/octet-stream', ...usage, ...headers }, audio };
}

/** A tool call as the gateway returns it. `args` may be an object or a raw string (to send invalid JSON). */
export function toolCall(name, args = {}, id = `call_${randomBytes(6).toString('hex')}`) {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

/** An OpenAI `usage` object. */
export function usage(prompt, completion, reasoning = 0) {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, completion_tokens_details: { reasoning_tokens: reasoning } };
}

/**
 * A step answer that calls tools: callTools([{ name, args, id? }, …]).
 * @param {{content?: string|null, finishReason?: string, usage?: object, model?: string, reasoning?: string}} [o]
 */
export function callTools(calls, { content = null, finishReason = 'tool_calls', usage: u, model, reasoning } = {}) {
  const message = { role: 'assistant', content, tool_calls: calls.map((c) => toolCall(c.name, c.args, c.id)) };
  if (reasoning) message.reasoning = reasoning;
  return { ...(model ? { model } : {}), ...(u ? { usage: u } : {}), choices: [{ index: 0, message, finish_reason: finishReason }] };
}

/** A step answer with plain text and no tool call (finish_reason 'stop' unless given). */
export function say(text, { finishReason = 'stop', usage: u, model, reasoning } = {}) {
  const message = { role: 'assistant', content: text };
  if (reasoning) message.reasoning = reasoning;
  return { ...(model ? { model } : {}), ...(u ? { usage: u } : {}), choices: [{ index: 0, message, finish_reason: finishReason }] };
}

/** A step answer that is an HTTP error in the gateway's format (error.metadata.error_type). */
export function httpError(status, message, { errorType = 'provider_error', headers = {} } = {}) {
  return { status, headers, body: { error: { message, code: status, metadata: { error_type: errorType } } } };
}

/** A step answer that holds the request open for `ms`, then sends `after` if the client is still there. */
export function sleep(ms, after) {
  return { sleepMs: ms, after };
}

/** The tool results (role 'tool' messages) of a recorded request body. */
export function toolResults(body) {
  return (body?.messages ?? []).filter((m) => m?.role === 'tool');
}

/**
 * Protocol problems the real gateway would refuse with a 400, or that break the loop's contract:
 * every assistant tool call answered by exactly one tool message before the next turn, string tool
 * results, echoed tool-call arguments that parse to a JSON object (vLLM and SGLang json.loads every
 * one of them before they apply the chat template), and a history that ends with a user or tool message.
 * @returns {string[]} empty when the body is fine
 */
export function chatProblems(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['the body is not a JSON object'];
  const problems = [];
  if (typeof body.model !== 'string' || !body.model) problems.push('model is missing');
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return [...problems, 'messages is empty'];
  let open = null; // ids of the last assistant message's tool calls that have no result yet
  messages.forEach((m, i) => {
    if (!['system', 'user', 'assistant', 'tool'].includes(m?.role)) {
      problems.push(`message ${i} has role ${JSON.stringify(m?.role)}`);
      return;
    }
    if (m.role === 'tool') {
      if (!open?.has(m.tool_call_id)) problems.push(`message ${i}: tool result ${JSON.stringify(m.tool_call_id)} answers no open tool call`);
      else open.delete(m.tool_call_id);
      if (typeof m.content !== 'string') problems.push(`message ${i}: tool result content is not a string`);
      return;
    }
    if (open?.size) problems.push(`message ${i}: ${open.size} tool call(s) before it got no result`);
    open = m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length ? new Set(m.tool_calls.map((c) => c?.id)) : null;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        let args;
        try { args = JSON.parse(c?.function?.arguments); } catch { args = undefined; }
        if (!args || typeof args !== 'object' || Array.isArray(args)) problems.push(`message ${i}: the arguments of tool call ${JSON.stringify(c?.id)} are not the text of a JSON object`);
      }
    }
  });
  if (open?.size) problems.push(`the last ${open.size} tool call(s) got no result`);
  const last = messages.at(-1)?.role;
  if (last !== 'user' && last !== 'tool') problems.push(`the history ends with a ${last} message`);
  return problems;
}

/** Rough token counts for an answer that did not script its own usage (about 4 characters a token). */
function estimateUsage(body, message) {
  const prompt = Math.ceil(JSON.stringify(body.messages ?? []).length / 4) + Math.ceil(JSON.stringify(body.tools ?? []).length / 4);
  return usage(prompt, 16 + Math.ceil(JSON.stringify(message ?? {}).length / 4));
}

/** Fill in the parts of a scripted completion that it left out (id, model = the requested one, usage). */
function completion(body, partial, n) {
  if (!Array.isArray(partial?.choices) || !partial.choices[0]?.message) throw new Error(`step ${n} returned neither a completion, an HTTP answer nor a sleep`);
  return {
    id: partial.id ?? `chatcmpl-fake-${n}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: partial.model ?? body.model,
    choices: partial.choices,
    usage: partial.usage ?? estimateUsage(body, partial.choices[0].message),
  };
}

function send(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('request body over 32 MiB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start the fake gateway on 127.0.0.1 (a random port unless `port` is given).
 * A step is `(body, ctx) => answer` (it may be async; ctx is {n, requests}), or an answer object used
 * as is. An answer is a completion (see callTools / say), `{status, headers, body}` (see httpError) or
 * `{sleepMs, after}` (see sleep). `script` is an array of steps, one per chat request in order, or one
 * step function used for every request. A request past the end of the script gets a 400
 * (non-retryable), so a loop that talks longer than planned stops instead of hanging.
 * POST /v1/audio/speech answers speechAnswer(body) unless setSpeech() gave a step: a function of the
 * body, or an answer used as is: `{status, headers, audio: Buffer}` (the audio), `{status, headers, body}`
 * (an error, see httpError) or `{sleepMs, after}`. setSpeech(null) goes back to the default.
 * @param {Array<Function|object>|Function} [script]
 * @param {{strict?: boolean, port?: number}} [o]  strict (default): answer 400 to protocol problems (chatProblems)
 * @returns {Promise<{url: string, requests: object[], chats: () => object[], speeches: () => object[], setScript: (s) => void,
 *   setSpeech: (s) => void, close: () => Promise<void>}>}
 *   url has no /v1. requests: {n?, method, path, auth, at, body, problems}; `auth` is true when the
 *   request carried "Bearer <FAKE_KEY>". setScript replaces the script and clears `requests` in place.
 */
export async function startFakeGateway(script = [], { strict = true, port = 0 } = {}) {
  const requests = [];
  const timers = new Set();
  let steps = script;
  let chatCount = 0;
  let speechStep = null;

  /** Resolves true when the client went away before `ms` passed. */
  const wait = (ms, res) => new Promise((resolve) => {
    const gone = () => { clearTimeout(timer); timers.delete(timer); resolve(true); };
    const timer = setTimeout(() => { timers.delete(timer); res.off('close', gone); resolve(false); }, ms);
    timers.add(timer);
    res.once('close', gone);
  });

  async function answer(res, body, result, n) {
    if (result == null) {
      send(res, 400, httpError(400, `fake gateway: the script has no step ${n}`, { errorType: 'invalid_request' }).body);
      return;
    }
    if (typeof result.sleepMs === 'number') {
      const clientLeft = await wait(result.sleepMs, res);
      if (!clientLeft) await answer(res, body, result.after ?? say('(the fake gateway slept)'), n);
      return;
    }
    if (typeof result.status === 'number') {
      send(res, result.status, result.body ?? '', result.headers ?? {});
      return;
    }
    send(res, 200, completion(body, result, n));
  }

  async function answerSpeech(res, body, result) {
    if (typeof result?.sleepMs === 'number') {
      const clientLeft = await wait(result.sleepMs, res);
      if (!clientLeft) await answerSpeech(res, body, result.after ?? speechAnswer(body));
      return;
    }
    if (Buffer.isBuffer(result?.audio)) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(result.status ?? 200, { 'content-length': result.audio.length, ...(result.headers ?? {}) });
      res.end(result.audio);
      return;
    }
    send(res, result?.status ?? 500, result?.body ?? httpError(500, 'fake gateway: the speech step gave no answer').body, result?.headers ?? {});
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const record = { method: req.method, path: url.pathname, auth: req.headers.authorization === `Bearer ${FAKE_KEY}`, at: Date.now(), body: null, problems: [] };
    requests.push(record);
    if (req.method === 'GET' && url.pathname === '/v1/models') return send(res, 200, FAKE_CATALOG);
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return record.auth ? send(res, 200, { status: 'ok' }) : send(res, 401, httpError(401, 'missing or wrong API key', { errorType: 'authentication_error' }).body);
    }
    if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
      const text = await readBody(req);
      try {
        record.body = JSON.parse(text);
      } catch {
        record.problems.push('the body is not valid JSON');
        return send(res, 400, httpError(400, 'fake gateway: the body is not valid JSON', { errorType: 'invalid_request' }).body);
      }
      if (!record.auth) return send(res, 401, httpError(401, 'missing or wrong API key', { errorType: 'authentication_error' }).body);
      const result = typeof speechStep === 'function' ? await speechStep(record.body, { requests }) : speechStep ?? speechAnswer(record.body);
      return answerSpeech(res, record.body, result);
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return send(res, 404, { error: { message: `fake gateway: no route ${req.method} ${url.pathname}` } });

    const n = ++chatCount;
    record.n = n;
    const text = await readBody(req);
    try {
      record.body = JSON.parse(text);
    } catch {
      record.problems.push('the body is not valid JSON');
      return send(res, 400, httpError(400, 'fake gateway: the body is not valid JSON', { errorType: 'invalid_request' }).body);
    }
    if (!record.auth) return send(res, 401, httpError(401, 'missing or wrong API key', { errorType: 'authentication_error' }).body);
    record.problems = chatProblems(record.body);
    if (strict && record.problems.length) {
      return send(res, 400, httpError(400, `fake gateway rejected the request: ${record.problems[0]}`, { errorType: 'invalid_request' }).body);
    }
    const step = typeof steps === 'function' ? steps : steps[n - 1];
    const result = typeof step === 'function' ? await step(record.body, { n, requests }) : step;
    await answer(res, record.body, result, n);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, httpError(500, `fake gateway: ${err.message}`, { errorType: 'test_error' }).body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    chats: () => requests.filter((r) => r.path === '/v1/chat/completions'),
    speeches: () => requests.filter((r) => r.path === '/v1/audio/speech'),
    setScript(next) {
      steps = next;
      chatCount = 0;
      requests.length = 0;
    },
    setSpeech(next) {
      speechStep = next ?? null;
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 0;
  if (i > 0 && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) {
    console.error('usage: node test/fake-gateway.mjs [--port 1024-65535]');
    process.exit(64);
  }
  const gw = await startFakeGateway(() => callTools([{ name: 'finish', args: { summary: 'Fake model: nothing was changed.' } }]), { port });
  console.log(`fake gateway on ${gw.url}/v1 (key ${FAKE_KEY}); every chat answer calls finish. Ctrl-C to stop.`);
  const stop = () => gw.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
