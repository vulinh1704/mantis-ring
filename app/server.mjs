#!/usr/bin/env node
// The Mantis Ring web app and orchestrator: one HTTP listener on 127.0.0.1, behind Caddy (BUILD-SPEC §4).
// Public routes serve the UI, /status, task progress over Server-Sent Events, receipts, the owner's
// Approve and the patch download. Local-admin routes (/admin/*) start and inspect tasks, run probes and
// self-tests, change settings, publish runs and speak a short passage for the video's voice. They answer
// only requests from loopback that did not come through Caddy and name a loopback Host (D-4), and look
// like any unknown path (404) to everyone else.
// Tasks wait in the queue, then run in their own sandbox through runFix (agent/loop.mjs).
//
// Usage: node app/server.mjs   (env: PORT=8080 HOST=127.0.0.1 RING_STATE_DIR RING_PUBLIC_DIR RING_RUNTIME)
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BudgetError, InferenceError, SPEECH_FORMATS, chat, loadPricing, newTally, speech, speechPriceOf } from '../agent/inference.mjs';
import { APP_LABEL, Sandbox, childEnv } from '../runner/sandbox.mjs';
import * as configModule from './config.mjs';
import {
  CAP_RANGES, ConfigError, HEAVY_SLOTS, MAX_QUEUED, PROVIDER, PUBLIC_DIR, PUBLIC_URL, RUNTIME, SAMPLES, STATE_DIR, isPublicSample, samplingFor,
} from './config.mjs';
import { PublishError, notPublishable, publishLatest, refreshPlaceholder } from './publish.mjs';
import { Spend } from './spend.mjs';
import * as statusModule from './status.mjs';
import { oneLine, readLatest } from './status.mjs';
import { INTERRUPTED, Queue, QueueFullError, RunStats, TaskInputError, TaskStore, githubWallClockSec, taskFromBody } from './tasks.mjs';

const PUBLIC_ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_FILES = {
  'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8', 'favicon.svg': 'image/svg+xml',
};
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; "
  + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const BODY_LIMIT = 16 * 1024;
const TASK_IMAGE = /^(proof|contact-before|contact-after|crop-before-\d|crop-after-\d)\.png$/;
const FINISHED = new Set(['done', 'failed', 'timeout', 'cancelled', 'interrupted']);
const PER_IP = { hour: 3, day: 8 };                   // plus one queued or running task at a time (§4.4)
const SSE = { perIp: 6, total: 200, heartbeatMs: 20_000, maxBuffer: 1024 * 1024 };
const SELFTEST_SUITES = ['agent-loop', 'containment', 'scenes'];
const SELFTEST_TIMEOUT_MS = 20 * 60_000;
// A sandbox older than this is an orphan: twice the longest wall clock a task may have (80 minutes),
// four times the self-test limit.
const STALE_SANDBOX_MS = 2 * CAP_RANGES.wallClockSec[1] * 1000;
const PROBE_CAPS = { maxUsd: 0.25, maxPromptTokens: 400_000 };   // the whole probe costs < $0.02 (§5.3)
const PROBE_TIMEOUT_MS = 15 * 60_000;
// POST /admin/speech, the video's voice: one passage of at most 800 characters (about a minute of
// speech) per call, one call at a time, built-in voices only. A call goes out only if speech()'s pre-call
// estimate fits $0.05 and what is left of $0.50 of speech a UTC day, inside the admin and total caps.
const SPEECH = Object.freeze({ maxChars: 800, callUsd: 0.05, dayUsd: 0.5, timeoutMs: 180_000, maxBytes: 16 * 2 ** 20 });
const SPEECH_FIELDS = ['model', 'input', 'voice', 'format', 'language', 'speed', 'seed'];
const DIFF_SHOWN_BYTES = 200 * 1024;
// `seeded` (null, or the seeded scene's script, label and stand-in) lets the run page show its label from the start.
const PUBLIC_KEYS = ['id', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'origin', 'state', 'source', 'matrix', 'model',
  'visionModel', 'gate', 'promptVariant', 'seeded', 'position', 'step', 'stepTimes', 'sandbox', 'result', 'approvedAt', 'approvedWith', 'publishedAt'];
const MIN_ETA_RUNS = 3;              // an ETA needs this many comparable finished runs (as /api/config's etaText)
const MAX_PASSPHRASE_TRIES = 5;      // wrong approval passphrases per task before approving it is refused
const NORMAL_ENDS = ['finish', 'checks', 'turns', 'time', 'no-tools'];

// Public answers are one plain sentence each (§4.5).
const SAY = {
  closed: 'Live runs open soon. Meanwhile, the latest verified run shows a complete result.',
  // Only one kind of public run is open: these name the other, which the home page offers.
  closedGithub: 'Runs on your own GitHub repository are not open yet. You can run the sample project from the home page.',
  closedSample: 'Runs of the sample project are not open right now. You can run a public GitHub repository from the home page.',
  hour: `You have started ${PER_IP.hour} runs in the last hour from this network. Please try again later, or open the latest verified run.`,
  day: `You have started ${PER_IP.day} runs today from this network. Please try again tomorrow, or open the latest verified run.`,
  active: 'You already have a run in progress. Follow it, or wait until it finishes.',
  busy: `The demo is busy right now (${MAX_QUEUED} runs waiting). Please try again in a few minutes.`,
  budgetDay: "Today's demo budget is used up; it resets at 00:00 UTC. The latest verified run shows a complete result.",
  budgetTotal: 'The demo budget is used up. The latest verified run shows a complete result.',
  paused: 'Live runs are paused right now. Meanwhile, the latest verified run shows a complete result.',
  local: 'Runs can only be started from the public internet.',
  restarting: 'The demo is restarting. Please try again in a minute.',
  notFound: 'There is nothing at this address.',
  noTask: 'There is no run at this address. Runs are kept for 14 days.',
  owner: 'Only the person who started this run can do that.',
  internal: 'Something went wrong on our side. The latest verified run shows a complete result.',
};
// The same answers while no run is published yet: they must not send anyone to an empty page.
const SAY_UNPUBLISHED = {
  closed: 'Live runs open soon. Status shows the server live meanwhile.',
  hour: `You have started ${PER_IP.hour} runs in the last hour from this network. Please try again later.`,
  day: `You have started ${PER_IP.day} runs today from this network. Please try again tomorrow.`,
  budgetDay: "Today's demo budget is used up; it resets at 00:00 UTC.",
  budgetTotal: 'The demo budget is used up.',
  paused: 'Live runs are paused right now.',
  internal: 'Something went wrong on our side.',
};

/** A public sentence; the variants that point to the latest verified run are used only once one exists. */
function sentence(key) {
  return !readLatest() && Object.hasOwn(SAY_UNPUBLISHED, key) ? SAY_UNPUBLISHED[key] : SAY[key];
}

/** An answer other than 200: an HTTP status and one plain sentence (plus optional headers). */
class HttpError extends Error {
  constructor(status, sentence, headers = {}) {
    super(sentence);
    this.status = status;
    this.headers = headers;
  }
}
/** A reason a run could not start, fit to show on its page. */
class RunError extends Error {}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const delay = (ms) => new Promise((ok) => setTimeout(ok, ms).unref());

// ---------------------------------------------------------------------------------------------
// Who is asking (§4.1)
// ---------------------------------------------------------------------------------------------

/** Local admin (D-4): a loopback peer, no X-Forwarded-For (Caddy always adds one) and a loopback Host. */
export function isAdmin(req) {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const viaCaddy = 'x-forwarded-for' in req.headers;
  const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '');
  return loopback && !viaCaddy && hostOk;
}

/** The client address: the last X-Forwarded-For entry (the one Caddy added), else the socket peer. */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',').pop().trim();
  return req.socket.remoteAddress ?? '';
}

const LOCAL_NETS = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]]) {
  LOCAL_NETS.addSubnet(addr, bits, 'ipv4');
}
LOCAL_NETS.addAddress('::', 'ipv6');
LOCAL_NETS.addAddress('::1', 'ipv6');
LOCAL_NETS.addSubnet('fc00::', 7, 'ipv6');
LOCAL_NETS.addSubnet('fe80::', 10, 'ipv6');

/** Drop an IPv6 zone and the IPv4-mapped prefix. */
function plainIp(ip) {
  const s = String(ip ?? '').trim().replace(/%.*$/, '');
  return /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s)?.[1] ?? s;
}

/** Loopback, private, link-local or not an address at all: nobody there may start a task (§4.1). */
export function isLocalIp(ip) {
  const s = plainIp(ip);
  if (net.isIPv4(s)) return LOCAL_NETS.check(s, 'ipv4');
  if (net.isIPv6(s)) return LOCAL_NETS.check(s, 'ipv6');
  return true;
}

/** What per-IP limits count by: the IPv4 address, or the /64 of an IPv6 address. null when invalid. */
export function ipKey(ip) {
  const s = plainIp(ip);
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return null;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// ---------------------------------------------------------------------------------------------
// A task's sandbox
// ---------------------------------------------------------------------------------------------

/**
 * The loop's createSandbox for task `id`: Sandbox.create(), the runtime Docker really runs the box
 * under (HostConfig.Runtime, not what was asked for, §7 #13), then the task record. When a step after
 * create() fails, the box is destroyed here, because the loop never gets it then.
 * @param {string} id
 * @param {{store: {update: Function}, journal: (id: string, line: string) => void, create?: (o: object) => Promise<object>}} o
 *   `create` stands in for Sandbox.create() in tests
 * @returns {(o: {runtime?: string, labels?: Record<string, string>}) => Promise<object>}
 */
export function sandboxStarter(id, { store, journal, create = (o) => Sandbox.create(o) }) {
  return async (o) => {
    const box = await create(o);
    try {
      let runtime = o?.runtime ?? null;
      try { runtime = await box.runtimeName(); } catch (err) { journal(id, `runtime of ${box.name} not read: ${oneLine(err, 160)}`); }
      store.update(id, { sandbox: { name: box.name, runtime } });
      return box;
    } catch (err) {
      try { await box.destroy(); } catch (e) { journal(id, `sandbox ${box.name} not removed after a failed start: ${oneLine(e, 160)}`); }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Responses and request bodies
// ---------------------------------------------------------------------------------------------
function headers(extra) {
  return {
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...extra,
  };
}

function sendJson(res, status, body, extra = {}) {
  if (res.headersSent) { res.destroy(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...extra }));
  res.end(text);
}

/** Every error answer: {error: '<one plain sentence>', more: '/latest/'}, never a stack trace (§4.2). */
function sendError(res, status, sentence, extra = {}) {
  sendJson(res, status, { error: sentence, more: '/latest/' }, extra);
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-frame-options': 'DENY', 'content-length': Buffer.byteLength(html) }));
  res.end(html);
}

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found · Mantis Ring</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main class="wrap page">
<h1>Nothing here</h1>
<p class="muted">There is nothing at this address.</p>
<p><a href="/">Mantis Ring</a> · <a href="/status">Status</a></p>
</main>
</body>
</html>
`;

/**
 * 404. A browser (a GET that accepts text/html, outside /api/) gets a small page with links to the
 * home page and /status; everything else gets the JSON error. /admin/* answers exactly the same way.
 */
function sendNotFound(c) {
  if (c.method === 'GET' && !c.path.startsWith('/api/') && /text\/html/i.test(String(c.req.headers.accept ?? ''))) {
    sendHtml(c.res, NOT_FOUND_HTML, 404);
    return;
  }
  sendError(c.res, 404, SAY.notFound);
}

/** The owner's approval passphrase matches the stored SHA-256 (hex), compared in constant time. */
function passphraseOk(given, wantHex) {
  if (typeof given !== 'string' || given.length === 0 || given.length > 200) return false;
  const want = Buffer.from(wantHex, 'hex');
  const got = createHash('sha256').update(given, 'utf8').digest();
  return want.length === got.length && timingSafeEqual(want, got);
}

const staticFiles = new Map();
/** The UI's four files, read once. HTML gets the CSP; Caddy adds nosniff in front of the app as well. */
function sendPublicFile(res, name) {
  let body = staticFiles.get(name);
  if (!body) {
    try { body = readFileSync(path.join(PUBLIC_ROOT, name)); } catch { return sendError(res, 404, SAY.notFound); }
    staticFiles.set(name, body);
  }
  const extra = { 'content-type': PUBLIC_FILES[name], 'cache-control': 'no-cache', 'content-length': body.length };
  if (name.endsWith('.html')) Object.assign(extra, { 'content-security-policy': CSP, 'x-frame-options': 'DENY' });
  res.writeHead(200, headers(extra));
  res.end(body);
}

/** Read a request body of at most `limit` bytes as text; 413 past it. */
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, `The request body is too large (${limit / 1024} KB at most).`, { connection: 'close' });
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0, done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { done = true; chunks.length = 0; reject(tooLarge()); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => { if (!done) { done = true; reject(new HttpError(400, 'The request body could not be read.')); } });
  });
}

/**
 * The JSON body of a POST, after the CSRF rules (§4.2): content-type application/json, which a
 * cross-site form cannot send and a cross-site fetch can only send after a preflight we never answer,
 * and no Sec-Fetch-Site other than same-origin or none. Origin is not checked: behind Caddy's
 * no-referrer policy a same-origin fetch sends "Origin: null". An empty body counts as {}.
 */
async function readJson(req) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Requests from other sites are not accepted.');
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Send the request body as JSON (content-type: application/json).');
  const text = await readBody(req);
  if (!text.trim()) return {};
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The request body must be a JSON object.');
  return body;
}

/**
 * The body of POST /admin/speech, checked: a speech model with a known price (the catalogue's, or one
 * pinned in agent/prices.mjs), 1 to 800 characters of text without control characters (tabs and new
 * lines aside), a built-in voice (clone and design are refused), and the audio format. Unknown fields
 * are refused. Throws HttpError 400 with the reason.
 */
function speechSpec(body) {
  const unknown = Object.keys(body).filter((k) => !SPEECH_FIELDS.includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown field${unknown.length > 1 ? 's' : ''} for speech: ${unknown.slice(0, 5).join(', ')}.`);
  const { model, input, voice, format = 'mp3', language, speed, seed } = body;
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model)) throw new HttpError(400, 'model must be the id of a speech model.');
  if (!speechPriceOf(model)) {
    throw new HttpError(400, `${model} is not a speech model with a known price in the catalogue, so its cost cannot be capped.`);
  }
  if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, 'input must be the text to speak.');
  const text = input.trim();
  if (text.length > SPEECH.maxChars) throw new HttpError(400, `The text has ${text.length} characters; one call speaks at most ${SPEECH.maxChars}.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new HttpError(400, 'The text may not contain control characters (tabs and new lines are fine).');
  if (voice !== undefined && (typeof voice !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(voice))) {
    throw new HttpError(400, 'voice must be the name of a built-in voice, such as default or aiden.');
  }
  if (voice === 'clone' || voice === 'design') throw new HttpError(400, 'Only built-in voices are used: clone and design are refused.');
  if (typeof format !== 'string' || !Object.hasOwn(SPEECH_FORMATS, format)) throw new HttpError(400, `format must be one of ${Object.keys(SPEECH_FORMATS).join(', ')}.`);
  if (language !== undefined && (typeof language !== 'string' || !/^[A-Za-z][A-Za-z -]{0,34}$/.test(language))) {
    throw new HttpError(400, 'language must be auto, a language code such as en, or a name such as English.');
  }
  if (speed !== undefined && !(typeof speed === 'number' && speed >= 0.5 && speed <= 2)) throw new HttpError(400, 'speed must be a number from 0.5 to 2.');
  if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0 && seed <= 2 ** 31 - 1)) throw new HttpError(400, 'seed must be a non-negative integer.');
  return { model, input: text, voice, format, language, speed, seed };
}

/** The owner token from x-ring-owner matches the task's stored SHA-256 (compared in constant time). */
function ownerOk(rec, req) {
  const token = req.headers['x-ring-owner'];
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
  const want = Buffer.from(rec.private?.ownerTokenSha256 ?? '', 'hex');
  const got = createHash('sha256').update(token).digest();
  return want.length === got.length && timingSafeEqual(want, got);
}

/** One SSE frame (§3.2). JSON.stringify never emits a raw newline, so `data` stays one line. */
function sseFrame(type, data, seq) {
  return `${seq === undefined ? '' : `id: ${seq}\n`}event: ${String(type).replace(/[^a-z-]/g, '')}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
}

// ---------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------

/**
 * Build the HTTP app around its dependencies. Every dependency has a default, so a test can pass only
 * what it fakes (usually runFix, spend and a temporary RING_STATE_DIR). `probe` is agent/probe.mjs
 * (probeAll); `vision` is visionCheck from agent/vision.mjs, to which each task adds its own chat,
 * tally and guard. Without them, /admin/probe answers 503 and runs skip the vision check.
 * `approval.passphraseSha256` (hex; read at call time, so a test may change it): when set, approving an
 * admin run, or a run that has been published, also needs the owner's approval passphrase, which the
 * operator of the admin channel never holds. A public run that was never published is approved with
 * its own owner link, and so is every run while no passphrase is set; the record and the published
 * page then say exactly that. A published public run needs both, so the judge who started it, who
 * has only the link, can no longer approve it or download its patch (its diff stays public).
 * `selftestDir` is the folder of the suites that POST /admin/selftest runs (test/ of this repository; a
 * test passes stand-ins).
 * @param {{config?:{get():object, set(patch:object):object}, store?:TaskStore, queue?:Queue, spend?:object|null,
 *   runFix?:Function|null, publish?:typeof publishLatest, status?:{statusData:Function, statusHtml:Function},
 *   now?:() => number, probe?:{probeAll:Function}|null, vision?:Function|null, stats?:RunStats, log?:(line:string) => void,
 *   approval?:{passphraseSha256?:string|null}, selftestDir?:string}} deps
 * @returns {{server: import('node:http').Server, close(): Promise<void>, store: TaskStore, queue: Queue}}
 */
export function createApp(deps = {}) {
  const config = deps.config ?? configModule;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line) => console.log(line));
  const store = deps.store ?? new TaskStore({ dir: path.join(STATE_DIR, 'tasks'), now, log });
  const queue = deps.queue ?? new Queue({ maxRunning: config.get().maxRunning, heavySlots: HEAVY_SLOTS, maxQueued: MAX_QUEUED, log });
  const spend = deps.spend ?? null;
  const runFix = deps.runFix ?? null;
  const publish = deps.publish ?? publishLatest;
  const status = deps.status ?? statusModule;
  const probe = deps.probe ?? null;
  const vision = deps.vision ?? null;
  const stats = deps.stats ?? new RunStats(path.join(STATE_DIR, 'stats.json'));
  const approval = deps.approval ?? { passphraseSha256: null };
  const selftestDir = deps.selftestDir ?? path.join(REPO_ROOT, 'test');
  const startedAt = now();
  const streams = new Set();       // open SSE responses
  const streamsByKey = new Map();  // client key -> number of open SSE responses
  const announced = new Map();     // queued task -> position last sent
  const passphraseTries = new Map(); // task id -> wrong approval passphrases in this process
  const selftests = [];            // the self-tests that wait or run, in order of arrival: {suite, running}
  let speechBusy = false;          // one speech call at a time, so its caps are checked against what is spent
  let closing = null;

  /** /admin/busy: the suite of the self-test that runs, else of the first that waits; null when there is none. */
  const selftestNow = () => (selftests.find((s) => s.running) ?? selftests[0])?.suite ?? null;
  /**
   * Whether a self-test holds the line: from the moment one is asked for, while it waits for the running
   * tasks to end, until it ends, no waiting task starts (Queue.pauseForExclusive). A run held this way
   * says so on its page and on /status, and gets no ETA, since no run's history predicts the self-test.
   */
  const held = () => selftests.length > 0;

  /** The approval passphrase's SHA-256 (lowercase hex), or null when the owner link alone approves. */
  const approvalHash = () => {
    const h = approval?.passphraseSha256;
    return typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null;
  };

  /**
   * The passphrase hash that approving this run needs, or null when its owner link alone approves it.
   * An admin run needs the passphrase: the operator who started it holds its owner link too. So does
   * a run that has been published (it is on /latest/, or was), whatever its origin, because its
   * approval is shown there, and approving the run on /latest/ renders that page again: an operator
   * who publishes a public run cannot have it approved on /latest/ by a link alone. A public run's
   * owner token went only to the browser that started it, so until the run is published its owner
   * approves it with that link alone. Once it is published, the run page shows that owner one
   * sentence instead of the passphrase box (app.js). The alternative, a passphrase for admin runs
   * only, would let that judge approve their published run, but not keep /latest/ to this rule.
   */
  const passphraseFor = (rec) => {
    const want = approvalHash();
    if (!want) return null;
    const published = Boolean(rec?.publishedAt) || readLatest()?.taskId === rec?.id;
    return rec?.origin === 'public' && !published ? null : want;
  };

  const journal = (id, text) => log(`task=${id} ${oneLine(text, 400)}`);
  const emit = (id, type, data) => store.appendEvent(id, type, data);

  // --- queue, ETA, task life cycle -------------------------------------------------------------
  queue.on('change', announcePositions);

  /** Tell each waiting task its new place in line, and whether a self-test holds the line. */
  function announcePositions() {
    const waiting = queue.queued();
    const hold = held();
    for (const id of waiting) {
      const position = queue.position(id);
      const said = `${position}${hold ? ' held' : ''}`;
      if (announced.get(id) === said) continue;
      announced.set(id, said);
      try {
        store.update(id, { position });
        emit(id, 'state', { state: 'queued', position, etaSec: etaFor(id), held: hold });
      } catch (err) {
        log(`task=${id} position not announced: ${oneLine(err)}`);
      }
    }
    for (const id of announced.keys()) if (!waiting.includes(id)) announced.delete(id);
  }

  const elapsedSec = (id) => {
    const t = Date.parse(store.get(id)?.startedAt ?? '');
    return Number.isFinite(t) ? (now() - t) / 1000 : 0;
  };
  /** Seconds until a slot frees when every slot is busy (the running task closest to its median end). */
  const slotFreeIn = (median) => {
    const running = queue.running();
    if (running.length < queue.maxRunning) return 0;
    return Math.min(...running.map((id) => Math.max(0, median - elapsedSec(id))));
  };
  /** The median length of a comparable run, once MIN_ETA_RUNS of them exist; null before ("a few minutes"). */
  const medianRun = () => (stats.count() >= MIN_ETA_RUNS ? stats.median() : null);
  /**
   * §4.4: ceil(position / maxRunning) × median + time until a slot frees. null without enough history,
   * and for a waiting task while a self-test holds the line.
   */
  function etaFor(id) {
    const median = medianRun();
    const pos = queue.position(id);
    if (median === null || pos === null) return null;
    if (pos === 0) return Math.max(0, Math.round(median - elapsedSec(id)));
    if (held()) return null;
    return Math.round(Math.ceil(pos / Math.max(1, queue.maxRunning)) * median + slotFreeIn(median));
  }
  /** ETA for a run submitted now (shown on /status); null while a self-test holds the line. */
  function etaForNew() {
    const median = medianRun();
    if (median === null || held()) return null;
    const pos = queue.queued().length + 1;
    if (queue.queued().length === 0 && queue.running().length < queue.maxRunning) return Math.round(median);
    return Math.round(Math.ceil(pos / Math.max(1, queue.maxRunning)) * median + slotFreeIn(median));
  }

  /**
   * Whether a finished run predicts the next public one: the public sample with its own matrix, the
   * neutral task message, a model (not the seeded stand-in), the default limits that set its length
   * (checks, turns, wall clock) and a normal end. Smoke tests on one screen, pressure-arm runs, seeded
   * runs, runs of an admin-only sample (Atlas), runs stopped by their budget or by an inference error,
   * and GitHub runs do not count.
   */
  function comparableRun(rec, receipt) {
    const s = rec.source?.kind === 'sample' && isPublicSample(rec.source.name) ? SAMPLES[rec.source.name] : null;
    if (!s || rec.seeded || (rec.promptVariant ?? 'neutral') !== 'neutral') return false;
    const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
    if (!['routes', 'viewports', 'schemes', 'locales'].every((k) => same(rec.matrix?.[k], s[k]))) return false;
    const def = config.get().caps ?? {};
    if (!['maxChecks', 'maxTurns', 'maxTurnsPerCheck', 'wallClockSec'].every((k) => rec.caps?.[k] === def[k])) return false;
    return NORMAL_ENDS.includes(receipt?.stopReason);
  }

  function createTask(origin, spec, key) {
    const id = `t_${randomBytes(16).toString('hex')}`;
    const ownerToken = randomBytes(32).toString('base64url');
    const promptVariant = spec.promptVariant ?? 'neutral';
    store.create({
      id, origin, label: spec.label, state: 'queued',
      source: spec.source, matrix: spec.matrix, model: spec.model, sampling: spec.sampling,
      visionModel: spec.visionModel, gate: spec.gate, promptVariant, seeded: spec.seeded ?? null, caps: spec.caps,
      position: null, step: 'queue', stepTimes: {}, sandbox: null, result: null,
      startedAt: null, finishedAt: null, approvedAt: null, publishedAt: null,
      private: { ipKey: key, ownerTokenSha256: sha256(ownerToken) },
    });
    emit(id, 'step', { step: 'queue', status: 'start' });
    journal(id, `created origin=${origin} source=${spec.source.kind}:${spec.source.label} model=${spec.model} gate=${spec.gate ? 'on' : 'off'} prompt=${promptVariant}`
      + `${spec.seeded ? ` seeded=${spec.seeded.script}` : ''}${spec.label ? ` label=${spec.label}` : ''}`);
    try {
      queue.enqueue(id, { priority: spec.priority, run: (signal) => runOne(id, signal) });
    } catch (err) {
      endTask(id, { state: 'cancelled', error: 'The demo was too busy to queue this run.' });
      if (err instanceof QueueFullError) throw new HttpError(503, SAY.busy);
      throw err;
    }
    return { id, ownerToken, position: queue.position(id) };
  }

  /**
   * The task as runFix takes it (§1.7): a sample gets its host folder back from the allowlist, and
   * whether it is public, so the receipt of an admin-only sample (Atlas) never says publishable.
   */
  function fixTask(rec) {
    const s = rec.source;
    let source;
    if (s.kind === 'sample') {
      if (!Object.hasOwn(SAMPLES, s.name)) throw new RunError('That sample is no longer available on this server.');
      source = { kind: 'sample', name: s.name, dir: SAMPLES[s.name].dir, label: s.label, publicSample: isPublicSample(s.name) };
    } else {
      source = { kind: 'github', owner: s.owner, name: s.name, label: s.label };
    }
    return {
      id: rec.id, source, matrix: rec.matrix, model: rec.model, sampling: rec.sampling, visionModel: rec.visionModel, gate: rec.gate,
      promptVariant: rec.promptVariant ?? 'neutral', seeded: rec.seeded?.script ?? null, caps: rec.caps,
    };
  }

  /** Events from the loop: stored and streamed; `step` also updates the record. `done` is the app's own. */
  function loopEvent(id, type, data) {
    if (typeof type !== 'string' || !/^[a-z]{1,20}$/.test(type)) { journal(id, 'an event with an invalid type was dropped'); return; }
    if (type === 'done') return;   // sent by endTask, once the record holds the final state
    try {
      emit(id, type, data ?? {});
      if (type === 'step' && typeof data?.step === 'string') {
        const patch = {};
        if (data.status === 'start') patch.step = data.step;
        if (Number.isFinite(data.ms)) patch.stepTimes = { ...store.get(id).stepTimes, [data.step]: data.ms };
        if (Object.keys(patch).length) store.update(id, patch);
      }
    } catch (err) {
      journal(id, `event ${type} not stored: ${oneLine(err)}`);
    }
  }

  function callRunFix(rec, signal) {
    if (typeof runFix !== 'function') throw new RunError('The agent loop is not installed on this server yet.');
    if (!spend) throw new RunError('The spend ledger is not available, so the run could not start.');
    const id = rec.id;
    const task = fixTask(rec);
    const tally = newTally();
    const guard = spend.guardFor({ id, origin: rec.origin, caps: rec.caps });
    // The vision model gets its own sampling from modelSampling (§4.9), not the fix model's.
    const visionSampling = rec.visionModel ? samplingFor(rec.visionModel, config.get(), { bench: rec.origin === 'admin' }) : {};
    return runFix(task, {
      // A seeded task (task.seeded) never calls this: the loop answers from its script instead.
      chat,
      createSandbox: sandboxStarter(id, { store, journal }),
      emit: (type, data) => loopEvent(id, type, data),
      store: {
        put: async (name, data) => store.put(id, name, data),
        append: async (name, data) => store.append(id, name, data),
      },
      guard, tally, signal,
      runtime: RUNTIME,
      heavy: queue.heavy,
      // visionCheck with this task's model client, tally and spend guard; the loop's input cannot replace them.
      vision: rec.visionModel && vision && !rec.seeded ? (input) => vision({ ...input, sampling: visionSampling, chat, tally, guard }) : null,
      // The loop starts its own lines with task=<id>.
      log: (line) => (String(line).startsWith('task=') ? log(oneLine(line, 400)) : journal(id, line)),
    });
  }

  /** Run one task from the queue: runFix, then the final state, the stats and the `done` event. */
  async function runOne(id, signal) {
    const rec = store.get(id);
    if (!rec) return;
    const t0 = now();
    store.update(id, { state: 'running', position: 0, startedAt: iso(t0), step: 'clone' });
    emit(id, 'state', { state: 'running' });
    emit(id, 'step', { step: 'queue', status: 'done', ms: Math.max(0, t0 - Date.parse(rec.createdAt)) });
    journal(id, 'start');
    let result;
    try {
      result = await callRunFix(rec, signal);
    } catch (err) {
      journal(id, `runFix threw: ${oneLine(err?.stack ?? err, 300)}`);
      result = { status: 'failed', receipt: null, error: err instanceof RunError ? err.message : 'The run stopped because of an internal error.' };
    }
    let state = ['done', 'failed', 'timeout', 'cancelled'].includes(result?.status) ? result.status : 'failed';
    if (state === 'cancelled' && signal.reason === 'shutdown') state = 'interrupted';
    if (state === 'done') {
      stats.add({ id, kind: rec.source.kind, origin: rec.origin, comparable: comparableRun(rec, result?.receipt), sec: Math.round((now() - t0) / 100) / 10, at: iso(now()) });
    }
    endTask(id, { state, receipt: result?.receipt ?? null, error: errorText(state, result?.error) });
  }

  function errorText(state, err) {
    if (state === 'done') return null;
    if (state === 'interrupted') return INTERRUPTED;
    if (state === 'timeout') return 'The run reached its time limit and was stopped. Nothing was changed.';
    if (state === 'cancelled') return 'This run was cancelled.';
    return oneLine(err || 'The run failed before any change was made.', 300);
  }

  /** Final state of a task: the record first, then `state`, Approve waiting (if there is a patch), `done`. */
  function endTask(id, { state, receipt = null, error = null }) {
    const rec = store.get(id);
    if (!rec) return;
    const patch = { state, position: null, finishedAt: iso(now()), result: { status: state, verdict: receipt?.verdict ?? null, line: receipt?.line ?? null, error } };
    if (receipt?.containment?.sandbox) patch.sandbox = { name: receipt.containment.sandbox, runtime: receipt.containment.runtime ?? rec.sandbox?.runtime ?? null };
    store.update(id, patch);
    emit(id, 'state', { state });
    if (state === 'done' && store.size(id, 'patch.diff') > 0) emit(id, 'step', { step: 'approve', status: 'start', note: 'waiting for the owner to review the patch' });
    emit(id, 'done', error ? { status: state, error } : { status: state });
    journal(id, `end state=${state}${receipt ? ` verdict=${receipt.verdict} "${receipt.line}"` : ''}${error ? ` error="${error}"` : ''}`);
  }

  function cancelTask(rec, who) {
    if (FINISHED.has(rec.state)) throw new HttpError(409, 'This run has already finished.');
    const was = queue.cancel(rec.id, 'cancelled');
    journal(rec.id, `cancel requested ${who} (${was ?? 'not in the queue'})`);
    // A running task ends once runFix sees the abort and its sandbox is gone; runOne then ends it.
    if (was === 'running') return { id: rec.id, state: 'cancelling' };
    endTask(rec.id, { state: 'cancelled', error: 'This run was cancelled.' });
    return { id: rec.id, state: 'cancelled' };
  }

  // --- reading a task --------------------------------------------------------------------------
  function readReceipt(id) {
    const size = store.size(id, 'receipt.json');
    if (size <= 0 || size > 8 * 2 ** 20) return null;
    try { return JSON.parse(readFileSync(store.file(id, 'receipt.json'), 'utf8')); } catch { return null; }
  }

  /** The first DIFF_SHOWN_BYTES of patch.diff, for review on the task page (shown with textContent). */
  function readDiff(id) {
    const size = store.size(id, 'patch.diff');
    if (size <= 0) return null;
    const fd = openSync(store.file(id, 'patch.diff'), 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, DIFF_SHOWN_BYTES));
      const n = readSync(fd, buf, 0, buf.length, 0);
      return { text: buf.subarray(0, n).toString('utf8'), bytes: size, truncated: size > n };
    } finally {
      closeSync(fd);
    }
  }

  /** The public record (§3.1): never private.*, caps, label or sampling. With `full`, the receipt and the diff. */
  function publicView(rec, { full = false } = {}) {
    const out = { provider: PROVIDER };
    for (const k of PUBLIC_KEYS) out[k] = rec[k] ?? null;
    const m = rec.matrix ?? {};
    out.cells = ['routes', 'viewports', 'schemes', 'locales'].reduce((n, k) => n * (Array.isArray(m[k]) ? m[k].length : 1), 1);
    if (rec.state === 'queued' || rec.state === 'running') {
      out.position = queue.position(rec.id) ?? rec.position ?? null;
      out.etaSec = etaFor(rec.id);
    }
    if (rec.state === 'queued') out.held = held();
    out.hasPatch = rec.state === 'done' && store.size(rec.id, 'patch.diff') > 0;
    out.approvalNeedsPassphrase = passphraseFor(rec) !== null;
    out.files = store.names(rec.id, TASK_IMAGE);
    if (full && FINISHED.has(rec.state)) {
      out.receipt = readReceipt(rec.id);
      out.diff = out.hasPatch ? readDiff(rec.id) : null;
    }
    return out;
  }

  function taskOr404(id) {
    const rec = store.get(id);
    if (!rec) throw new HttpError(404, SAY.noTask);
    return rec;
  }

  function statusNow() {
    // How long the oldest running task has run: the outside monitor's "stuck task" signal.
    const longestRunningSec = Math.round(Math.max(0, ...queue.running().map(elapsedSec)));
    return status.statusData({ cfg: config.get(), queue, spend, startedAt, now, runtime: RUNTIME, etaSec: etaForNew(), longestRunningSec, held: held() });
  }

  // --- public routes (§4.2) --------------------------------------------------------------------
  async function createPublicTask(c) {
    const cfg = config.get();
    // D-5: each kind of public run has its own switch, the sample projects and any GitHub repository.
    if (!cfg.publicSampleRuns && !cfg.publicGithubRuns) return sendError(c.res, 503, sentence('closed'));
    const body = await readJson(c.req);
    if (closing) throw new HttpError(503, SAY.restarting);
    const ip = clientIp(c.req);
    const key = ipKey(ip);
    // Anything that reaches Caddy from a loopback or private address (a sandbox, the VM itself) is refused.
    if (!key || isLocalIp(ip)) throw new HttpError(403, SAY.local);
    const wantsRepo = body.repo !== undefined && body.repo !== null;
    if (wantsRepo && !cfg.publicGithubRuns) throw new HttpError(503, SAY.closedGithub);
    if (!wantsRepo && !cfg.publicSampleRuns) throw new HttpError(503, SAY.closedSample);
    let spec;
    try {
      spec = taskFromBody(body, { admin: false, cfg });
    } catch (err) {
      if (err instanceof TaskInputError) throw new HttpError(400, err.message);
      throw err;
    }
    checkIpLimits(key);
    if (queue.full()) throw new HttpError(503, SAY.busy);
    if (!spend) throw new HttpError(503, sentence('paused'));
    const can = spend.canStart('public', { maxUsd: spec.caps.maxUsd });
    if (!can.ok) {
      log(`public run refused by the budget: ${can.reason}`);
      throw new HttpError(503, sentence(can.scope === 'total' ? 'budgetTotal' : 'budgetDay'));
    }
    const t = createTask('public', spec, key);
    sendJson(c.res, 202, { id: t.id, ownerToken: t.ownerToken, position: t.position, etaSec: etaFor(t.id) });
  }

  /** §4.4: one queued or running task per network, 3 starts per rolling hour, 8 per UTC day. */
  function checkIpLimits(key) {
    const t = now();
    const mine = store.list({ origin: 'public' }).filter((r) => r.private?.ipKey === key);
    if (mine.some((r) => r.state === 'queued' || r.state === 'running')) throw new HttpError(429, SAY.active);
    const hour = mine.map((r) => Date.parse(r.createdAt)).filter((ms) => t - ms < 3_600_000).sort((a, b) => a - b);
    if (hour.length >= PER_IP.hour) {
      const wait = Math.ceil((hour[hour.length - PER_IP.hour] + 3_600_000 - t) / 1000);
      throw new HttpError(429, sentence('hour'), { 'retry-after': String(Math.max(1, wait)) });
    }
    const day = iso(t).slice(0, 10);
    if (mine.filter((r) => String(r.createdAt).slice(0, 10) === day).length >= PER_IP.day) {
      const wait = Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - t) / 1000);
      throw new HttpError(429, sentence('day'), { 'retry-after': String(Math.max(1, wait)) });
    }
  }

  function streamEvents(c) {
    const id = c.m[1];
    const rec = taskOr404(id);
    const key = c.admin ? 'admin' : ipKey(clientIp(c.req)) ?? 'unknown';
    if (streams.size >= SSE.total) throw new HttpError(503, 'Too many live views are open right now. Please try again in a minute.');
    if ((streamsByKey.get(key) ?? 0) >= SSE.perIp) throw new HttpError(429, 'Too many live views are open from this network. Close one and try again.');
    const after = Math.max(0, Number.parseInt(c.req.headers['last-event-id'] ?? c.url.searchParams.get('after') ?? '0', 10) || 0);
    const res = c.res;
    res.writeHead(200, headers({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }));
    if (c.req.method === 'HEAD') { res.end(); return; }
    streams.add(res);
    streamsByKey.set(key, (streamsByKey.get(key) ?? 0) + 1);
    let closed = false, unsubscribe = null, timer = null;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      clearInterval(timer);
      streams.delete(res);
      const n = (streamsByKey.get(key) ?? 1) - 1;
      if (n > 0) streamsByKey.set(key, n); else streamsByKey.delete(key);
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    const write = (text) => { if (!closed && !res.destroyed) res.write(text); };
    // Live events: a reader that stops reading is dropped before its buffer grows past 1 MB.
    const send = (ev) => {
      write(sseFrame(ev.type, ev.data, ev.seq));
      if (ev.type === 'done') close();
      else if (res.writableLength > SSE.maxBuffer) { log(`task=${id} a live view that does not keep up was closed`); close(); res.destroy(); }
    };
    res.on('error', () => {});
    res.on('close', close);
    write('retry: 3000\n\n');
    write(sseFrame('hello', { task: publicView(rec) }));
    // Replay, then subscribe, in the same tick: appendEvent is synchronous, so nothing falls in between.
    for (const ev of store.events(id, after)) {
      send(ev);
      if (closed) return;
    }
    unsubscribe = store.subscribe(id, send);
    timer = setInterval(() => write(': ping\n\n'), SSE.heartbeatMs);
    timer.unref();
  }

  function sendTaskFile(c, id, name, type, extra = {}) {
    const size = store.size(id, name);
    if (size <= 0) throw new HttpError(404, 'That file does not exist for this run.');
    c.res.writeHead(200, headers({ 'content-type': type, 'content-length': size, ...extra }));
    if (c.req.method === 'HEAD') { c.res.end(); return; }
    createReadStream(store.file(id, name)).on('error', () => c.res.destroy()).pipe(c.res);
  }

  /**
   * Approve (§4.2). The admin channel is refused outright. The owner token of an admin run cannot
   * prove a person: the admin channel that created the run holds it too, and could send it through
   * Caddy. So when the owner has set an approval passphrase on the server
   * (RING_APPROVE_PASSPHRASE_SHA256 in the service's environment, which the operator cannot read),
   * approving an admin run needs that passphrase, and so does approving a published run of either
   * origin, whose approval /latest/ shows (passphraseFor). A public run's token went only to the
   * browser that started it, so until the run is published its owner approves it with that token
   * alone, and can then download the patch; once it is published, the token alone is refused. The
   * record keeps which of the two approved the run, and the published page says no more than that.
   */
  async function approveTask(c) {
    const body = await readJson(c.req);
    const rec = taskOr404(c.m[1]);
    if (c.admin) throw new HttpError(403, "Approval must come from the owner's browser, not from the admin channel.");
    if (!ownerOk(rec, c.req)) throw new HttpError(403, SAY.owner);
    if (rec.state !== 'done' || store.size(rec.id, 'patch.diff') <= 0) throw new HttpError(403, 'Only a finished run with a patch can be approved.');
    let approvedAt = rec.approvedAt;
    if (!approvedAt) {
      const want = passphraseFor(rec);
      if (want) {
        const tries = passphraseTries.get(rec.id) ?? 0;
        if (tries >= MAX_PASSPHRASE_TRIES) throw new HttpError(403, 'Too many wrong passphrases for this run. It can be approved again after the demo restarts.');
        if (!passphraseOk(body.passphrase, want)) {
          passphraseTries.set(rec.id, tries + 1);
          journal(rec.id, `approval refused: wrong or missing passphrase (${tries + 1} of ${MAX_PASSPHRASE_TRIES})`);
          throw new HttpError(403, 'The approval passphrase is not right.');
        }
      }
      approvedAt = iso(now());
      const approvedWith = want ? 'passphrase' : 'owner-link';
      store.update(rec.id, { approvedAt, approvedWith });
      emit(rec.id, 'step', { step: 'approve', status: 'done', note: want ? 'approved by the owner with the approval passphrase' : 'approved with the owner link' });
      journal(rec.id, `approved (${approvedWith})`);
      await republishIfLatest(rec.id);
    }
    sendJson(c.res, 200, { id: rec.id, approvedAt });
  }

  function downloadPatch(c) {
    const rec = taskOr404(c.m[1]);
    if (!ownerOk(rec, c.req) || !rec.approvedAt) throw new HttpError(403, 'The owner can download the patch after approving the run.');
    sendTaskFile(c, rec.id, 'patch.diff', 'text/x-diff; charset=utf-8', { 'content-disposition': `attachment; filename="${rec.id}.patch"`, 'cache-control': 'no-store' });
  }

  async function cancelOwnTask(c) {
    await readJson(c.req);
    const rec = taskOr404(c.m[1]);
    if (!ownerOk(rec, c.req)) throw new HttpError(403, SAY.owner);
    sendJson(c.res, 200, cancelTask(rec, 'by its owner'));
  }

  // --- admin routes (§4.3) ---------------------------------------------------------------------
  async function adminHealth(c) {
    const h = await statusModule.healthData({ runtime: RUNTIME });
    sendJson(c.res, 200, {
      running: queue.running().length, queued: queue.queued().length, docker: h.docker, proxy: h.proxy,
      runtime: RUNTIME ?? 'runc', runtimeAvailable: h.runtimeAvailable, sandboxes: h.sandboxes, networks: h.networks,
      loop: typeof runFix === 'function', spend: !!spend, probe: !!probe, vision: !!vision,
    });
  }

  async function adminCreate(c) {
    const body = await readJson(c.req);
    if (closing) throw new HttpError(503, SAY.restarting);
    let spec;
    try {
      spec = taskFromBody(body, { admin: true, cfg: config.get() });
    } catch (err) {
      if (err instanceof TaskInputError) throw new HttpError(400, err.message);
      throw err;
    }
    if (queue.full()) throw new HttpError(503, SAY.busy);
    if (!spend) throw new HttpError(503, 'The spend ledger is not loaded, so no run can start.');
    const can = spend.canStart('admin', { maxUsd: spec.caps.maxUsd });
    if (!can.ok) throw new HttpError(503, can.reason);
    const t = createTask('admin', spec, 'admin');
    sendJson(c.res, 202, { id: t.id, ownerToken: t.ownerToken, ownerLink: `${PUBLIC_URL}/t/${t.id}#owner=${t.ownerToken}`, position: t.position });
  }

  function adminList(c) {
    const state = c.url.searchParams.get('state') || undefined;
    const label = c.url.searchParams.get('label') || undefined;
    sendJson(c.res, 200, store.list({ state, label }));
  }

  function adminGet(c) {
    const rec = taskOr404(c.m[1]);
    sendJson(c.res, 200, { ...rec, receipt: readReceipt(rec.id), hasPatch: store.size(rec.id, 'patch.diff') > 0, files: store.names(rec.id, /^[a-z0-9][a-z0-9_.-]*$/) });
  }

  function adminTranscript(c) {
    const rec = taskOr404(c.m[1]);
    sendTaskFile(c, rec.id, 'transcript.jsonl', 'application/x-ndjson; charset=utf-8', { 'cache-control': 'no-store' });
  }

  /**
   * Every file of a task as a tar stream: the host's own tar over files the app wrote itself. Bundles
   * end up in git (bench/), so task.json goes in without its private part (the client's network key
   * and the owner token's hash): a copy without it is written next to it and renamed in the archive.
   */
  function adminBundle(c) {
    const rec = taskOr404(c.m[1]);
    const res = c.res;
    const { private: _private, ...shareable } = rec;
    const copy = path.join(store.dir(rec.id), 'bundle-task.json');
    writeFileSync(`${copy}.tmp`, `${JSON.stringify(shareable, null, 2)}\n`, { mode: 0o640 });
    renameSync(`${copy}.tmp`, copy);
    const tar = spawn('tar', ['-C', store.dir(rec.id), '--exclude=./task.json', '--exclude=./task.json.tmp', '--exclude=./bundle-task.json.tmp',
      '--transform=s,^\\./bundle-task\\.json$,./task.json,', '-cf', '-', '.'], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    tar.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-500); });
    tar.on('error', (err) => { log(`bundle ${rec.id}: tar did not start: ${oneLine(err)}`); res.destroy(); });
    tar.on('close', (code) => {
      // A truncated tar must not look complete: on failure the connection is cut instead of ended.
      if (code !== 0) { log(`bundle ${rec.id}: tar exit ${code}: ${oneLine(stderr, 200)}`); res.destroy(); }
    });
    res.on('close', () => { if (tar.exitCode === null) tar.kill('SIGKILL'); });
    res.writeHead(200, headers({ 'content-type': 'application/x-tar', 'content-disposition': `attachment; filename="${rec.id}.tar"`, 'cache-control': 'no-store' }));
    tar.stdout.pipe(res);
  }

  async function adminCancel(c) {
    await readJson(c.req);
    sendJson(c.res, 200, cancelTask(taskOr404(c.m[1]), 'by the admin'));
  }

  /** Publish one run to /latest/ (§4.8) and record it in latest.json. Throws HttpError 409 when the bar refuses it. */
  async function publishTask(rec) {
    const receipt = readReceipt(rec.id);
    const why = notPublishable(rec, receipt);
    if (why) throw new HttpError(409, `Not published: ${why}.`);
    const files = {};
    for (const name of ['proof.png', 'contact-before.png', 'contact-after.png', 'patch.diff']) {
      if (store.size(rec.id, name) > 0) files[name] = store.file(rec.id, name);
    }
    let out;
    try {
      out = await publish({ task: publicView(rec), receipt, files, publicDir: PUBLIC_DIR });
    } catch (err) {
      if (err instanceof PublishError) throw new HttpError(409, `Not published: ${err.message}.`);
      throw err;
    }
    const at = iso(now());
    store.update(rec.id, { publishedAt: at });
    const latest = path.join(STATE_DIR, 'latest.json');
    writeFileSync(`${latest}.tmp`, `${JSON.stringify({ taskId: rec.id, at, line: receipt.line ?? null })}\n`, { mode: 0o640 });
    renameSync(`${latest}.tmp`, latest);
    journal(rec.id, `published to ${out.url}${rec.approvedAt ? ` (approved with ${rec.approvedWith ?? 'the owner link'})` : ' (not approved)'}`);
    return { out, at };
  }

  /** After an approval: when this run is the one on /latest/, render it again so the page shows the approval. */
  async function republishIfLatest(id) {
    if (readLatest()?.taskId !== id) return;
    try {
      await publishTask(store.get(id));
    } catch (err) {
      journal(id, `the approved run could not be published again: ${oneLine(err, 200)}`);
    }
  }

  async function adminPublish(c) {
    await readJson(c.req);
    const rec = taskOr404(c.m[1]);
    const { out, at } = await publishTask(rec);
    sendJson(c.res, 200, { id: rec.id, url: out.url, dir: out.dir, publishedAt: at, approvedAt: rec.approvedAt });
  }

  async function adminProbe(c) {
    const body = await readJson(c.req);
    if (!probe?.probeAll) throw new HttpError(503, 'agent/probe.mjs is not loaded on this server (see the startup log).');
    if (!spend) throw new HttpError(503, 'The spend ledger is not loaded, so no model can be called.');
    const can = spend.canStart('admin', { maxUsd: PROBE_CAPS.maxUsd });
    if (!can.ok) throw new HttpError(503, can.reason);
    const tally = newTally();
    const guard = spend.guardFor({ id: `probe-${now()}`, origin: 'admin', caps: PROBE_CAPS });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), PROBE_TIMEOUT_MS);
    c.res.on('close', () => { if (!c.res.writableEnded) ac.abort('the caller left'); });
    try {
      const results = await probe.probeAll({ models: body.models ?? [], vision: body.vision ?? [] }, { tally, guard, signal: ac.signal });
      log(`probe: ${results.map((r) => `${r.model}${r.kind === 'vision' ? ' (vision)' : ''} ${r.ok ? 'ok' : 'FAIL'}`).join(', ') || 'nothing to probe'}`);
      sendJson(c.res, 200, results);
    } catch (err) {
      if (err instanceof TypeError) throw new HttpError(400, `${err.message}.`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function adminSetConfig(c) {
    const body = await readJson(c.req);
    let cfg;
    try {
      cfg = config.set(body);
    } catch (err) {
      if (err instanceof ConfigError) throw new HttpError(400, `${err.message}.`);
      throw err;
    }
    queue.setMaxRunning(cfg.maxRunning);
    try {
      spend?.setCaps?.(cfg.spendCaps);
    } catch (err) {
      log(`config: the spend caps were saved but not applied: ${oneLine(err)}`);
    }
    log(`config: changed ${Object.keys(body).join(', ')}`);
    sendJson(c.res, 200, cfg);
  }

  function adminSpend(c) {
    if (!spend) throw new HttpError(503, 'The spend ledger is not loaded.');
    sendJson(c.res, 200, {
      today: spend.today(), totalUsd: spend.total(), caps: spend.caps, rows: spend.breakdown(),
      speech: { today: spend.speechToday(), maxChars: SPEECH.maxChars, callUsd: SPEECH.callUsd, dayUsd: SPEECH.dayUsd },
    });
  }

  /**
   * Speak one passage for the video's voice (POST /admin/speech): the body is checked by speechSpec(),
   * the call goes out through speech() with the key from this process's environment, and the answer
   * is the audio itself, with what it cost in x-ring-speech-* headers. The key never leaves the VM.
   * Refusals: 400 for the body, 429 while another speech call runs (or the provider's rate limit), 503
   * when a cap would be passed (nothing is sent then), 502 when the provider fails.
   */
  async function adminSpeech(c) {
    const body = await readJson(c.req);
    if (closing) throw new HttpError(503, SAY.restarting);
    if (!spend) throw new HttpError(503, 'The spend ledger is not loaded, so no model can be called.');
    await loadPricing();
    const spec = speechSpec(body);
    if (speechBusy) throw new HttpError(429, 'Another speech call is running. Try again when it has finished.', { 'retry-after': '10' });
    speechBusy = true;
    const ac = new AbortController();
    c.res.on('close', () => { if (!c.res.writableEnded) ac.abort('the caller left'); });
    let out;
    try {
      const guard = spend.speechGuard({ id: `speech-${now()}`, callUsd: SPEECH.callUsd, dayUsd: SPEECH.dayUsd });
      out = await speech({ ...spec, guard, signal: ac.signal, timeoutMs: SPEECH.timeoutMs, maxBytes: SPEECH.maxBytes });
    } catch (err) {
      if (err instanceof BudgetError) throw new HttpError(503, `Nothing was sent: ${err.message}.`);
      if (err instanceof InferenceError) {
        log(`speech: ${spec.model} failed: ${oneLine(err.message, 300)}`);
        throw new HttpError(err.status === 429 ? 429 : 502, `The speech call failed: ${err.message}.`);
      }
      throw err;
    } finally {
      speechBusy = false;
    }
    const today = spend.speechToday();
    log(`speech: ${spec.model}, voice ${spec.voice ?? '(the default)'}, ${spec.format}, ${spec.input.length} characters → ${out.seconds ?? '?'} s billed, `
      + `$${out.usd ?? '?'} (${out.usdFrom}); speech today $${today.usd} of $${SPEECH.dayUsd}`);
    if (c.res.destroyed) return;
    c.res.writeHead(200, headers({
      'content-type': out.contentType, 'content-length': out.audio.length, 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="speech.${out.format}"`,
      'x-ring-speech-model': spec.model, 'x-ring-speech-voice': spec.voice ?? 'default', 'x-ring-speech-format': out.format,
      'x-ring-speech-chars': String(spec.input.length), 'x-ring-speech-seconds': String(out.seconds ?? ''),
      'x-ring-speech-usd': String(out.usd ?? ''), 'x-ring-speech-usd-from': out.usdFrom, 'x-ring-speech-today-usd': String(today.usd),
    }));
    c.res.end(out.audio);
  }

  /**
   * Run one test suite with no task running (§4.3): an exclusive queue lock, then the suite as a child
   * process with childEnv only (no API key at all), its output streamed back as text. 20 minutes at most.
   * Each call is on the self-test list from the moment it arrives until it ends, so /admin/busy and the
   * held runs see every self-test that waits or runs, also when two calls overlap.
   */
  async function adminSelftest(c) {
    const body = await readJson(c.req);
    const suite = body.suite;
    if (!SELFTEST_SUITES.includes(suite)) throw new HttpError(400, `suite must be one of: ${SELFTEST_SUITES.join(', ')}.`);
    const file = path.join(selftestDir, `${suite}.mjs`);
    if (!existsSync(file)) throw new HttpError(404, `test/${suite}.mjs is not deployed.`);
    const res = c.res;
    res.writeHead(200, headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }));
    res.on('error', () => {});
    const say = (text) => { if (!res.writableEnded && !res.destroyed) res.write(text); };
    say(`selftest ${suite}: waiting until no task is running (new tasks wait too)\n`);
    const me = { suite, running: false };
    selftests.push(me);
    // Off the list before release(), whose 'change' then tells the runs in line that the hold is over.
    const leave = () => {
      const i = selftests.indexOf(me);
      if (i >= 0) selftests.splice(i, 1);
    };
    const turn = queue.pauseForExclusive();   // from here on, no waiting task starts
    announcePositions();                      // the runs in line learn that a self-test holds it
    const release = await turn;
    if (res.destroyed) {
      leave();
      release();
      log(`selftest ${suite}: the caller left before it started; not run`);
      return;
    }
    me.running = true;
    log(`selftest ${suite}: started`);
    say(`selftest ${suite}: started, runtime ${RUNTIME ?? 'runc'}\n`);
    let finished = false, killTimer = null;
    const child = spawn(process.execPath, [file], { cwd: os.homedir(), env: childEnv({ RING_RUNTIME: RUNTIME }), stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      say(`\nselftest ${suite}: still running after 20 minutes; stopping it\n`);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, SELFTEST_TIMEOUT_MS);
    const finish = (how) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      leave();
      release();
      log(`selftest ${suite}: ${how}`);
      say(`\nselftest ${suite}: ${how}\n`);
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    child.stdout.setEncoding('utf8').on('data', say);
    child.stderr.setEncoding('utf8').on('data', say);
    child.on('error', (err) => finish(`could not start: ${oneLine(err)}`));
    child.on('close', (code, signal) => finish(`exit ${code ?? signal}`));
  }

  // --- routing ---------------------------------------------------------------------------------
  const ID = 't_[0-9a-f]{32}';
  const PUBLIC = [
    ['GET', new RegExp(`^/(?:t/${ID})?$`), (c) => sendPublicFile(c.res, 'index.html')],
    ['GET', /^\/(app\.js|app\.css|favicon\.svg)$/, (c) => sendPublicFile(c.res, c.m[1])],
    ['GET', /^\/status$/, async (c) => sendHtml(c.res, status.statusHtml(await statusNow()))],
    ['GET', /^\/status\.json$/, async (c) => sendJson(c.res, 200, await statusNow())],
    ['GET', /^\/api\/config$/, (c) => {
      const cfg = config.get();
      const etaText = stats.count('sample') >= MIN_ETA_RUNS ? `about ${Math.max(1, Math.round(stats.median('sample') / 60))} min` : 'a few minutes';
      sendJson(c.res, 200, {
        publicSampleRuns: cfg.publicSampleRuns === true, publicGithubRuns: cfg.publicGithubRuns === true,
        provider: PROVIDER, fixModel: cfg.fixModel, visionModel: cfg.visionModel,
        // The samples a public run may use: an admin-only one (Atlas) is never listed.
        samples: Object.entries(SAMPLES).filter(([id]) => isPublicSample(id)).map(([id, s]) => ({ id, label: s.label, etaText })),
        githubWallClockSec: githubWallClockSec(cfg.caps),   // the longest a GitHub run may take once it starts
        latest: readLatest(),   // null until a run is published
      });
    }],
    ['POST', /^\/api\/tasks$/, createPublicTask],
    ['GET', new RegExp(`^/api/tasks/(${ID})$`), (c) => sendJson(c.res, 200, publicView(taskOr404(c.m[1]), { full: true }))],
    ['GET', new RegExp(`^/api/tasks/(${ID})/events$`), streamEvents],
    ['GET', new RegExp(`^/api/tasks/(${ID})/files/([a-z0-9-]+\\.png)$`), (c) => {
      const rec = taskOr404(c.m[1]);
      if (!TASK_IMAGE.test(c.m[2]) || store.size(rec.id, c.m[2]) > 20 * 2 ** 20) throw new HttpError(404, SAY.notFound);
      sendTaskFile(c, rec.id, c.m[2], 'image/png', { 'cache-control': 'private, max-age=3600' });
    }],
    ['POST', new RegExp(`^/api/tasks/(${ID})/approve$`), approveTask],
    ['GET', new RegExp(`^/api/tasks/(${ID})/patch$`), downloadPatch],
    ['POST', new RegExp(`^/api/tasks/(${ID})/cancel$`), cancelOwnTask],
  ];
  const ADMIN = [
    ['GET', /^\/admin\/health$/, adminHealth],
    // For deploy.sh: no Docker calls, so it answers at once even while looks keep the CPUs busy. `selftest`
    // is the suite that runs, else the first that waits (null when none), and selftestsWaiting counts those waiting.
    ['GET', /^\/admin\/busy$/, (c) => sendJson(c.res, 200, {
      running: queue.running().length, queued: queue.queued().length, selftest: selftestNow(), selftestsWaiting: selftests.filter((s) => !s.running).length,
    })],
    ['GET', /^\/admin\/tasks$/, adminList],
    ['POST', /^\/admin\/tasks$/, adminCreate],
    ['GET', new RegExp(`^/admin/tasks/(${ID})$`), adminGet],
    ['GET', new RegExp(`^/admin/tasks/(${ID})/transcript$`), adminTranscript],
    ['GET', new RegExp(`^/admin/tasks/(${ID})/bundle$`), adminBundle],
    ['POST', new RegExp(`^/admin/tasks/(${ID})/cancel$`), adminCancel],
    ['POST', new RegExp(`^/admin/publish/(${ID})$`), adminPublish],
    ['POST', /^\/admin\/probe$/, adminProbe],
    ['GET', /^\/admin\/config$/, (c) => sendJson(c.res, 200, config.get())],
    ['POST', /^\/admin\/config$/, adminSetConfig],
    ['GET', /^\/admin\/spend$/, adminSpend],
    ['POST', /^\/admin\/selftest$/, adminSelftest],
    ['POST', /^\/admin\/speech$/, adminSpeech],
  ];

  function dispatch(routes, c) {
    let allow = null;
    for (const [method, re, fn] of routes) {
      const m = re.exec(c.path);
      if (!m) continue;
      if (method === c.method) { c.m = m; return fn(c); }
      allow = allow ? `${allow}, ${method}` : method;
    }
    if (allow) return sendError(c.res, 405, 'That method is not allowed here.', { allow });
    return sendNotFound(c);
  }

  // Pages a person may type with a trailing slash: /status/ and /t/<id>/ redirect to the page.
  const SLASHED_PAGE = new RegExp(`^/(?:status|t/${ID})/+$`);

  async function handle(req, res) {
    const raw = req.url ?? '';
    let url = null;
    // Parsed against a fixed origin, so "//host/x" stays a path and never becomes a host name.
    if (raw.startsWith('/')) url = URL.parse(`http://ring.invalid${raw}`);
    if (!url) return sendError(res, 400, 'That address is not valid.');
    const c = { req, res, url, path: url.pathname, method: req.method === 'HEAD' ? 'GET' : req.method, admin: isAdmin(req), m: null };
    if (c.path === '/admin' || c.path.startsWith('/admin/')) {
      if (!c.admin) return sendNotFound(c);   // exactly what an unknown path gets
      return dispatch(ADMIN, c);
    }
    if (c.method === 'GET' && SLASHED_PAGE.test(c.path)) {
      res.writeHead(308, headers({ location: `${c.path.replace(/\/+$/, '')}${url.search}`, 'cache-control': 'no-store', 'content-length': 0 }));
      res.end();
      return undefined;
    }
    return dispatch(PUBLIC, c);
  }

  function failed(req, res, err) {
    if (err instanceof HttpError) {
      if (res.headersSent) { res.destroy(); return; }
      sendError(res, err.status, err.message, err.headers);
      return;
    }
    log(`request ${req.method} ${oneLine(req.url, 120)} failed: ${oneLine(err?.stack ?? err, 400)}`);
    if (res.headersSent) { res.destroy(); return; }
    sendError(res, 500, sentence('internal'));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => failed(req, res, err));
  });
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 126_000;

  /**
   * Stop taking work, interrupt waiting tasks, abort running ones (each loop destroys its own sandbox)
   * and wait up to `waitMs` for them, then close every connection.
   */
  function close({ waitMs = 15_000 } = {}) {
    closing ??= (async () => {
      for (const id of queue.abortAll('shutdown')) endTask(id, { state: 'interrupted', error: INTERRUPTED });
      for (const res of [...streams]) if (!res.writableEnded && !res.destroyed) res.end();
      server.close();
      server.closeIdleConnections();
      await Promise.race([queue.idle(), delay(waitMs)]);
      server.closeAllConnections();
    })();
    return closing;
  }

  return { server, close, store, queue };
}

// ---------------------------------------------------------------------------------------------
// Running as the service (§4.10)
// ---------------------------------------------------------------------------------------------
async function optional(spec, log) {
  try {
    return await import(spec);
  } catch (err) {
    log(`startup: ${spec} not loaded: ${oneLine(err, 300)}`);
    return null;
  }
}

async function removeAppSandboxes(when, log) {
  try {
    const n = await Sandbox.removeAll(APP_LABEL);
    log(`${when}: removed ${n.containers} sandbox container(s) and ${n.networks} sandbox network(s) labelled ${APP_LABEL}`);
  } catch (err) {
    log(`${when}: could not remove the app's sandboxes: ${oneLine(err, 300)}`);
  }
}

/**
 * Orphans, the app's or a stopped self-test's, Mantis Ring's own only (by label): sandbox containers
 * older than STALE_SANDBOX_MS, which no task and no self-test lives to (a `docker run` that gave up
 * while the daemon still made the container, a self-test killed with SIGKILL), then sandbox networks
 * that no sandbox runs on and that are older than STALE_NETWORK_MS, so a sandbox that is starting
 * keeps its network. Each network would otherwise hold one of Docker's address pools.
 */
async function removeStaleSandboxes(when, log) {
  try {
    const n = await Sandbox.removeStale(STALE_SANDBOX_MS);
    if (n.containers || n.networks) log(`${when}: removed ${n.containers} sandbox container(s) older than ${STALE_SANDBOX_MS / 60_000} minutes and ${n.networks} sandbox network(s) that no sandbox runs on`);
  } catch (err) {
    log(`${when}: could not remove stale sandboxes: ${oneLine(err, 300)}`);
  }
}

async function main() {
  const log = (line) => console.log(oneLine(line, 1000));
  const fatal = (what) => (err) => {
    console.error(`fatal: ${what}: ${oneLine(err?.stack ?? err, 800)}`);
    process.exit(1);   // systemd restarts the app after 3 s; startup removes orphan sandboxes
  };
  process.on('uncaughtException', fatal('uncaught exception'));
  process.on('unhandledRejection', fatal('unhandled rejection'));

  // 1. Sandboxes and their networks left by a crash or a restart: the app's label only, never a
  // running self-test's container (§0.5 #9); then orphans, sandboxes too old to belong to any task or
  // self-test, and any sandbox network that no sandbox runs on.
  await removeAppSandboxes('startup', log);
  await removeStaleSandboxes('startup', log);
  // 2. Tasks that a previous process left queued or running.
  const store = new TaskStore({ dir: path.join(STATE_DIR, 'tasks'), log });
  const interrupted = store.load();
  if (interrupted.length) log(`startup: ${interrupted.length} task(s) left by the previous process are now interrupted`);
  const pruned = store.prune();
  if (pruned) log(`startup: removed ${pruned} task(s) past retention`);
  // 3. Settings and the spend ledger.
  const cfg = configModule.get();
  let spend = null;
  try {
    spend = new Spend({ dir: STATE_DIR, caps: cfg.spendCaps, log });
  } catch (err) {
    log(`startup: the spend ledger is not loaded, so no run can start: ${oneLine(err)}`);
  }
  // Parts built later tonight. The app serves its pages without them; runs fail with a plain sentence.
  const loop = await optional('../agent/loop.mjs', log);
  const probe = await optional('../agent/probe.mjs', log);
  const visionModule = await optional('../agent/vision.mjs', log);
  // 4. Can the service user drive Docker?
  log(await statusModule.dockerVersionLine());
  // /latest/ before the first publish: a page that says so and links on, instead of a bare line.
  try {
    log(`startup: /latest/ placeholder ${refreshPlaceholder(PUBLIC_DIR)}`);
  } catch (err) {
    log(`startup: the /latest/ placeholder was not updated: ${oneLine(err, 200)}`);
  }
  // The owner's approval passphrase (its SHA-256, from the service's environment). Never logged.
  const approveHash = String(process.env.RING_APPROVE_PASSPHRASE_SHA256 ?? '').trim();
  const approval = { passphraseSha256: /^[0-9a-f]{64}$/i.test(approveHash) ? approveHash : null };
  if (approveHash && !approval.passphraseSha256) log('startup: RING_APPROVE_PASSPHRASE_SHA256 is not 64 hex digits, so it is ignored');
  log(`startup: approval ${approval.passphraseSha256
    ? 'needs the owner link and the approval passphrase for admin runs and published runs; a public run that was never published needs only its owner link'
    : 'needs the owner link only (no approval passphrase is set)'}`);

  const app = createApp({
    config: configModule, store, spend, log, approval,
    queue: new Queue({ maxRunning: cfg.maxRunning, heavySlots: HEAVY_SLOTS, maxQueued: MAX_QUEUED, log }),
    runFix: typeof loop?.runFix === 'function' ? loop.runFix : null,
    publish: publishLatest, status: statusModule, now: Date.now,
    probe: typeof probe?.probeAll === 'function' ? probe : null,
    vision: typeof visionModule?.visionCheck === 'function' ? visionModule.visionCheck : null,
  });
  // 5. Listen.
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  app.server.on('error', fatal('listen'));
  app.server.listen(port, host, () => {
    log(`listening on http://${host}:${app.server.address().port} · runtime ${RUNTIME ?? 'runc (docker default)'} · public runs: sample ${cfg.publicSampleRuns}, GitHub ${cfg.publicGithubRuns} · agent loop ${loop?.runFix ? 'loaded' : 'not installed'}`);
  });
  setInterval(() => {
    const n = store.prune();
    if (n) log(`retention: removed ${n} task(s)`);
    removeStaleSandboxes('retention', log);
  }, 3_600_000).unref();

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`shutdown: ${signal}; interrupting tasks and removing their sandboxes`);
    setTimeout(() => { log('shutdown: not finished after 19 s; exiting anyway'); process.exit(0); }, 19_000).unref();
    try {
      await app.close();
      await removeAppSandboxes('shutdown', log);
    } catch (err) {
      log(`shutdown: ${oneLine(err)}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`fatal: startup failed: ${oneLine(err?.stack ?? err, 800)}`);
    process.exit(1);
  });
}
