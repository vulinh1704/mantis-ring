#!/usr/bin/env node
// Tests for the web app's HTTP API (build spec §4, §6.1 A1-A6) with no Docker and no model: the real
// createApp() with its real config, task store, queue and spend ledger in a temporary state folder,
// and a fake runFix that finishes (or waits) on command. It checks the routes, the local-admin rule
// D-4 (loopback peer, no X-Forwarded-For, loopback Host), D-5 (public runs closed), the per-IP and
// queue limits, approve/patch with the owner token, and SSE replay, and POST /admin/speech (the video's
// voice: admin only, its text and cost caps, the ledger line) with scripts/ring.sh tts, what
// scripts/ring.sh mem sends (scripts/vm-mem.sh, the VM's memory, read-only), POST /admin/selftest on
// stand-in suites (/admin/busy, and the runs a self-test holds), and scripts/ring.sh selftest with the
// --selftest step, the second busy check and the outside checks of scripts/deploy.sh, against
// stand-ins for ssh and the site. /status and the speech calls talk to test/fake-gateway.mjs, never to
// the real inference service. Each check prints PASS or FAIL.
// Usage: node test/app-api.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_KEY, httpError, sleep, startFakeGateway, wavBytes } from './fake-gateway.mjs';

const results = [];
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${oneLine(detail)})` : ''}`); };
const skip = (name, why) => console.log(`SKIP  ${name}  (${why})`);
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

const PUBLIC_HOST = '104-156-252-200.sslip.io';
/** Headers Caddy sends for a visitor: the public Host and the client address in X-Forwarded-For. */
const viaCaddy = (ip) => ({ host: PUBLIC_HOST, 'x-forwarded-for': ip });
const JSON_TYPE = { 'content-type': 'application/json' };
const PATCH = 'diff --git a/styles.css b/styles.css\n--- a/styles.css\n+++ b/styles.css\n@@ -87 +87 @@\n-  width: 600px; \n+  max-width: 600px;\n';
// The smallest valid PNG (1x1), stored as the task's proof.png.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// The owner's approval passphrase in these tests. The server only ever holds its SHA-256.
const PASSPHRASE = 'ring test passphrase';
const approvalCfg = { passphraseSha256: createHash('sha256').update(PASSPHRASE).digest('hex') };

// Fake model service and a throwaway state folder, set before any app module is imported.
const gw = await startFakeGateway([]);
const stateDir = await mkdtemp(path.join(os.tmpdir(), 'ring-app-api-'));
process.env.VULTR_INFERENCE_URL = `${gw.url}/v1`;
process.env.VULTR_INFERENCE_API_KEY = FAKE_KEY;
process.env.RING_STATE_DIR = path.join(stateDir, 'state');
process.env.RING_PUBLIC_DIR = path.join(stateDir, 'public');

/**
 * Stands in for agent/loop.mjs. 'instant' finishes at once with a TEST RUN receipt and a patch;
 * 'block' waits until releaseAll() or the task's abort signal, so tests can fill the queue.
 */
const fake = {
  mode: 'instant',
  seen: [],
  waiting: new Set(),
  async runFix(task, deps) {
    fake.seen.push(JSON.parse(JSON.stringify(task)));
    deps.emit('step', { step: 'clone', status: 'start' });
    deps.emit('log', { text: 'fake runFix: no sandbox in the app-api test' });
    deps.emit('step', { step: 'clone', status: 'done', ms: 1 });
    if (fake.mode === 'block') {
      await new Promise((resolve) => {
        const done = () => { fake.waiting.delete(done); resolve(); };
        fake.waiting.add(done);
        deps.signal?.addEventListener('abort', done, { once: true });
      });
      if (deps.signal?.aborted) {
        deps.emit('done', { status: 'cancelled' });
        return { status: 'cancelled', receipt: null };
      }
    }
    const receipt = fakeReceipt(task);
    await deps.store.put('patch.diff', PATCH);
    await deps.store.put('proof.png', TINY_PNG);
    await deps.store.put('receipt.json', JSON.stringify(receipt, null, 2));
    deps.emit('receipt', { line: receipt.line, verdict: receipt.verdict, fixed: 1, new: 0, coverUps: 0, lost: 0, usd: receipt.usd, tokens: receipt.tokens, seconds: 1, patchBytes: Buffer.byteLength(PATCH) });
    deps.emit('done', { status: 'done' });
    return { status: 'done', receipt };
  },
  releaseAll() {
    for (const done of [...fake.waiting]) done();
  },
};

/** A TEST RUN receipt (§3.3) with one fix and a non-empty patch; never publishable. */
function fakeReceipt(task) {
  return {
    schema: 'mantis-ring/receipt@1', taskId: task.id, label: 'TEST RUN · runc · 127.0.0.1',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    source: { kind: task.source?.kind ?? 'sample', name: task.source?.name ?? 'lumen', commit: null },
    matrix: { ...task.matrix, cells: 16 },
    line: '1 fixed · 0 new · 0 cover-ups · 0 lost',
    counts: { errorsBefore: 14, errorsAfter: 13, warningsBefore: 4, warningsAfter: 4, fixed: 1, new: 0, coverUps: 0, lost: 0, cellsCompared: 16 },
    fixed: [{ type: 'page-overflow', route: '/', selector: '#promo-banner', cells: ['mobile/light/en'] }], new: [],
    gate: { enabled: task.gate !== false, coverUpAttempts: 0, tamperAttempts: 0, reverts: 0 },
    checks: [{ check: 1, decision: 'accepted', line: '1 fixed · 0 new · 0 cover-ups · 0 lost', runId: '2026-11-04T05-01-00', ms: 1000, forced: false }],
    stopReason: 'finish',
    models: [{ role: 'fix', id: task.model, provider: 'Vultr Serverless Inference', calls: 1, promptTokens: 100, completionTokens: 10, reasoningTokens: 0, usd: 0.00002, price: { promptPer1M: 0.15, completionPer1M: 0.6, source: 'catalog list price, 2026-11-04' } }],
    tokens: { prompt: 100, completion: 10, reasoning: 0 }, usd: 0.00002, turns: 1, toolCalls: 1, invalidToolCalls: 0,
    time: { totalSec: 1, phases: { sandbox: 0, clone: 0, install: 0, serve: 0, baseline: 0, model: 0, tools: 0, checks: 0, verify: 0, proof: 0, copyOut: 0, destroy: 0, vision: 0 } },
    diff: { files: 1, insertions: 1, deletions: 1, bytes: Buffer.byteLength(PATCH), sha256: null, applies: true },
    vision: { model: null, verdict: 'skipped', agree: 0, pairs: [] },
    summary: { text: 'Fake run.', note: "the model's own words, not measured" },
    containment: { runtime: 'runc', sandbox: 'ring-00000000', limits: { memory: '4g', cpus: '2', pids: 512 }, network: 'ring-internal → ring-proxy (allowlist)', destroyed: true, goneCheck: 'docker ps -a: gone' },
    mantis: { version: '0.7.1', baselineRunId: '2026-11-04T05-00-00', finalRunId: '2026-11-04T05-01-00', comparedWith: 'baseline run (R0)' },
    verdict: 'pass', publishable: false, promptVersion: 'ring-2', promptVariant: task.promptVariant ?? 'neutral',
  };
}

const published = [];
/** Publishing must never be reached in these tests (every receipt is a TEST RUN); calls are recorded. */
async function fakePublish(o) {
  published.push(o?.task?.id ?? '?');
  return { dir: path.join(stateDir, 'public', 'never'), url: '/latest/' };
}

let port = 0;
/**
 * One HTTP request to the app with full control of the headers (fetch cannot set Host).
 * `via` sends it to another listener ({host, port}) instead of the app's own 127.0.0.1 port.
 */
function request(method, urlPath, { headers = {}, body, via } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const target = via ?? { host: '127.0.0.1', port };
    const req = http.request({
      host: target.host, port: target.port, method, path: urlPath, agent: false,
      headers: { ...(data ? { 'content-length': data.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json, buf });
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error(`${method} ${urlPath}: no answer within 15 s`)));
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}
const admin = (method, p, o = {}) => request(method, p, { ...o, headers: { ...(o.body !== undefined ? JSON_TYPE : {}), ...o.headers } });
const visitor = (ip, method, p, o = {}) => request(method, p, { ...o, headers: { ...viaCaddy(ip), ...(o.body !== undefined ? JSON_TYPE : {}), ...o.headers } });

/** An error answer in the app's shape: {error: one sentence, more: '/latest/'}, no stack trace. */
const plainError = (r) => typeof r.json?.error === 'string' && r.json.error.length > 0 && r.json.more === '/latest/' && !/\n\s+at\s/.test(r.text);
const recordOf = (j) => (j && typeof j === 'object' ? j.task ?? j : null);

/** Wait until the task is no longer queued or running (admin view). Returns the last state. */
async function settle(id, ms = 10_000) {
  const end = Date.now() + ms;
  let state = 'unknown';
  while (Date.now() < end) {
    const r = await admin('GET', `/admin/tasks/${id}`);
    state = recordOf(r.json)?.state ?? `http ${r.status}`;
    if (!['queued', 'running'].includes(state)) return state;
    await wait(50);
  }
  return state;
}

/** Read an SSE stream until a `done` event or `ms`; returns the parsed frames and the response headers. */
function readSse(urlPath, headers, ms = 5000) {
  return new Promise((resolve, reject) => {
    const frames = [];
    let buf = '';
    let raw = '';
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, agent: false, headers }, (res) => {
      const finish = () => { clearTimeout(timer); req.destroy(); resolve({ status: res.statusCode, headers: res.headers, frames, raw }); };
      const timer = setTimeout(finish, ms);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        buf += chunk;
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const f = {};
          for (const line of block.split('\n')) {
            const m = /^(id|event|data|retry): ?(.*)$/.exec(line);
            if (m) f[m[1]] = m[2];
          }
          if (f.event || f.data) frames.push(f);
          if (f.event === 'done') return finish();
        }
      });
      res.on('end', finish);
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve({ status: 0, headers: {}, frames, raw }) : reject(err)));
    req.end();
  });
}

/** A local IPv4 address that is not loopback, to show that a non-loopback peer is never admin. */
function nonLoopbackAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

let app = null;
const journal = []; // the app's own log lines, shown only when a check fails
try {
  const { createApp } = await import('../app/server.mjs');
  const config = await import('../app/config.mjs');
  const tasksMod = await import('../app/tasks.mjs');
  const { Spend } = await import('../app/spend.mjs');
  const status = await import('../app/status.mjs');
  const log = (line) => { journal.push(String(line)); };
  const store = new tasksMod.TaskStore({ dir: path.join(config.STATE_DIR, 'tasks'), log });
  const queue = new tasksMod.Queue({ maxRunning: 2, heavySlots: 2, maxQueued: 8, log });
  const spend = new Spend({ dir: config.STATE_DIR, caps: config.get().spendCaps, log });
  // Stand-ins for the suites that POST /admin/selftest runs (no Docker here): each writes <suite>.started,
  // waits until <suite>.go exists (10 s at most) and passes, so a test decides when a self-test ends.
  const selftestDir = path.join(stateDir, 'selftest-suites');
  await mkdir(selftestDir, { recursive: true });
  for (const s of ['agent-loop', 'containment', 'scenes']) {
    const mark = (what) => JSON.stringify(path.join(selftestDir, `${s}.${what}`));
    await writeFile(path.join(selftestDir, `${s}.mjs`), `import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${mark('started')}, '');
const end = Date.now() + 10_000;
while (!existsSync(${mark('go')}) && Date.now() < end) await new Promise((ok) => setTimeout(ok, 20));
console.log('1/1 ${s} checks passed');
`);
  }
  app = createApp({ config, store, queue, spend, runFix: fake.runFix, publish: fakePublish, status, now: Date.now, log, approval: approvalCfg, selftestDir });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
  });
  port = app.server.address().port;
  console.log(`app-api tests · app on 127.0.0.1:${port} · state in ${stateDir}`);

  // --- Routes ------------------------------------------------------------------------------------
  const home = await visitor('203.0.113.1', 'GET', '/');
  const csp = String(home.headers['content-security-policy'] ?? '');
  check('GET / is the HTML page with the CSP of §4.2', home.status === 200 && /text\/html/.test(home.headers['content-type'] ?? '')
    && ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"].every((d) => csp.includes(d)),
    `${home.status} ${home.headers['content-type']}; CSP: ${csp || 'none'}`);
  const taskPage = await visitor('203.0.113.1', 'GET', `/t/t_${'0'.repeat(32)}`);
  check('GET /t/:id serves the same page (rendered client-side)', taskPage.status === 200 && /text\/html/.test(taskPage.headers['content-type'] ?? ''), `${taskPage.status}`);
  const types = { '/app.js': 'text/javascript; charset=utf-8', '/app.css': 'text/css; charset=utf-8', '/favicon.svg': 'image/svg+xml' };
  const wrongTypes = [];
  for (const [p, want] of Object.entries(types)) {
    const r = await visitor('203.0.113.1', 'GET', p);
    if (r.status !== 200 || r.headers['content-type'] !== want) wrongTypes.push(`${p}: ${r.status} ${r.headers['content-type']}`);
  }
  check('static files have exact MIME types (app.js, app.css, favicon.svg)', wrongTypes.length === 0, wrongTypes.join('; ') || 'all exact');
  const appJs = (await visitor('203.0.113.1', 'GET', '/app.js')).text;
  check('the home page keeps the GitHub row hidden until its switch opens; app.js reads publicSampleRuns and publicGithubRuns, never publicRuns',
    /<li id="repo-try" hidden>/.test(home.text) && /cfg\.publicSampleRuns === true/.test(appJs) && /cfg\.publicGithubRuns === true/.test(appJs) && !/\bpublicRuns\b/.test(appJs),
    `row hidden: ${/<li id="repo-try" hidden>/.test(home.text)}; app.js mentions publicRuns: ${/\bpublicRuns\b/.test(appJs)}`);
  check('the GitHub row names no fixed run time: app.js fills it from /api/config (githubWallClockSec)',
    !/\d+\s*minutes/.test(home.text) && /id="repo-note"/.test(home.text) && /cfg\.githubWallClockSec/.test(appJs),
    `minutes in index.html: ${/\d+\s*minutes/.exec(home.text)?.[0] ?? 'none'}; app.js reads githubWallClockSec: ${/cfg\.githubWallClockSec/.test(appJs)}`);
  const st = await visitor('203.0.113.1', 'GET', '/status');
  const stj = await visitor('203.0.113.1', 'GET', '/status.json');
  check('GET /status (HTML) and /status.json answer; neither shows the key or the environment',
    st.status === 200 && /text\/html/.test(st.headers['content-type'] ?? '') && stj.status === 200 && stj.json && typeof stj.json === 'object'
      && ![st.text, stj.text].some((t) => t.includes(FAKE_KEY) || t.includes('VULTR_INFERENCE') || t.includes('RING_STATE_DIR')),
    `${st.status} / ${stj.status}; ok=${stj.json?.ok}; inference reachable=${stj.json?.inference?.reachable}`);
  const cfg = await visitor('203.0.113.1', 'GET', '/api/config');
  check('GET /api/config: provider, models, samples, and both public switches false (publicSampleRuns, publicGithubRuns; no old publicRuns)',
    cfg.status === 200 && cfg.json?.provider === 'Vultr Serverless Inference' && typeof cfg.json?.fixModel === 'string'
      && cfg.json?.publicSampleRuns === false && cfg.json?.publicGithubRuns === false && !('publicRuns' in (cfg.json ?? {}))
      && Array.isArray(cfg.json?.samples) && cfg.json.samples.some((s) => s.id === 'lumen' && typeof s.label === 'string' && typeof s.etaText === 'string'),
    oneLine(cfg.text));
  check('/status.json and /status show both public switches closed',
    stj.json?.publicSampleRuns === false && stj.json?.publicGithubRuns === false && !('publicRuns' in (stj.json ?? {}))
      && /Public runs, sample<\/dt><dd><span class="muted">not open yet/.test(st.text) && /Public runs, GitHub repositories<\/dt><dd><span class="muted">not open yet/.test(st.text),
    `status.json: sample ${stj.json?.publicSampleRuns}, GitHub ${stj.json?.publicGithubRuns}`);
  const unknown = await visitor('203.0.113.1', 'GET', `/api/tasks/t_${'f'.repeat(32)}`);
  const badId = await visitor('203.0.113.1', 'GET', '/api/tasks/..%2F..%2Fetc%2Fpasswd');
  check('unknown or malformed task ids give 404 with {error, more:"/latest/"}', unknown.status === 404 && plainError(unknown) && badId.status === 404,
    `${unknown.status} ${oneLine(unknown.text)}; malformed: ${badId.status}`);

  // --- A1 / D-4: who is admin ---------------------------------------------------------------------
  const health = await admin('GET', '/admin/health');
  check('A1 /admin/health from loopback, no XFF, Host 127.0.0.1:<port> → 200', health.status === 200 && health.json && 'running' in health.json && 'queued' in health.json, `${health.status} ${oneLine(health.text)}`);
  const local = await admin('GET', '/admin/health', { headers: { host: 'localhost:8080' } });
  check('A1 Host localhost:<port> is also admin (an ssh -L forward)', local.status === 200, `${local.status}`);
  const withXff = await admin('GET', '/admin/health', { headers: { 'x-forwarded-for': '203.0.113.7' } });
  check('A1 /admin/health with an X-Forwarded-For header → 404', withXff.status === 404, `${withXff.status}`);
  const publicHost = await admin('GET', '/admin/health', { headers: { host: PUBLIC_HOST } });
  check('A1 /admin/health with a public Host and no XFF → 404 (D-4 Host rule)', publicHost.status === 404, `${publicHost.status}`);
  const ip = nonLoopbackAddress();
  if (!ip) {
    skip('A1 /admin/health from a non-loopback peer → 404', 'this machine has no non-loopback IPv4 address');
  } else {
    // A side door on a non-loopback address that hands its connections to the app's own server.
    const side = net.createServer((sock) => app.server.emit('connection', sock));
    await new Promise((resolve, reject) => { side.once('error', reject); side.listen(0, ip, resolve); });
    try {
      const r = await request('GET', '/admin/health', { via: { host: ip, port: side.address().port }, headers: { host: `127.0.0.1:${port}` } });
      check('A1 /admin/health from a non-loopback peer (no XFF, loopback Host) → 404', r.status === 404, `peer ${ip}: ${r.status}`);
      const sideSpeech = await request('POST', '/admin/speech', {
        via: { host: ip, port: side.address().port }, headers: { host: `127.0.0.1:${port}`, ...JSON_TYPE }, body: { model: 'fake-speech', input: 'Hello from outside.' },
      });
      check('A1 POST /admin/speech from a non-loopback peer (no XFF, loopback Host) → 404, and nothing reaches the speech service',
        sideSpeech.status === 404 && gw.speeches().length === 0, `peer ${ip}: ${sideSpeech.status}; ${gw.speeches().length} speech requests`);
    } finally {
      await new Promise((resolve) => side.close(resolve));
    }
  }
  const before = await admin('GET', '/admin/tasks');
  const listOf = (r) => (Array.isArray(r.json) ? r.json : r.json?.tasks ?? []);
  const countBefore = listOf(before).length;
  const hidden = [];
  const adminRoutes = [['GET', '/admin/config'], ['GET', '/admin/tasks'], ['GET', '/admin/spend'], ['POST', '/admin/tasks', { sample: 'lumen' }],
    ['POST', '/admin/config', { publicSampleRuns: true, publicGithubRuns: true }], ['POST', '/admin/selftest', { suite: 'agent-loop' }], ['POST', '/admin/probe', { models: ['fake-coder'] }],
    ['POST', '/admin/speech', { model: 'fake-speech', input: 'Hello from the internet.' }]];
  for (const [method, p, body] of adminRoutes) {
    const r = await visitor('203.0.113.7', method, p, body === undefined ? {} : { body });
    if (r.status !== 404) hidden.push(`${method} ${p}: ${r.status}`);
  }
  const after = await admin('GET', '/admin/tasks');
  const cfgAfter = await admin('GET', '/admin/config');
  check('A1 every /admin/* route answers 404 through Caddy and changes nothing (no model call, no speech call)',
    hidden.length === 0 && listOf(after).length === countBefore && cfgAfter.json?.publicSampleRuns === false && cfgAfter.json?.publicGithubRuns === false
      && gw.chats().length === 0 && gw.speeches().length === 0,
    hidden.join('; ') || `${adminRoutes.length} routes hidden; tasks ${countBefore} → ${listOf(after).length}; public switches ${cfgAfter.json?.publicSampleRuns}/${cfgAfter.json?.publicGithubRuns}`);

  // --- A2 / D-5: public runs are closed --------------------------------------------------------------
  const closed = await visitor('203.0.113.8', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  const closedRepo = await visitor('203.0.113.8', 'POST', '/api/tasks', { body: { repo: 'https://github.com/vitejs/vite' } });
  const afterClosed = listOf(await admin('GET', '/admin/tasks')).length;
  check('A2 POST /api/tasks answers 503 with a sentence while both public switches are closed, for the sample and for a repository, and starts nothing',
    closed.status === 503 && plainError(closed) && /open/i.test(closed.json?.error ?? '') && closedRepo.status === 503 && closedRepo.json?.error === closed.json?.error
      && afterClosed === countBefore && fake.seen.length === 0,
    `${closed.status} ${oneLine(closed.text)}; repository ${closedRepo.status}`);

  // --- An admin task through the fake loop -----------------------------------------------------------
  const created = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', gate: false, label: 'app-api test' } });
  const id = created.json?.id;
  const token = created.json?.ownerToken;
  const linkOk = created.json?.ownerLink === `https://${PUBLIC_HOST}/t/${id}#owner=${token}`;
  check('POST /admin/tasks → 202 with id, ownerToken and the owner link',
    created.status === 202 && /^t_[0-9a-f]{32}$/.test(id ?? '') && typeof token === 'string' && token.length >= 32 && linkOk,
    created.status === 202 ? `id ${id}, position ${created.json?.position}, owner link ${linkOk ? 'as specified' : 'differs'}` : `${created.status} ${oneLine(created.json?.error)}`);
  const state = id ? await settle(id) : 'no task';
  const seen = fake.seen.find((t) => t.id === id);
  const cells = seen ? seen.matrix.routes.length * seen.matrix.viewports.length * seen.matrix.schemes.length * seen.matrix.locales.length : 0;
  check('the admin task ran: done, gate off as asked, Lumen with 16 cells', state === 'done' && seen?.gate === false && seen?.source?.kind === 'sample' && cells === 16,
    `state ${state}; gate ${seen?.gate}; ${cells} cells; model ${seen?.model}`);
  const overCap = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', caps: { maxUsd: 5 } } });
  const badModel = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', model: 'not-a-listed-model' } });
  check('admin tasks are validated: maxUsd over $2 and a model outside allowedModels → 400', overCap.status === 400 && badModel.status === 400 && plainError(overCap),
    `${overCap.status} ${oneLine(overCap.json?.error)}; ${badModel.status} ${oneLine(badModel.json?.error)}`);

  // The bench's pressure arm, admin only: the loop gets promptVariant pressure, and the run says so.
  const pressured = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', promptVariant: 'pressure', label: 'pressure arm' } });
  const pressuredId = pressured.json?.id;
  if (pressuredId) await settle(pressuredId);
  const pressuredSeen = fake.seen.find((t) => t.id === pressuredId);
  const pressuredView = pressuredId ? recordOf((await visitor('203.0.113.12', 'GET', `/api/tasks/${pressuredId}`)).json) : null;
  const badVariant = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', promptVariant: 'cheat' } });
  check('an admin task may ask for the pressure task message: the loop gets it, and the run page and its receipt say so; an unknown variant → 400',
    pressured.status === 202 && pressuredSeen?.promptVariant === 'pressure' && pressuredView?.promptVariant === 'pressure' && pressuredView?.receipt?.promptVariant === 'pressure'
      && seen?.promptVariant === 'neutral' && badVariant.status === 400 && /promptVariant/.test(badVariant.json?.error ?? ''),
    `${pressured.status}; loop got ${pressuredSeen?.promptVariant}; page ${pressuredView?.promptVariant}; receipt ${pressuredView?.receipt?.promptVariant}; default ${seen?.promptVariant}; unknown → ${badVariant.status} ${oneLine(badVariant.json?.error)}`);
  if (pressuredId) {
    const pb = await admin('GET', `/admin/tasks/${pressuredId}/bundle`);
    const member = (name) => { try { return JSON.parse(spawnSync('tar', ['-xOf', '-', `./${name}`], { input: pb.buf }).stdout.toString()); } catch { return null; } };
    check('the bundle of a pressure-arm task records it in task.json and receipt.json', pb.status === 200 && member('task.json')?.promptVariant === 'pressure' && member('receipt.json')?.promptVariant === 'pressure',
      `${pb.status}; task.json ${member('task.json')?.promptVariant}; receipt.json ${member('receipt.json')?.promptVariant}`);
    // Public runs always get the neutral message, so a pressure-arm run never sets the ETA they show.
    let early = [];
    try { early = JSON.parse(await readFile(path.join(config.STATE_DIR, 'stats.json'), 'utf8')); } catch { early = []; }
    const flag = (tid) => early.find((r) => r.id === tid)?.comparable;
    check('a pressure-arm run never sets the ETA (stats.json: the default admin run yes, the pressure run no)', flag(id) === true && flag(pressuredId) === false,
      `default ${flag(id)}, pressure ${flag(pressuredId)}`);
  }

  // --- The admin-only Atlas sample ----------------------------------------------------------------------
  const atlas = await admin('POST', '/admin/tasks', { body: { sample: 'atlas', label: 'atlas sample' } });
  const atlasId = atlas.json?.id;
  if (atlasId) await settle(atlasId);
  const atlasSeen = fake.seen.find((t) => t.id === atlasId);
  const atlasCells = atlasSeen ? ['routes', 'viewports', 'schemes', 'locales'].reduce((n, k) => n * atlasSeen.matrix[k].length, 1) : 0;
  check('an admin task runs the Atlas sample: its own folder (demo/atlas), its 3 pages, 24 screens, the gate on and the configured model',
    atlas.status === 202 && atlasSeen?.source?.kind === 'sample' && atlasSeen.source.name === 'atlas' && /\/demo\/atlas\/$/.test(atlasSeen.source.dir ?? '')
      && JSON.stringify(atlasSeen.matrix.routes) === '["/","/pricing.html","/account.html"]' && atlasCells === 24 && atlasSeen.gate === true && atlasSeen.model === config.get().fixModel,
    `${atlas.status} ${oneLine(atlas.json?.error)}; ${atlasSeen?.source?.dir}; ${atlasCells} screens`);
  // The loop learns whether the sample is public, so an Atlas receipt never says publishable.
  const lumenSeen = fake.seen.find((t) => t.source?.kind === 'sample' && t.source.name === 'lumen');
  check('the loop gets source.publicSample: false for Atlas, true for Lumen',
    atlasSeen?.source?.publicSample === false && lumenSeen?.source?.publicSample === true,
    `atlas ${atlasSeen?.source?.publicSample}, lumen ${lumenSeen?.source?.publicSample}`);
  check('/api/config lists only the public sample: Lumen, never Atlas', cfg.json?.samples?.length === 1 && cfg.json.samples[0].id === 'lumen' && !cfg.text.includes('atlas'),
    JSON.stringify(cfg.json?.samples ?? null));
  const sayNoSample = (body) => { try { tasksMod.taskFromBody(body, { admin: false, cfg: config.get() }); return 'accepted'; } catch (err) { return err.message; } };
  check('a public request body for Atlas gets the same sentence as a sample that does not exist; an admin body may name it',
    sayNoSample({ sample: 'atlas' }) === tasksMod.SAY_NO_SAMPLE && sayNoSample({ sample: 'nope' }) === tasksMod.SAY_NO_SAMPLE
      && tasksMod.taskFromBody({ sample: 'atlas' }, { admin: true, cfg: config.get() }).source.name === 'atlas',
    `public atlas: ${sayNoSample({ sample: 'atlas' })}`);

  // --- The seeded gate scene: a scripted stand-in instead of a model (admin only) ------------------------
  const { SEEDED_LABEL, SEEDED_MODEL } = await import('../agent/seeded.mjs');
  const scene = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', seeded: 'cover-up', label: 'seeded scene' } });
  const sceneId = scene.json?.id;
  if (sceneId) await settle(sceneId);
  const sceneSeen = fake.seen.find((t) => t.id === sceneId);
  const sceneView = sceneId ? recordOf((await visitor('203.0.113.13', 'GET', `/api/tasks/${sceneId}`)).json) : null;
  check('an admin task may ask for the seeded scene: the loop gets the script, the stand-in, no vision model, the gate on and the neutral message; the run page gets the exact SEEDED label',
    scene.status === 202 && sceneSeen?.seeded === 'cover-up' && sceneSeen.model === SEEDED_MODEL && sceneSeen.visionModel === null && sceneSeen.gate === true
      && sceneSeen.promptVariant === 'neutral' && sceneView?.seeded?.label === SEEDED_LABEL && sceneView?.seeded?.model === SEEDED_MODEL && sceneView?.model === SEEDED_MODEL,
    `${scene.status} ${oneLine(scene.json?.error)}; loop got seeded ${sceneSeen?.seeded}, model ${sceneSeen?.model}; page label ${sceneView?.seeded?.label}`);
  const sceneRefusals = {
    atlas: { sample: 'atlas', seeded: 'cover-up' }, repo: { repo: 'https://github.com/vitejs/vite', seeded: 'cover-up' }, 'gate off': { sample: 'lumen', seeded: 'cover-up', gate: false },
    model: { sample: 'lumen', seeded: 'cover-up', model: 'glm-5.3' }, vision: { sample: 'lumen', seeded: 'cover-up', visionModel: 'qwen3.8-27b' },
    pressure: { sample: 'lumen', seeded: 'cover-up', promptVariant: 'pressure' }, sampling: { sample: 'lumen', seeded: 'cover-up', sampling: { seed: 8 } },
    'unknown script': { sample: 'lumen', seeded: 'magic' }, 'not a string': { sample: 'lumen', seeded: true },
    // A narrower matrix or other caps could keep the scripted cover-up from being measured and rolled back.
    routes: { sample: 'lumen', seeded: 'cover-up', routes: ['/settings.html'] }, locales: { sample: 'lumen', seeded: 'cover-up', locales: ['vi'] },
    viewports: { sample: 'lumen', seeded: 'cover-up', viewports: ['desktop'] }, schemes: { sample: 'lumen', seeded: 'cover-up', schemes: ['dark'] },
    caps: { sample: 'lumen', seeded: 'cover-up', caps: { maxChecks: 1 } },
  };
  const sceneCodes = {};
  for (const [k, body] of Object.entries(sceneRefusals)) sceneCodes[k] = (await admin('POST', '/admin/tasks', { body })).status;
  check('a seeded task is refused (400) on Atlas or a repository, and with the gate off, a model, a vision model, the pressure message, sampling, routes, locales, viewports, schemes, caps or an unknown script',
    Object.values(sceneCodes).every((c) => c === 400), Object.entries(sceneCodes).map(([k, c]) => `${k} ${c}`).join(', '));
  const appJsNow = (await visitor('203.0.113.1', 'GET', '/app.js')).text;
  const appCss = (await visitor('203.0.113.1', 'GET', '/app.css')).text;
  // What the files say, not a rendered page: the tag's place in the markup, the code that fills it,
  // and CSS that keeps it sticky at every width (no rule turns it static or relative).
  const tagRules = [...appCss.matchAll(/\.seeded-tag\s*\{([^}]*)\}/g)].map((m) => m[1]);
  check('index.html has the seeded tag first on the run page; app.js fills it and the model chip from the record; app.css keeps it sticky at every width',
    /<main id="task"[^>]*>\s*<p id="t-seeded" class="seeded-tag"[^>]*hidden><\/p>/.test(home.text) && /<ul id="t-chips"/.test(home.text)
      && /tag\.textContent = seeded \? seeded\.label : ''/.test(appJsNow) && /el\('li', 'chip', seeded\.model/.test(appJsNow)
      && tagRules.length >= 1 && /position:\s*sticky/.test(tagRules[0]) && !tagRules.some((r) => /position:\s*(static|relative)/.test(r)),
    `index.html has #t-seeded: ${/id="t-seeded"/.test(home.text)}; app.js sets it from t.seeded: ${/seeded\.label/.test(appJsNow)}; .seeded-tag rules: ${tagRules.map((r) => oneLine(r)).join(' | ')}`);
  check("a seeded run's before-and-after images stay on its page, unlinked, and each caption repeats the label",
    /if \(sceneLabel\) \{\s*fig\.append\(img, el\('figcaption', null, `\$\{IMAGES\[name\]\} · \$\{sceneLabel\}`\)\);/.test(appJsNow),
    `app.js: ${/sceneLabel/.test(appJsNow) ? 'has the seeded branch' : 'no seeded branch'}`);
  if (sceneId) {
    const sb = await admin('GET', `/admin/tasks/${sceneId}/bundle`);
    const sceneTask = (() => { try { return JSON.parse(spawnSync('tar', ['-xOf', '-', './task.json'], { input: sb.buf }).stdout.toString()); } catch { return null; } })();
    const scenePub = await admin('POST', `/admin/publish/${sceneId}`, { body: {} });
    let rows = [];
    try { rows = JSON.parse(await readFile(path.join(config.STATE_DIR, 'stats.json'), 'utf8')); } catch { rows = []; }
    const comparable = (tid) => rows.find((r) => r.id === tid)?.comparable;
    check('a seeded run is recorded as seeded in its bundle, is refused by the publisher (409, SEEDED), and never sets the ETA; nor does an Atlas run',
      sceneTask?.seeded?.script === 'cover-up' && scenePub.status === 409 && /SEEDED/.test(scenePub.json?.error ?? '') && published.length === 0
        && comparable(sceneId) === false && comparable(atlasId) === false,
      `bundle seeded ${sceneTask?.seeded?.script}; publish ${scenePub.status} ${oneLine(scenePub.json?.error)}; ETA: seeded ${comparable(sceneId)}, atlas ${comparable(atlasId)}`);
  }

  // --- A5: approve and patch -------------------------------------------------------------------------
  if (!id || state !== 'done') {
    skip('A5 approve and patch checks', 'the admin task did not finish');
  } else {
    const owner = { 'x-ring-owner': token };
    const early = await visitor('203.0.113.9', 'GET', `/api/tasks/${id}/patch`, { headers: owner });
    check('A5 the patch is refused (403) before Approve, even with the owner token', early.status === 403, `${early.status}`);
    const wrong = await visitor('203.0.113.9', 'POST', `/api/tasks/${id}/approve`, { body: {}, headers: { 'x-ring-owner': 'A'.repeat(token.length) } });
    check('A5 Approve with a wrong token → 403', wrong.status === 403, `${wrong.status}`);
    const byAdmin = await admin('POST', `/api/tasks/${id}/approve`, { body: {} });
    check('A5 an admin call without the owner token cannot approve (403)', byAdmin.status === 403, `${byAdmin.status}`);
    // The operator who created this admin task holds its owner token. With a passphrase set, the token
    // alone approves nothing: not through Caddy, and not over SSH to 127.0.0.1 with a made-up X-Forwarded-For.
    const tokenOnly = await visitor('203.0.113.9', 'POST', `/api/tasks/${id}/approve`, { body: {}, headers: owner });
    const spoofed = await admin('POST', `/api/tasks/${id}/approve`, { body: {}, headers: { ...owner, 'x-forwarded-for': '1.1.1.1' } });
    const wrongPass = await visitor('203.0.113.9', 'POST', `/api/tasks/${id}/approve`, { body: { passphrase: 'not it' }, headers: owner });
    const still = recordOf((await admin('GET', `/admin/tasks/${id}`)).json);
    check('A5 an admin run, with an approval passphrase set: its owner token alone cannot approve (via Caddy, or admin + token + spoofed XFF): 403',
      tokenOnly.status === 403 && spoofed.status === 403 && wrongPass.status === 403 && !still?.approvedAt,
      `token only ${tokenOnly.status}, admin+token+XFF ${spoofed.status}, wrong passphrase ${wrongPass.status}; approvedAt ${still?.approvedAt ?? 'none'}`);
    const ok = await visitor('203.0.113.9', 'POST', `/api/tasks/${id}/approve`, { body: { passphrase: PASSPHRASE }, headers: owner });
    const patch = await visitor('203.0.113.9', 'GET', `/api/tasks/${id}/patch`, { headers: owner });
    check('A5 the owner approves (owner token + passphrase), then downloads the patch as text/x-diff',
      ok.status === 200 && patch.status === 200 && patch.text === PATCH && /^text\/x-diff/.test(patch.headers['content-type'] ?? '')
        && String(patch.headers['content-disposition'] ?? '').includes(`filename="${id}.patch"`),
      `approve ${ok.status}; patch ${patch.status} ${patch.headers['content-type']} ${patch.headers['content-disposition']}`);
    const approvedRec = recordOf((await visitor('203.0.113.9', 'GET', `/api/tasks/${id}`)).json);
    check('A5 the record says how the run was approved (passphrase), and the page knows a passphrase is asked',
      approvedRec?.approvedWith === 'passphrase' && approvedRec?.approvalNeedsPassphrase === true, `approvedWith ${approvedRec?.approvedWith}, approvalNeedsPassphrase ${approvedRec?.approvalNeedsPassphrase}`);
    const stranger = await visitor('203.0.113.10', 'GET', `/api/tasks/${id}/patch`, { headers: { 'x-ring-owner': 'not-the-token' } });
    check('A5 after Approve the patch still needs the owner token (403 without it)', stranger.status === 403, `${stranger.status}`);

    const pub = await visitor('203.0.113.9', 'GET', `/api/tasks/${id}`);
    const rec = recordOf(pub.json);
    const leaked = ['private', 'caps', 'label', 'sampling'].filter((k) => rec && k in rec);
    check('GET /api/tasks/:id never returns private, caps, label or sampling (nor the token hash)',
      pub.status === 200 && rec?.id === id && leaked.length === 0 && !pub.text.includes('ownerTokenSha256') && !pub.text.includes(token),
      `${pub.status}; ${leaked.length ? `leaked: ${leaked.join(', ')}` : 'clean'}`);
    const png = await visitor('203.0.113.9', 'GET', `/api/tasks/${id}/files/proof.png`);
    const json = await visitor('203.0.113.9', 'GET', `/api/tasks/${id}/files/receipt.json`);
    check('task files: proof.png is served as image/png; names outside the PNG allowlist are not',
      png.status === 200 && png.headers['content-type'] === 'image/png' && png.buf.equals(TINY_PNG) && json.status >= 400 && json.status < 500,
      `proof.png ${png.status} ${png.headers['content-type']}; receipt.json ${json.status}`);

    // --- A6: SSE replay ---------------------------------------------------------------------------
    const all = await readSse(`/api/tasks/${id}/events`, viaCaddy('203.0.113.11'));
    const numbered = (frames) => frames.filter((f) => f.event !== 'hello' && f.id !== undefined).map((f) => Number(f.id));
    const ids = numbered(all.frames);
    if (ids.length < 3) {
      check('A6 SSE replays from Last-Event-ID', false, `only ${ids.length} numbered events in the first stream: ${oneLine(all.raw).slice(0, 200)}`);
    } else {
      const from = ids[1];
      const replay = await readSse(`/api/tasks/${id}/events`, { ...viaCaddy('203.0.113.11'), 'last-event-id': String(from) });
      const again = numbered(replay.frames);
      const want = ids.filter((n) => n > from);
      check('A6 SSE: hello first, retry 3000, then a replay of exactly the events after Last-Event-ID',
        /^text\/event-stream/.test(all.headers['content-type'] ?? '') && all.frames[0]?.event === 'hello' && replay.frames[0]?.event === 'hello'
          && /retry: 3000/.test(all.raw) && JSON.stringify(again) === JSON.stringify(want) && replay.frames.some((f) => f.event === 'done'),
        `first stream ids ${ids.join(',')}; after Last-Event-ID ${from}: ${again.join(',')}`);
    }
  }

  // --- A3 / A4 and the public limits, with public runs switched on ------------------------------------
  const unknownKey = await admin('POST', '/admin/config', { body: { nope: 1 } });
  const badValue = await admin('POST', '/admin/config', { body: { publicSampleRuns: 'yes' } });
  const oldOpen = await admin('POST', '/admin/config', { body: { publicRuns: true } });
  // Each sandbox may hold 4 GB, so the VM's 16 GB takes 2 at once, no longer 3.
  const threeAtOnce = await admin('POST', '/admin/config', { body: { maxRunning: 3 } });
  const stillShut = await admin('GET', '/admin/config');
  check('/admin/config refuses unknown keys, bad values, maxRunning 3 (4 GB sandboxes on a 16 GB VM) and the old {publicRuns:true}, which no longer says what to open (400)',
    unknownKey.status === 400 && badValue.status === 400 && oldOpen.status === 400 && /publicSampleRuns/.test(oldOpen.json?.error ?? '')
      && threeAtOnce.status === 400 && /maxRunning must be 1 or 2 .*4 GB.*16 GB/.test(threeAtOnce.json?.error ?? '') && stillShut.json?.maxRunning === 2
      && stillShut.json?.publicSampleRuns === false && stillShut.json?.publicGithubRuns === false,
    `${unknownKey.status}, ${badValue.status}, ${oldOpen.status} ${oneLine(oldOpen.json?.error)}; maxRunning 3: ${threeAtOnce.status} ${oneLine(threeAtOnce.json?.error)}`);
  const longer = await admin('POST', '/admin/config', { body: { caps: { wallClockSec: 1500 } } });
  const cfgLonger = await visitor('203.0.113.1', 'GET', '/api/config');
  const back = await admin('POST', '/admin/config', { body: { caps: { wallClockSec: 900 } } });
  const cfgBack = await visitor('203.0.113.1', 'GET', '/api/config');
  check('/api/config gives the GitHub wall clock from the caps: 1200 s by default, the default wall clock once an admin raises it above that',
    cfg.json?.githubWallClockSec === 1200 && longer.status === 200 && cfgLonger.json?.githubWallClockSec === 1500 && back.status === 200 && cfgBack.json?.githubWallClockSec === 1200,
    `default ${cfg.json?.githubWallClockSec}; wall clock 1500 → ${cfgLonger.json?.githubWallClockSec} (${longer.status}); back to 900 → ${cfgBack.json?.githubWallClockSec}`);
  const open = await admin('POST', '/admin/config', { body: { publicSampleRuns: true } });
  const cfgOpen = await visitor('203.0.113.1', 'GET', '/api/config');
  const stOpen = await visitor('203.0.113.1', 'GET', '/status.json');
  check('POST /admin/config {publicSampleRuns:true} opens runs of the sample only; /api/config and /status.json say so',
    open.status === 200 && cfgOpen.json?.publicSampleRuns === true && cfgOpen.json?.publicGithubRuns === false
      && stOpen.json?.publicSampleRuns === true && stOpen.json?.publicGithubRuns === false,
    `${open.status}; /api/config sample ${cfgOpen.json?.publicSampleRuns}, GitHub ${cfgOpen.json?.publicGithubRuns}`);
  // With sample runs open, Atlas still does not exist for the public, and a public body cannot ask for the seeded scene.
  const seenAtlas = fake.seen.length;
  const publicAtlas = await visitor('203.0.113.28', 'POST', '/api/tasks', { body: { sample: 'atlas' } });
  const publicScene = await visitor('203.0.113.29', 'POST', '/api/tasks', { body: { sample: 'lumen', seeded: 'cover-up' } });
  if (publicScene.json?.id) await settle(publicScene.json.id);
  const publicSceneSeen = fake.seen.find((t) => t.id === publicScene.json?.id);
  check('with sample runs open, a public run of Atlas → 400 with the unknown-sample sentence and nothing starts; a public body asking for the seeded scene gets a normal run (no script, the configured model)',
    publicAtlas.status === 400 && publicAtlas.json?.error === tasksMod.SAY_NO_SAMPLE && !fake.seen.slice(seenAtlas).some((t) => t.source?.name === 'atlas')
      && publicScene.status === 202 && publicSceneSeen?.seeded === null && publicSceneSeen?.model === config.get().fixModel,
    `atlas ${publicAtlas.status} ${oneLine(publicAtlas.json?.error)}; seeded body ${publicScene.status}, loop got seeded ${publicSceneSeen?.seeded}, model ${publicSceneSeen?.model}`);
  const seenBefore = fake.seen.length;
  const repoShut = await visitor('203.0.113.26', 'POST', '/api/tasks', { body: { repo: 'https://github.com/vitejs/vite' } });
  check('with only the sample switch open, a GitHub repository → 503 with its own sentence, and nothing starts',
    repoShut.status === 503 && plainError(repoShut) && /GitHub repository are not open/.test(repoShut.json?.error ?? '') && fake.seen.length === seenBefore,
    `${repoShut.status} ${oneLine(repoShut.json?.error)}`);
  const openGithub = await admin('POST', '/admin/config', { body: { publicGithubRuns: true } });
  const repoRun = await visitor('203.0.113.27', 'POST', '/api/tasks', { body: { repo: 'github.com/vitejs/vite' } });
  if (repoRun.json?.id) await settle(repoRun.json.id);
  const repoSeen = fake.seen.find((t) => t.id === repoRun.json?.id);
  check('POST /admin/config {publicGithubRuns:true} opens runs on a public GitHub repository',
    openGithub.status === 200 && openGithub.json?.publicGithubRuns === true && repoRun.status === 202 && repoSeen?.source?.kind === 'github' && repoSeen?.source?.label === 'vitejs/vite',
    `${openGithub.status}; ${repoRun.status} ${oneLine(repoRun.json?.error)}; source ${repoSeen?.source?.kind}:${repoSeen?.source?.label}`);

  const plain = await visitor('203.0.113.20', 'POST', '/api/tasks', { body: JSON.stringify({ sample: 'lumen' }), headers: { 'content-type': 'text/plain' } });
  const crossSite = await visitor('203.0.113.21', 'POST', '/api/tasks', { body: { sample: 'lumen' }, headers: { 'sec-fetch-site': 'cross-site' } });
  check('CSRF: a public POST needs content-type application/json and no cross-site sec-fetch-site',
    plain.status >= 400 && plain.status < 500 && crossSite.status >= 400 && crossSite.status < 500, `text/plain → ${plain.status}; cross-site → ${crossSite.status}`);
  const big = await visitor('203.0.113.22', 'POST', '/api/tasks', { body: { sample: 'lumen', pad: 'x'.repeat(17 * 1024) } });
  check('a body over 16 KB → 413 with a sentence', big.status === 413 && plainError(big), `${big.status} ${oneLine(big.json?.error)}`);
  const badRepo = await visitor('203.0.113.23', 'POST', '/api/tasks', { body: { repo: 'https://gitlab.com/o/r' } });
  const badRoute = await visitor('203.0.113.24', 'POST', '/api/tasks', { body: { sample: 'lumen', routes: ['/a', '/b', '/c', '/d'] } });
  check('bad repo URL and bad routes → 400 with the §4.5 sentences',
    badRepo.status === 400 && /github\.com/.test(badRepo.json?.error ?? '') && badRoute.status === 400 && /Routes must be paths/.test(badRoute.json?.error ?? ''),
    `${badRepo.status} ${oneLine(badRepo.json?.error)}; ${badRoute.status} ${oneLine(badRoute.json?.error)}`);

  // Repository addresses as people paste them: the owner and name come out, everything else is dropped.
  const parts = (s) => { try { const r = tasksMod.repoFromInput(s); return `${r.owner}/${r.name}`; } catch (err) { return err.message; } };
  const pasted = ['  https://github.com/vitejs/vite  ', 'github.com/vitejs/vite', 'http://www.github.com/vitejs/vite.git/', 'https://github.com/vitejs/vite#readme', 'https://GitHub.com/vitejs/vite?tab=readme-ov-file'].map(parts);
  const pages = ['https://github.com/vitejs/vite/tree/main/packages', 'https://github.com/vitejs/vite/blob/main/README.md', 'https://github.com/vitejs/vite/pull/1'].map(parts);
  const refused = ['https://gitlab.com/o/r', 'https://github.com.evil.example/o/r', 'https://user@github.com/o/r', 'git@github.com:o/r.git', 'https://gist.github.com/o/r', 'https://github.com/o', 'https://github.com/o/..'].map(parts);
  const pagedTask = await visitor('203.0.113.25', 'POST', '/api/tasks', { body: { repo: 'https://github.com/vitejs/vite/tree/main' } });
  check('repo addresses: spaces, http://, www., no scheme, .git, #readme and ?tab= are accepted; a link to a branch, file or pull request gets its own sentence; other hosts are refused',
    pasted.every((p) => p === 'vitejs/vite') && pages.every((p) => p === tasksMod.SAY_REPO_PAGE) && refused.every((p) => p === tasksMod.SAY_BAD_REPO)
      && pagedTask.status === 400 && pagedTask.json?.error === tasksMod.SAY_REPO_PAGE,
    `${pasted.join(', ')} | ${pages.map(oneLine).join(' / ')} | ${refused.filter((p) => p !== tasksMod.SAY_BAD_REPO).join(', ') || 'all refused'} | ${pagedTask.status}`);
  const privateIp = await visitor('10.1.2.3', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  const loopIp = await visitor('127.0.0.1', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  check('task creation from a private or loopback client address → 403', privateIp.status === 403 && loopIp.status === 403, `10.1.2.3 → ${privateIp.status}; 127.0.0.1 → ${loopIp.status}`);

  // The body also asks for what only an admin task may choose: the gate off, another model, the pressure message.
  const lastEntry = await visitor('10.9.9.9, 203.0.113.30', 'POST', '/api/tasks', { body: { sample: 'lumen', gate: false, model: 'glm-5.3', promptVariant: 'pressure' } });
  const lastId = lastEntry.json?.id;
  const lastSeen = fake.seen.find((t) => t.id === lastId);
  check('the client address is the last X-Forwarded-For entry (a spoofed first entry is ignored)', lastEntry.status === 202, `${lastEntry.status} ${oneLine(lastEntry.json?.error)}`);
  if (lastId) await settle(lastId);
  check('a public task always has the gate on, the configured model, the neutral task message and at most $0.60, whatever its body asks',
    lastSeen?.gate === true && lastSeen?.model === config.get().fixModel && lastSeen?.promptVariant === 'neutral'
      && typeof lastSeen?.caps?.maxUsd === 'number' && lastSeen.caps.maxUsd <= 0.6,
    `gate ${lastSeen?.gate}, model ${lastSeen?.model}, task message ${lastSeen?.promptVariant}, maxUsd ${lastSeen?.caps?.maxUsd}`);

  // A public run's owner token went only to the browser that started it: with a passphrase set on the
  // server, that owner still approves the run with the token alone, and gets the patch.
  if (!lastId || !lastEntry.json?.ownerToken) {
    skip('approval of a public run with its owner link', 'the public task from the XFF check did not start');
  } else {
    const pubOwner = { 'x-ring-owner': lastEntry.json.ownerToken };
    const pubBefore = recordOf((await visitor('203.0.113.30', 'GET', `/api/tasks/${lastId}`)).json);
    const pubApprove = await visitor('203.0.113.30', 'POST', `/api/tasks/${lastId}/approve`, { body: {}, headers: pubOwner });
    const pubPatch = await visitor('203.0.113.30', 'GET', `/api/tasks/${lastId}/patch`, { headers: pubOwner });
    const pubAfter = recordOf((await visitor('203.0.113.30', 'GET', `/api/tasks/${lastId}`)).json);
    check('a public run is approved with its own owner link while a passphrase is set (none is asked), recorded as owner-link; its owner then downloads the patch',
      approvalCfg.passphraseSha256 !== null && pubBefore?.approvalNeedsPassphrase === false && pubApprove.status === 200
        && pubAfter?.approvedWith === 'owner-link' && pubPatch.status === 200 && pubPatch.text === PATCH,
      `asks for a passphrase: ${pubBefore?.approvalNeedsPassphrase}; approve ${pubApprove.status} ${oneLine(pubApprove.json?.error)}; approvedWith ${pubAfter?.approvedWith}; patch ${pubPatch.status}`);
  }

  // A public run on /latest/ is another matter: its approval is shown there, so it needs the passphrase.
  const shown = await visitor('203.0.113.31', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  const shownId = shown.json?.id;
  if (!shownId) {
    skip('approval of a published public run', `the public task did not start (${shown.status})`);
  } else {
    await settle(shownId);
    const latestFile = path.join(config.STATE_DIR, 'latest.json');
    await writeFile(latestFile, `${JSON.stringify({ taskId: shownId, at: new Date().toISOString(), line: '1 fixed · 0 new · 0 cover-ups · 0 lost' })}\n`);
    try {
      const shownOwner = { 'x-ring-owner': shown.json.ownerToken };
      const shownView = recordOf((await visitor('203.0.113.31', 'GET', `/api/tasks/${shownId}`)).json);
      const asks = shownView?.approvalNeedsPassphrase;
      // The run page (app.js) shows its owner one sentence then, not a passphrase box it cannot fill.
      check('the run page shows a published public run one sentence instead of the passphrase box and Approve (origin public, a passphrase asked)',
        shownView?.origin === 'public' && asks === true && /t\.approvalNeedsPassphrase && t\.origin === 'public'/.test(appJs)
          && /This run has been published, so approving it also needs the demo owner's approval passphrase/.test(appJs),
        `origin ${shownView?.origin}, asks ${asks}; app.js has the sentence: ${/This run has been published/.test(appJs)}`);
      const linkOnly = await visitor('203.0.113.31', 'POST', `/api/tasks/${shownId}/approve`, { body: {}, headers: shownOwner });
      const withPass = await visitor('203.0.113.31', 'POST', `/api/tasks/${shownId}/approve`, { body: { passphrase: PASSPHRASE }, headers: shownOwner });
      const shownRec = recordOf((await admin('GET', `/admin/tasks/${shownId}`)).json);
      check('a public run that is on /latest/ needs the passphrase too: its owner link alone → 403, with the passphrase → approved as passphrase',
        asks === true && linkOnly.status === 403 && withPass.status === 200 && shownRec?.approvedWith === 'passphrase',
        `asks ${asks}; link only ${linkOnly.status}; with the passphrase ${withPass.status}; approvedWith ${shownRec?.approvedWith}`);
    } finally {
      await rm(latestFile, { force: true });
    }
  }

  // One run in progress per address.
  fake.mode = 'block';
  const first = await visitor('203.0.113.40', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  await wait(100);
  const second = await visitor('203.0.113.40', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  check('one run in progress per address: a second start → 429 with a sentence', first.status === 202 && second.status === 429 && plainError(second),
    `${first.status}, then ${second.status} ${oneLine(second.json?.error)}`);
  // The outside monitor tells a stuck task from a busy queue by how long the oldest running task has run.
  await wait(1100);
  const busyStatus = (await visitor('203.0.113.1', 'GET', '/status.json')).json?.queue;
  check('/status.json gives queue.longestRunningSec: 0 when idle, then the running task\'s own time (at least 1 s here)',
    stj.json?.queue?.longestRunningSec === 0 && busyStatus?.running === 1 && Number.isInteger(busyStatus.longestRunningSec) && busyStatus.longestRunningSec >= 1 && busyStatus.longestRunningSec < 60,
    `idle ${stj.json?.queue?.longestRunningSec}; busy ${JSON.stringify(busyStatus)}`);
  fake.mode = 'instant';
  fake.releaseAll();
  if (first.json?.id) await settle(first.json.id);

  // A3: three starts per rolling hour per address; the fourth is refused with Retry-After.
  const starts = [];
  for (let i = 0; i < 3; i++) {
    const r = await visitor('203.0.113.50', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
    starts.push(r.status);
    if (r.json?.id) await settle(r.json.id);
  }
  const fourth = await visitor('203.0.113.50', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  check('A3 the 4th start from one address within an hour → 429 with Retry-After',
    starts.every((s) => s === 202) && fourth.status === 429 && plainError(fourth) && Number(fourth.headers['retry-after']) > 0,
    `starts ${starts.join(', ')}; 4th ${fourth.status}, Retry-After ${fourth.headers['retry-after']}: ${oneLine(fourth.json?.error)}`);

  // A4: 2 running + 8 waiting fill the queue; the next start gets the "busy" sentence.
  fake.mode = 'block';
  const fill = [];
  for (let i = 1; i <= 10; i++) fill.push(await visitor(`198.51.100.${i}`, 'POST', '/api/tasks', { body: { sample: 'lumen' } }));
  const overflow = await visitor('198.51.100.11', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  check('A4 queue full (2 running + 8 waiting): the next start → 503 "busy" sentence',
    fill.every((r) => r.status === 202) && overflow.status === 503 && plainError(overflow) && /busy/i.test(overflow.json?.error ?? ''),
    `starts ${fill.map((r) => r.status).join(',')}; 11th ${overflow.status} ${oneLine(overflow.json?.error)}`);
  fake.mode = 'instant';
  fake.releaseAll();
  const states = [];
  for (const r of fill) if (r.json?.id) states.push(await settle(r.json.id, 15_000));
  check('the queue drains after the runs are released', states.length === 10 && states.every((s) => s === 'done'), states.join(','));

  // The old switch still closes everything, as an operator may type it in a hurry.
  const oldClose = await admin('POST', '/admin/config', { body: { publicRuns: false } });
  const shutAgain = await visitor('198.51.100.20', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  check('the old {publicRuns:false} still closes both switches; a public start then gets the closed sentence',
    oldClose.status === 200 && oldClose.json?.publicSampleRuns === false && oldClose.json?.publicGithubRuns === false
      && shutAgain.status === 503 && /open soon/i.test(shutAgain.json?.error ?? ''),
    `${oldClose.status}; switches ${oldClose.json?.publicSampleRuns}/${oldClose.json?.publicGithubRuns}; start ${shutAgain.status}`);

  // A config.json from before the split, read by a fresh copy of app/config.mjs: its publicRuns becomes
  // publicSampleRuns unless the file names that too, GitHub runs stay closed, and the next change drops it.
  const legacyRead = async (name, data) => {
    const dir = path.join(stateDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'config.json'), `${JSON.stringify(data)}\n`);
    const saved = process.env.RING_STATE_DIR;
    process.env.RING_STATE_DIR = dir;
    try {
      const mod = await import(`../app/config.mjs?${name}`);
      return { mod, dir, cfg: mod.get() };
    } finally {
      process.env.RING_STATE_DIR = saved;
    }
  };
  const oldOn = await legacyRead('legacy-open', { publicRuns: true, maxRunning: 2 });
  oldOn.mod.set({ maxRunning: 1 });
  const rewritten = JSON.parse(await readFile(path.join(oldOn.dir, 'config.json'), 'utf8'));
  const both = await legacyRead('legacy-both', { publicRuns: true, publicSampleRuns: false });
  check('an old config.json with publicRuns true keeps sample runs open and GitHub runs closed; the new key wins; the next change drops publicRuns',
    oldOn.cfg.publicSampleRuns === true && oldOn.cfg.publicGithubRuns === false && !('publicRuns' in oldOn.cfg)
      && rewritten.publicSampleRuns === true && !('publicRuns' in rewritten) && rewritten.maxRunning === 1
      && both.cfg.publicSampleRuns === false && both.cfg.publicGithubRuns === false,
    `read: sample ${oldOn.cfg.publicSampleRuns}, GitHub ${oldOn.cfg.publicGithubRuns}; rewritten ${JSON.stringify(rewritten)}; with both keys: sample ${both.cfg.publicSampleRuns}`);

  // scripts/ring.sh config opens one switch at a time (D-5), against a stand-in for ssh that only
  // logs what it would send. RING_TEST=1 makes the script refuse the real ssh and the real VM.
  const fakeSsh = path.join(stateDir, 'fake-ssh');
  const sshLog = path.join(stateDir, 'fake-ssh.log');
  await writeFile(sshLog, '');
  await writeFile(fakeSsh, `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' "$last" >> '${sshLog}'\ncat >> '${sshLog}'\nprintf '\\n' >> '${sshLog}'\necho '{"ok":true}'\n`, { mode: 0o755 });
  const ringSh = fileURLToPath(new URL('../scripts/ring.sh', import.meta.url));
  const ringConfig = async (allow, patch) => {
    const before = (await readFile(sshLog, 'utf8')).length;
    const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: stateDir, LANG: 'C.UTF-8', RING_TEST: '1', RING_HOST: '192.0.2.1', RING_SSH: fakeSsh };
    if (allow !== undefined) env.RING_ALLOW_PUBLIC = allow;
    const r = spawnSync('bash', [ringSh, 'config', patch], { encoding: 'utf8', env, timeout: 20_000 });
    const sent = (await readFile(sshLog, 'utf8')).slice(before);
    return { code: r.status, sent: sent.includes('/admin/config') && sent.includes(patch), err: oneLine(r.stderr) };
  };
  const cases = [
    [undefined, '{"publicSampleRuns":true}', false], ['sample', '{"publicSampleRuns":true}', true], ['yes', '{"publicSampleRuns":true}', true],
    ['sample', '{"publicGithubRuns":true}', false], ['github', '{"publicGithubRuns":true}', true], ['github', '{"publicSampleRuns":true}', false],
    ['sample', '{"publicSampleRuns":true,"publicGithubRuns":true}', false], ['yes', '{"publicSampleRuns":true,"publicGithubRuns":true}', true],
    ['sample', '{"publicRuns":true}', false], ['bogus', '{"publicSampleRuns":true}', false],
    [undefined, '{"publicSampleRuns":false,"publicGithubRuns":false}', true], [undefined, '{"maxRunning":2}', true],
  ];
  const wrong = [];
  for (const [allow, patch, want] of cases) {
    const r = await ringConfig(allow, patch);
    if (r.sent !== want || (r.code === 0) !== want) wrong.push(`RING_ALLOW_PUBLIC=${allow ?? '(unset)'} ${patch}: exit ${r.code}, ${r.sent ? 'sent' : 'not sent'} ${r.err}`);
  }
  const refusedGithub = await ringConfig('sample', '{"publicGithubRuns":true}');
  check('scripts/ring.sh config: RING_ALLOW_PUBLIC=sample opens only publicSampleRuns, github only publicGithubRuns, yes both; the old publicRuns needs yes; closing needs nothing',
    wrong.length === 0 && /RING_ALLOW_PUBLIC=github/.test(refusedGithub.err),
    wrong.join(' | ') || `${cases.length} patches as expected; refused with: ${refusedGithub.err}`);

  // scripts/ring.sh mem sends scripts/vm-mem.sh to the VM's sh on stdin, with only checked digits on the
  // remote command line. The script itself runs here once for a second: it only reads.
  const vmMem = fileURLToPath(new URL('../scripts/vm-mem.sh', import.meta.url));
  const ringMem = async (...args) => {
    const before = (await readFile(sshLog, 'utf8')).length;
    const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: stateDir, LANG: 'C.UTF-8', RING_TEST: '1', RING_HOST: '192.0.2.1', RING_SSH: fakeSsh };
    const r = spawnSync('bash', [ringSh, 'mem', ...args], { encoding: 'utf8', env, timeout: 20_000 });
    return { code: r.status, sent: (await readFile(sshLog, 'utf8')).slice(before), err: oneLine(r.stderr) };
  };
  const memScript = await readFile(vmMem, 'utf8');
  const memNow = await ringMem();
  const memWatch = await ringMem('30');
  const memBad = [await ringMem('abc'), await ringMem('601'), await ringMem('5;id')];
  const memHere = spawnSync('sh', [vmMem, '1'], { encoding: 'utf8', timeout: 20_000 });
  check('scripts/ring.sh mem sends scripts/vm-mem.sh on stdin to the VM\'s sh with only the checked seconds (0 by default, at most 600), and anything else stops before ssh; the script reads free -m and the cgroups, and with seconds the least memory available',
    memNow.code === 0 && memNow.sent.startsWith('sh -s 0\n') && memNow.sent.includes(memScript)
      && memWatch.code === 0 && memWatch.sent.startsWith('sh -s 30\n') && memBad.every((r) => r.code !== 0 && r.sent === '' && /usage: ring\.sh mem/.test(r.err))
      && memHere.status === 0 && /^over 1 s: MemAvailable at least \d+ MB \(at \d\d:\d\d:\d\d UTC\)/m.test(memHere.stdout) && /^Mem: /m.test(memHere.stdout)
      && /^cgroup +now +peak +limit$/m.test(memHere.stdout),
    `${memNow.code} ${oneLine(memNow.sent.slice(0, 40))} | ${memWatch.code} | bad: ${memBad.map((r) => `${r.code} ${r.err}`).join(' / ')} | here: ${memHere.status} ${oneLine(memHere.stdout.slice(0, 160))} ${oneLine(memHere.stderr)}`);

  const pubTry = await admin('POST', `/admin/publish/${id ?? 'x'}`, { body: {} });
  check('POST /admin/publish/:id refuses a TEST RUN receipt (409) and publishes nothing', pubTry.status === 409 && published.length === 0, `${pubTry.status} ${oneLine(pubTry.json?.error ?? pubTry.text)}`);

  // Without a passphrase on the server the owner link alone approves an admin run too, and the record says only that.
  const linkAdmin = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', label: 'approved with the link' } });
  if (linkAdmin.json?.id) await settle(linkAdmin.json.id);
  approvalCfg.passphraseSha256 = null;
  if (!linkAdmin.json?.ownerToken) {
    skip('approval of an admin run with the owner link only', `the admin task did not start (${linkAdmin.status})`);
  } else {
    const linkTask = linkAdmin.json.id;
    const viaLink = await visitor('203.0.113.32', 'POST', `/api/tasks/${linkTask}/approve`, { body: {}, headers: { 'x-ring-owner': linkAdmin.json.ownerToken } });
    const linkRec = recordOf((await visitor('203.0.113.32', 'GET', `/api/tasks/${linkTask}`)).json);
    check('without an approval passphrase the owner link approves an admin run, recorded as approvedWith owner-link',
      viaLink.status === 200 && linkRec?.approvedWith === 'owner-link' && linkRec?.approvalNeedsPassphrase === false, `${viaLink.status}; approvedWith ${linkRec?.approvedWith}`);
  }

  // The publish bar and the published page (app/publish.mjs), on receipts the fake loop never writes.
  const pub = await import('../app/publish.mjs');
  const passing = { ...fakeReceipt({ id: `t_${'a'.repeat(32)}`, source: { kind: 'sample', name: 'lumen' }, matrix: {}, model: 'm' }), label: 'REAL RUN · Vultr VX1 sea · 2026-11-04 05:12 UTC', publishable: true };
  const sampleTask = { id: passing.taskId, source: { kind: 'sample', label: 'Lumen (sample site)' }, gate: true, promptVariant: 'neutral' };
  const lostOne = { ...passing, counts: { ...passing.counts, lost: 1 } };
  const screens = { ...passing, counts: { ...passing.counts, cellsCompared: 8, cellsExpected: 16 } };
  const noApply = { ...passing, diff: { ...passing.diff, applies: false } };
  check('the publish bar refuses lost controls, unmeasured screens and a patch that does not apply',
    pub.notPublishable(sampleTask, passing) === null && /lost control/.test(pub.notPublishable(sampleTask, lostOne) ?? '')
      && /compared 8 of the 16 screens/.test(pub.notPublishable(sampleTask, screens) ?? '') && /does not apply/.test(pub.notPublishable(sampleTask, noApply) ?? ''),
    [passing, lostOne, screens, noApply].map((r) => pub.notPublishable(sampleTask, r) ?? 'publishable').join(' | '));
  // /latest/ shows what a public run does, so a bench arm (the pressure message, or the gate off) is never published.
  const { promptVariant: _variant, ...beforeArms } = passing;
  const arms = {
    'pressure task': pub.notPublishable({ ...sampleTask, promptVariant: 'pressure' }, passing),
    'pressure receipt': pub.notPublishable(sampleTask, { ...passing, promptVariant: 'pressure' }),
    'gate off (task)': pub.notPublishable({ ...sampleTask, gate: false }, passing),
    'gate off (receipt)': pub.notPublishable(sampleTask, { ...passing, gate: { ...passing.gate, enabled: false } }),
    'older run, no variant recorded': pub.notPublishable({ ...sampleTask, promptVariant: null }, beforeArms),
  };
  check('the publish bar refuses a bench arm: the pressure task message or the gate off, in the task or its receipt; a run from before the pressure arm (no variant recorded) still passes',
    [arms['pressure task'], arms['pressure receipt']].every((w) => /pressure task message/.test(w ?? '')) && [arms['gate off (task)'], arms['gate off (receipt)']].every((w) => /gate off/.test(w ?? ''))
      && arms['older run, no variant recorded'] === null,
    Object.entries(arms).map(([k, w]) => `${k}: ${w ?? 'publishable'}`).join(' | '));
  // Nor is a run of the admin-only Atlas sample, nor a SEEDED run, however well it passed.
  const atlasPassing = { ...passing, source: { ...passing.source, name: 'atlas' } };
  const atlasTask = { ...sampleTask, source: { kind: 'sample', name: 'atlas', label: 'Atlas (invoicing app)' } };
  const seededBlock = { script: 'cover-up', model: SEEDED_MODEL, note: 'scripted' };
  const barred = {
    'Atlas (task)': pub.notPublishable(atlasTask, passing), 'Atlas (receipt)': pub.notPublishable(sampleTask, atlasPassing),
    'seeded (task)': pub.notPublishable({ ...sampleTask, seeded: seededBlock }, passing), 'seeded (receipt)': pub.notPublishable(sampleTask, { ...passing, seeded: seededBlock }),
    'seeded (label)': pub.notPublishable(sampleTask, { ...passing, label: SEEDED_LABEL }),
    'Lumen named': pub.notPublishable({ ...sampleTask, source: { ...sampleTask.source, name: 'lumen' } }, passing),
  };
  check('the publish bar refuses a run of the admin-only Atlas sample and a SEEDED run (by its task, its receipt or its label), and still takes a Lumen pass',
    [barred['Atlas (task)'], barred['Atlas (receipt)']].every((w) => /admin-only bench sample/.test(w ?? ''))
      && [barred['seeded (task)'], barred['seeded (receipt)'], barred['seeded (label)']].every((w) => /SEEDED run/.test(w ?? '')) && barred['Lumen named'] === null,
    Object.entries(barred).map(([k, w]) => `${k}: ${w ?? 'publishable'}`).join(' | '));
  const at = '2026-11-04T06:00:00.000Z';
  const page = (task) => pub.runPageHtml({ task, receipt: passing, images: [], selftests: {} });
  const byLink = page({ ...sampleTask, approvedAt: at, approvedWith: 'owner-link' });
  const byPass = page({ ...sampleTask, approvedAt: at, approvedWith: 'passphrase' });
  check('the published page claims "by a human" only for a passphrase approval, has its own CSP and links the run log',
    byLink.includes('Approved with the owner link at 2026-11-04 06:00 UTC') && !byLink.includes('by a human')
      && byPass.includes('Approved by a human at 2026-11-04 06:00 UTC') && /http-equiv="Content-Security-Policy" content="default-src 'none'/.test(byLink)
      && byLink.includes(`href="/t/${passing.taskId}"`),
    `${/Approved[^<]*/.exec(byLink)?.[0]} | ${/Approved[^<]*/.exec(byPass)?.[0]}`);

  // Addresses a person may mistype, the browser 404 page, and /admin/* looking the same as an unknown path.
  const slash = await visitor('203.0.113.60', 'GET', '/status/');
  const taskSlash = id ? await visitor('203.0.113.60', 'GET', `/t/${id}/`) : { status: 0, headers: {} };
  const html404 = await visitor('203.0.113.60', 'GET', '/no-such-page', { headers: { accept: 'text/html' } });
  const adminHtml = await visitor('203.0.113.60', 'GET', '/admin/health', { headers: { accept: 'text/html' } });
  check('/status/ and /t/<id>/ redirect (308) without the slash; a browser gets an HTML 404, the same for /admin/*',
    slash.status === 308 && slash.headers.location === '/status' && taskSlash.status === 308 && taskSlash.headers.location === `/t/${id}`
      && html404.status === 404 && /text\/html/.test(html404.headers['content-type'] ?? '') && /href="\/status"/.test(html404.text)
      && adminHtml.status === 404 && adminHtml.text === html404.text,
    `${slash.status} → ${slash.headers.location}; ${taskSlash.status} → ${taskSlash.headers.location}; 404 ${html404.headers['content-type']}; admin ${adminHtml.status}`);
  check('responses carry COOP, CORP and a Permissions-Policy', ['cross-origin-opener-policy', 'cross-origin-resource-policy', 'permissions-policy'].every((h) => home.headers[h]),
    `${home.headers['cross-origin-opener-policy']}, ${home.headers['cross-origin-resource-policy']}, ${home.headers['permissions-policy']}`);

  // Bundles end up in git: task.json goes in without private.* (the client's network key, the owner token's hash).
  if (id) {
    const bundle = await admin('GET', `/admin/tasks/${id}/bundle`);
    const inner = spawnSync('tar', ['-xOf', '-', './task.json'], { input: bundle.buf });
    const names = spawnSync('tar', ['-tf', '-'], { input: bundle.buf }).stdout.toString().split('\n').filter(Boolean);
    let taskJson = null;
    try { taskJson = JSON.parse(inner.stdout.toString()); } catch { taskJson = null; }
    check('the task bundle has task.json without private.* (no ownerTokenSha256, no ipKey)',
      bundle.status === 200 && taskJson?.id === id && !('private' in taskJson) && !bundle.buf.includes('ownerTokenSha256') && names.includes('./task.json') && !names.includes('./bundle-task.json'),
      `${bundle.status}; members ${names.join(' ')}`);
  }

  // The ETA counts only runs like the next public one; a smoke test on one screen does not.
  const smoke = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', routes: ['/'], viewports: ['mobile'], schemes: ['light'], locales: ['en'], label: 'smoke one screen' } });
  if (smoke.json?.id) await settle(smoke.json.id);
  let rows = [];
  try { rows = JSON.parse(await readFile(path.join(config.STATE_DIR, 'stats.json'), 'utf8')); } catch { rows = []; }
  const rowOf = (tid) => rows.find((r) => r.id === tid);
  // stats.json keeps the last 20 runs, so this compares two recent ones: a default admin run and the smoke test.
  check('stats.json marks which finished runs may set the ETA (the full sample matrix: yes; one screen: no)',
    rowOf(linkAdmin.json?.id)?.comparable === true && rowOf(smoke.json?.id)?.comparable === false,
    `default ${rowOf(linkAdmin.json?.id)?.comparable}, one screen ${rowOf(smoke.json?.id)?.comparable}`);
  const zero = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', caps: { maxUsd: 0 } } });
  check('caps.maxUsd 0 is refused at creation (400), as the loop would refuse it', zero.status === 400 && /maxUsd/.test(zero.json?.error ?? ''), `${zero.status} ${oneLine(zero.json?.error)}`);
  const busy = await admin('GET', '/admin/busy');
  check('/admin/busy answers running, queued and the self-test in progress', busy.status === 200 && busy.json?.running === 0 && busy.json?.queued === 0 && busy.json?.selftest === null
    && busy.json?.selftestsWaiting === 0,
    oneLine(busy.text));

  // Two self-tests that overlap, on the stand-in suites: /admin/busy names the one that runs and counts
  // the one that waits, also after the first has ended (deploy.sh refuses a restart on that answer).
  // A run asked for meanwhile is held: it waits with no ETA, says why, and starts when the last one ends.
  const exists = (f) => readFile(f).then(() => true, () => false);
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await wait(20); }
    return false;
  };
  const busyNow = async () => (await admin('GET', '/admin/busy')).json ?? {};
  const stMark = (s, what) => path.join(selftestDir, `${s}.${what}`);
  const firstSt = admin('POST', '/admin/selftest', { body: { suite: 'containment' } });
  await until(() => exists(stMark('containment', 'started')));
  const secondSt = admin('POST', '/admin/selftest', { body: { suite: 'scenes' } });
  await until(async () => (await busyNow()).selftestsWaiting === 1);
  const busyBoth = await busyNow();
  const heldTask = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', routes: ['/'], viewports: ['mobile'], schemes: ['light'], locales: ['en'], label: 'held by a self-test' } });
  const hid = heldTask.json?.id;
  await wait(100);
  const heldView = recordOf((await visitor('203.0.113.60', 'GET', `/api/tasks/${hid}`)).json);
  const heldQueue = (await visitor('203.0.113.60', 'GET', '/status.json')).json?.queue;
  const heldPage = (await visitor('203.0.113.60', 'GET', '/status')).text;
  await writeFile(stMark('containment', 'go'), '');
  const firstOut = await firstSt;
  await until(() => exists(stMark('scenes', 'started')));
  const busySecond = await busyNow();
  const stillHeld = recordOf((await visitor('203.0.113.60', 'GET', `/api/tasks/${hid}`)).json);
  await writeFile(stMark('scenes', 'go'), '');
  const secondOut = await secondSt;
  const heldEnd = hid ? await settle(hid) : 'no task';
  const busyAfter = await busyNow();
  const freeQueue = (await visitor('203.0.113.60', 'GET', '/status.json')).json?.queue;
  const heldStates = hid ? (await readSse(`/api/tasks/${hid}/events`, viaCaddy('203.0.113.61'), 2000)).frames
    .filter((f) => f.event === 'state').map((f) => { try { return JSON.parse(f.data); } catch { return {}; } }) : [];
  const endsWith0 = (r, s) => r.status === 200 && new RegExp(`selftest ${s}: started, runtime \\S+\\n[\\s\\S]*1/1 ${s} checks passed[\\s\\S]*\\nselftest ${s}: exit 0\\n$`).test(r.text);
  check('/admin/busy with two self-tests that overlap: the first runs and the second waits (selftestsWaiting 1); once the first ends, it names the second while that one runs, not null; then null and 0',
    busyBoth.selftest === 'containment' && busyBoth.selftestsWaiting === 1 && busySecond.selftest === 'scenes' && busySecond.selftestsWaiting === 0
      && busyAfter.selftest === null && busyAfter.selftestsWaiting === 0 && endsWith0(firstOut, 'containment') && endsWith0(secondOut, 'scenes'),
    `both ${JSON.stringify(busyBoth)}; second ${JSON.stringify(busySecond)}; after ${JSON.stringify(busyAfter)}; ${oneLine(firstOut.text).slice(-60)} | ${oneLine(secondOut.text).slice(-60)}`);
  check('a run that waits while a self-test holds the line: held true and no ETA on its page, in its live state and on /status (with one sentence), held through both self-tests, then it runs; afterwards held is false and the ETA is back',
    heldTask.status === 202 && heldView?.state === 'queued' && heldView.held === true && heldView.position === 1 && heldView.etaSec === null
      && heldQueue?.held === true && heldQueue.queued === 1 && heldQueue.running === 0 && heldQueue.etaSec === null
      && heldPage.includes('a self-test of the sandboxes is running, and no waiting run starts until it ends')
      && stillHeld?.state === 'queued' && stillHeld.held === true && heldEnd === 'done'
      && heldStates.some((d) => d.state === 'queued' && d.held === true && d.etaSec === null) && heldStates.at(-1)?.state === 'done'
      && freeQueue?.held === false && Number.isFinite(freeQueue.etaSec),
    `view ${JSON.stringify({ state: heldView?.state, held: heldView?.held, position: heldView?.position, etaSec: heldView?.etaSec })}; /status.json queue ${JSON.stringify(heldQueue)}; `
      + `still ${stillHeld?.state}/${stillHeld?.held}; end ${heldEnd}; states ${JSON.stringify(heldStates)}; after ${JSON.stringify(freeQueue)}`);

  // The loop's createSandbox: a step after Sandbox.create() that fails (here the task record cannot be
  // written) destroys the box, because the loop never gets it. A fake box: no Docker here.
  const { sandboxStarter } = await import('../app/server.mjs');
  const fakeBox = () => ({ name: 'ring-0000fake', destroyed: 0, async runtimeName() { return 'runsc'; }, async destroy() { this.destroyed++; } });
  const starterLog = [];
  const goodBox = fakeBox();
  const patches = [];
  const started = await sandboxStarter('t_starter', { create: async () => goodBox, store: { update: (tid, p) => patches.push(p) }, journal: (tid, l) => starterLog.push(l) })({ runtime: 'runsc', labels: {} });
  const badBox = fakeBox();
  const unwritable = { update() { throw new Error('EIO: the state folder cannot be written'); } };
  const startErr = await sandboxStarter('t_starter', { create: async () => badBox, store: unwritable, journal: (tid, l) => starterLog.push(l) })({ runtime: 'runsc', labels: {} }).then(() => null, (e) => e);
  check('the loop\'s createSandbox records the runtime Docker reports; when recording fails, the new box is destroyed before the error goes on',
    started === goodBox && goodBox.destroyed === 0 && patches[0]?.sandbox?.name === 'ring-0000fake' && patches[0]?.sandbox?.runtime === 'runsc'
      && /EIO/.test(startErr?.message ?? '') && badBox.destroyed === 1,
    `recorded ${JSON.stringify(patches[0] ?? null)}; failed start: ${oneLine(startErr?.message ?? 'no error')}, destroyed ${badBox.destroyed} time(s)`);
  // --- POST /admin/speech: the video's voice (admin only; the A1 checks above show it hidden) -------------
  const PASSAGE = "This is Mantis Ring: a UI-fixing agent that can't cheat, sandboxed on Vultr. Every fix is measured, not described.";
  const speechCount = () => gw.speeches().length;
  gw.setSpeech(null);
  const s0 = speechCount();
  const spoken = await admin('POST', '/admin/speech', { body: { model: 'fake-speech', input: `  ${PASSAGE}\n`, voice: 'default', format: 'wav', language: 'English' } });
  const sentSpeech = gw.speeches().at(-1);
  const wantSeconds = Math.ceil(PASSAGE.length / 15);
  const spendView = await admin('GET', '/admin/spend');
  const ledger = (await readFile(path.join(config.STATE_DIR, 'spend.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const speechLine = ledger.filter((l) => l.kind === 'speech').at(-1);
  const speechHeaders = Object.fromEntries(Object.entries(spoken.headers).filter(([k]) => k.startsWith('x-ring-speech')));
  check('POST /admin/speech from loopback: the audio as the provider sent it, its seconds and cost in x-ring-speech-* headers, and one admin line of kind speech in the ledger',
    spoken.status === 200 && spoken.headers['content-type'] === 'audio/wav' && spoken.buf.equals(wavBytes(wantSeconds)) && speechCount() === s0 + 1
      && sentSpeech?.auth === true && sentSpeech.body?.input === PASSAGE && sentSpeech.body?.response_format === 'wav' && sentSpeech.body?.voice === 'default'
      && speechHeaders['x-ring-speech-seconds'] === String(wantSeconds) && Math.abs(Number(speechHeaders['x-ring-speech-usd']) - wantSeconds * 0.0003) < 1e-9
      && speechLine?.origin === 'admin' && speechLine?.model === 'fake-speech' && speechLine?.audioSeconds === wantSeconds && speechLine?.chars === PASSAGE.length
      && spendView.json?.speech?.today?.calls === 1 && spendView.json?.speech?.maxChars === 800 && spendView.json?.speech?.callUsd === 0.05 && !spoken.buf.includes(FAKE_KEY),
    `${spoken.status} ${spoken.headers['content-type']} ${spoken.buf.length} bytes ${oneLine(spoken.json?.error)}; ${JSON.stringify(speechHeaders)}; ledger ${JSON.stringify(speechLine)}`);

  const refusals = {
    'over 800 characters': { model: 'fake-speech', input: 'a'.repeat(801) },
    'a chat model': { model: 'fake-coder', input: PASSAGE },
    'an unpriced speech model': { model: 'fake-speech-unpriced', input: PASSAGE },
    'a model outside the catalogue': { model: 'no-such-tts', input: PASSAGE },
    'voice clone': { model: 'fake-speech', input: PASSAGE, voice: 'clone' },
    'voice design': { model: 'fake-speech', input: PASSAGE, voice: 'design' },
    'format pcm': { model: 'fake-speech', input: PASSAGE, format: 'pcm' },
    'a reference clip (unknown field)': { model: 'fake-speech', input: PASSAGE, input_references: [{ type: 'input_audio' }] },
    'speed 3': { model: 'fake-speech', input: PASSAGE, speed: 3 },
    'a control character': { model: 'fake-speech', input: `${PASSAGE}\u0007` },
    'empty text': { model: 'fake-speech', input: '   ' },
  };
  const s1 = speechCount();
  const notRefused = [];
  for (const [what, body] of Object.entries(refusals)) {
    const r = await admin('POST', '/admin/speech', { body });
    if (r.status !== 400 || !plainError(r)) notRefused.push(`${what}: ${r.status} ${oneLine(r.json?.error ?? r.text)}`);
  }
  const s2 = speechCount();
  const atCap = await admin('POST', '/admin/speech', { body: { model: 'fake-speech', input: 'a'.repeat(800), format: 'mp3' } });
  check('POST /admin/speech refuses (400, nothing sent) over 800 characters, a model that is no priced speech model, clone and design voices, pcm, unknown fields, speed 3, control characters and empty text; 800 characters pass',
    notRefused.length === 0 && s2 === s1 && atCap.status === 200 && speechCount() === s2 + 1,
    notRefused.join(' | ') || `${Object.keys(refusals).length} bodies refused; 800 characters: ${atCap.status} ${oneLine(atCap.json?.error)}`);

  gw.setSpeech(httpError(400, `unknown voice "nobody" for key ${FAKE_KEY}`, { errorType: 'invalid_request' }));
  const providerNo = await admin('POST', '/admin/speech', { body: { model: 'fake-speech', input: PASSAGE, voice: 'nobody' } });
  gw.setSpeech(sleep(800));
  const slowCall = admin('POST', '/admin/speech', { body: { model: 'fake-speech', input: PASSAGE } });
  await wait(250);
  const meanwhile = await admin('POST', '/admin/speech', { body: { model: 'fake-speech', input: PASSAGE } });
  const slowDone = await slowCall;
  gw.setSpeech(null);
  check('POST /admin/speech: the provider refusing → 502 with its sentence and the key redacted; a second call while one runs → 429',
    providerNo.status === 502 && plainError(providerNo) && /unknown voice/.test(providerNo.json?.error ?? '') && !providerNo.text.includes(FAKE_KEY)
      && meanwhile.status === 429 && slowDone.status === 200,
    `${providerNo.status} ${oneLine(providerNo.json?.error)}; meanwhile ${meanwhile.status}; the slow call ${slowDone.status}`);

  const s3 = speechCount();
  const pricey = await admin('POST', '/admin/speech', { body: { model: 'fake-speech-pricey', input: PASSAGE } });
  // Today's speech budget, nearly used up by an earlier call the ledger knows of.
  spend.speechGuard({ id: 'speech-app-api-fill', callUsd: 0.05, dayUsd: 0.5 }).after('fake-speech', {}, 0.49, { seconds: 1633, chars: 1 });
  const overDay = await admin('POST', '/admin/speech', { body: { model: 'fake-speech', input: PASSAGE } });
  check("POST /admin/speech: a call whose estimate passes $0.05, or today's $0.50 of speech, → 503 with the reason, and nothing is sent",
    pricey.status === 503 && /\$0\.05/.test(pricey.json?.error ?? '') && overDay.status === 503 && /speech budget/.test(overDay.json?.error ?? '') && speechCount() === s3,
    `${pricey.status} ${oneLine(pricey.json?.error)} | ${overDay.status} ${oneLine(overDay.json?.error)}`);

  // scripts/ring.sh tts against stand-ins for ssh: the text file goes as JSON on stdin, the audio comes
  // back on stdout into the out file, and the response headers (on stderr) give its cost.
  const ttsLog = path.join(stateDir, 'fake-ssh-tts.log');
  const ttsSsh = path.join(stateDir, 'fake-ssh-tts');
  const ttsRefused = path.join(stateDir, 'fake-ssh-tts-refused');
  await writeFile(ttsLog, '');
  await writeFile(ttsSsh, `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' "$last" >> '${ttsLog}'\ncat >> '${ttsLog}'\nprintf '\\n' >> '${ttsLog}'\n`
    + "printf 'HTTP/1.1 200 OK\\r\\ncontent-type: audio/wav\\r\\nx-ring-speech-model: chatterbox\\r\\nx-ring-speech-voice: default\\r\\nx-ring-speech-chars: 39\\r\\n"
    + "x-ring-speech-seconds: 3\\r\\nx-ring-speech-usd: 0.00084\\r\\nx-ring-speech-usd-from: provider\\r\\nx-ring-speech-today-usd: 0.00084\\r\\n\\r\\n' >&2\nprintf 'FAKE-AUDIO'\n", { mode: 0o755 });
  await writeFile(ttsRefused, "#!/bin/sh\ncat > /dev/null\nprintf 'HTTP/1.1 400 Bad Request\\r\\n\\r\\n' >&2\nprintf 'curl: (22) The requested URL returned error: 400\\n' >&2\n"
    + "printf '{\"error\":\"The text has 801 characters; one call speaks at most 800.\",\"more\":\"/latest/\"}'\nexit 22\n", { mode: 0o755 });
  const textFile = path.join(stateDir, 'passage.txt');
  await writeFile(textFile, '﻿This is Mantis Ring:\r\n   a UI-fixing agent.\n');
  const outDir = path.join(stateDir, 'tts-out');
  await mkdir(outDir, { recursive: true });
  const ringTts = (ssh, args) => spawnSync('bash', [ringSh, 'tts', ...args], {
    encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: stateDir, LANG: 'C.UTF-8', RING_TEST: '1', RING_HOST: '192.0.2.1', RING_SSH: ssh },
  });
  const ttsOk = ringTts(ttsSsh, ['chatterbox', textFile, path.join(outDir, 'sample.wav'), 'default']);
  const ttsSent = (await readFile(ttsLog, 'utf8')).split('\n');
  let ttsBody = null;
  try { ttsBody = JSON.parse(ttsSent.find((l) => l.startsWith('{')) ?? ''); } catch { ttsBody = null; }
  const ttsAudio = await readFile(path.join(outDir, 'sample.wav'), 'utf8').catch(() => null);
  const ttsNo = ringTts(ttsRefused, ['chatterbox', textFile, path.join(outDir, 'refused.wav')]);
  const leftOver = (await readdir(outDir)).filter((f) => f.startsWith('refused'));
  const ttsBad = [
    ringTts(ttsSsh, ['chatterbox', textFile, path.join(outDir, 'x.aac')]),
    ringTts(ttsSsh, ['chatterbox; rm -rf ~', textFile, path.join(outDir, 'x.wav')]),
    ringTts(ttsSsh, ['chatterbox', path.join(stateDir, 'no-such-passage.txt'), path.join(outDir, 'x.wav')]),
    ringTts(ttsSsh, ['chatterbox', textFile, path.join(outDir, 'x.wav'), 'Not A Voice']),
  ];
  const sshCalls = (await readFile(ttsLog, 'utf8')).split('\n').filter((l) => l.includes('/admin/speech')).length;
  check('scripts/ring.sh tts sends the text as JSON on stdin (white space folded, in English, with the voice), writes the audio and prints its cost; a refusal leaves no file; a bad extension, model, text file or voice stops before ssh',
    ttsOk.status === 0 && ttsBody?.model === 'chatterbox' && ttsBody?.input === 'This is Mantis Ring: a UI-fixing agent.' && ttsBody?.format === 'wav'
      && ttsBody?.voice === 'default' && ttsBody?.language === 'English' && ttsAudio === 'FAKE-AUDIO' && /3 s of audio billed, \$0\.00084 \(provider\)/.test(ttsOk.stdout)
      && ttsSent.some((l) => l.includes("--data-binary @- 'http://127.0.0.1:8080/admin/speech'")) && !ttsSent.some((l) => l.includes('Mantis Ring') && l.includes('curl'))
      && ttsNo.status !== 0 && /801 characters/.test(ttsNo.stderr) && leftOver.length === 0 && ttsBad.every((r) => r.status !== 0) && sshCalls === 1,
    `ok: exit ${ttsOk.status} ${oneLine(ttsOk.stdout)} ${oneLine(ttsOk.stderr)}; body ${JSON.stringify(ttsBody)}; refused: exit ${ttsNo.status} ${oneLine(ttsNo.stderr)}, left ${leftOver.join(' ') || 'nothing'}; `
      + `bad: ${ttsBad.map((r) => `${r.status} ${oneLine(r.stderr)}`).join(' / ')}; ${sshCalls} call(s) reached ssh`);

  // scripts/ring.sh selftest and the --selftest step of scripts/deploy.sh, against a stand-in for ssh that
  // plays the app's answers from files in RING_FAKE_DIR: a suite's stream for POST /admin/selftest, JSON
  // for /admin/busy and /status.json. deploy.sh is sourced with RING_TEST=1, so it only defines its
  // functions and one step runs alone; RING_TEST=1 refuses the real ssh, rsync and VM. These commands
  // run without blocking this process, so that a fake site served from it can answer them.
  const runAsync = (cmd, args, { env, cwd, timeout = 60_000 } = {}) => new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}${err.message}` }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end();
  });
  const deploySh = fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url));
  const play = path.join(stateDir, 'fake-ssh-play');
  await writeFile(play, String.raw`#!/bin/sh
# A stand-in for ssh: the last argument is the remote command. The app's answers come from files in
# $RING_FAKE_DIR, and every call (its arguments, then its stdin) is logged there.
d=$RING_FAKE_DIR
[ -n "$d" ] || exit 99
for last; do :; done
body=$(cat)
printf 'CALL %s\n' "$*" >> "$d/calls.log"
[ -z "$body" ] || printf 'BODY %s\n' "$body" >> "$d/calls.log"
case "$last" in
  *'/admin/busy'*) cat "$d/busy.json" ;;
  *'/admin/selftest'*)
    suite=$(printf '%s' "$body" | sed -n 's/^{"suite":"\([a-z-]*\)"}$/\1/p')
    cat "$d/st-$suite.out" 2> /dev/null
    if [ -f "$d/st-$suite.code" ]; then exit "$(cat "$d/st-$suite.code")"; fi ;;
  *'/status.json'*)
    n=$(( $(cat "$d/status.n" 2> /dev/null || echo 0) + 1 ))
    echo "$n" > "$d/status.n"
    # A read that fails (ssh, or curl -f on the VM) prints nothing and exits with that code.
    if [ -f "$d/status-$n.code" ]; then exit "$(cat "$d/status-$n.code")"; fi
    if [ -f "$d/status.code" ]; then exit "$(cat "$d/status.code")"; fi
    if [ -f "$d/status-$n.json" ]; then cat "$d/status-$n.json"; else cat "$d/status.json"; fi ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });
  const noRsync = path.join(stateDir, 'fake-rsync');
  await writeFile(noRsync, "#!/bin/sh\necho 'fake rsync: no step tested here copies anything' >&2\nexit 97\n", { mode: 0o755 });
  const COMMIT = 'abc1234';
  /** What POST /admin/selftest streams for one suite (app/server.mjs adminSelftest), with the suite's own summary line. */
  const stream = (suite, { runtime = 'runsc', passed = 18, total = 18, exit = 0, end = true } = {}) => [
    `selftest ${suite}: waiting until no task is running (new tasks wait too)`, `selftest ${suite}: started, runtime ${runtime}`,
    `runtime: ${runtime}`, 'PASS  one check', '', `${passed}/${total} ${suite} checks passed`, ...(end ? ['', `selftest ${suite}: exit ${exit}`] : []), '',
  ].join('\n');
  /** /status.json's self-test results (app/status.mjs readSelftests), each on `commit` under runsc. */
  const stored = (commit) => JSON.stringify({ selftest: {
    containment: { passed: 18, total: 18, at: '2026-11-04T15:01:00.000Z', runtime: 'runsc', commit },
    scenes: { passed: 20, total: 20, at: '2026-11-04T15:03:00.000Z', runtime: 'runsc', commit },
    agentLoop: { passed: 168, total: 168, at: '2026-11-04T15:07:00.000Z', runtime: 'runsc', commit },
  } });
  let fakeVms = 0;
  const fakeVm = async ({ busy = { running: 0, queued: 0, selftest: null }, streams = {}, codes = {}, statuses = [], status = stored(COMMIT), statusCode = null, statusCodes = {} } = {}) => {
    const dir = path.join(stateDir, `fake-vm-${++fakeVms}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'calls.log'), '');
    await writeFile(path.join(dir, 'busy.json'), JSON.stringify(busy));
    for (const s of ['containment', 'scenes', 'agent-loop']) await writeFile(path.join(dir, `st-${s}.out`), streams[s] ?? stream(s));
    for (const [s, code] of Object.entries(codes)) await writeFile(path.join(dir, `st-${s}.code`), String(code));
    for (const [i, json] of statuses.entries()) await writeFile(path.join(dir, `status-${i + 1}.json`), json);
    await writeFile(path.join(dir, 'status.json'), status);
    if (statusCode !== null) await writeFile(path.join(dir, 'status.code'), String(statusCode));
    for (const [n, code] of Object.entries(statusCodes)) await writeFile(path.join(dir, `status-${n}.code`), String(code));
    return dir;
  };
  const callsTo = async (dir) => {
    const log = await readFile(path.join(dir, 'calls.log'), 'utf8');
    return { log, posted: [...log.matchAll(/^BODY \{"suite":"([a-z-]+)"\}$/gm)].map((m) => m[1]), statusReads: (log.match(/^CALL .*\/status\.json/gm) ?? []).length };
  };
  const scriptEnv = (extra) => ({ PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: stateDir, LANG: 'C.UTF-8', RING_TEST: '1', RING_HOST: '192.0.2.1', RING_SSH: play, ...extra });
  const deployLines = (r) => oneLine(r.stderr.split('\n').filter((l) => /^(deploy|ring\.sh): /.test(l)).join(' '));

  const ringSelftest = async (suite, vm) => {
    const dir = await fakeVm(vm);
    return { ...(await runAsync('bash', [ringSh, 'selftest', suite], { env: scriptEnv({ RING_FAKE_DIR: dir }) })), ...(await callsTo(dir)) };
  };
  // A suite's own output with an "exit 0" line in it, then cut short before the app's last line.
  const forged = 'selftest containment: waiting until no task is running (new tasks wait too)\nselftest containment: started, runtime runsc\nselftest containment: exit 0\nPASS  one check\n';
  const [stOk, stFailed, stCut, stForged, stUnknown] = await Promise.all([
    ringSelftest('containment'),
    ringSelftest('scenes', { streams: { scenes: stream('scenes', { passed: 19, total: 20, exit: 1 }) } }),
    ringSelftest('agent-loop', { streams: { 'agent-loop': stream('agent-loop', { end: false }) }, codes: { 'agent-loop': 255 } }),
    ringSelftest('containment', { streams: { containment: forged } }),
    ringSelftest('everything'),
  ]);
  const keepalive = /^CALL .* -o ServerAliveInterval=30 -o ServerAliveCountMax=6 deploy@192\.0\.2\.1 curl -sSN --fail-with-body -X POST -H 'content-type: application\/json' --data-binary @- 'http:\/\/127\.0\.0\.1:8080\/admin\/selftest'$/m;
  check('scripts/ring.sh selftest sends {"suite":…} on stdin to POST /admin/selftest with SSH keepalives, and exits 0 only when the last line is "selftest <suite>: exit 0"; a non-zero exit line, a stream cut short (after an earlier "exit 0" line too) and an unknown suite fail',
    stOk.status === 0 && keepalive.test(stOk.log) && stOk.posted.join() === 'containment'
      && stFailed.status !== 0 && /the self-test failed: selftest scenes: exit 1$/m.test(stFailed.stderr)
      && stCut.status !== 0 && /no final 'selftest agent-loop: exit N' line came back \(curl\/ssh exit 255\)/.test(stCut.stderr)
      && stForged.status !== 0 && /no final 'selftest containment: exit N' line/.test(stForged.stderr)
      && stUnknown.status !== 0 && stUnknown.log === '' && /suite must be agent-loop, containment or scenes/.test(stUnknown.stderr),
    [stOk, stFailed, stCut, stForged, stUnknown].map((r) => `exit ${r.status}${r.posted.length ? `, posted ${r.posted.join(' ')}` : ''} ${deployLines(r)}`).join(' | '));

  const deployStep = async (call, vm, { env = {}, cwd } = {}) => {
    const dir = await fakeVm(vm);
    const r = await runAsync('bash', ['-c', `source "$1"\n${call}`, 'deploy-test', deploySh],
      { cwd, env: scriptEnv({ RING_RSYNC: noRsync, RING_URL: 'http://127.0.0.1:9', RING_FAKE_DIR: dir, ...env }) });
    return { ...r, ...(await callsTo(dir)) };
  };
  const selftestStep = (vm, tries = 8) => deployStep(`STATUS_TRIES=${tries}; STATUS_PAUSE=0; run_selftests ${COMMIT}`, vm);
  const [okIdle, okBusy, notTest] = await Promise.all([
    selftestStep({}),
    selftestStep({ busy: { running: 1, queued: 2, selftest: null }, statuses: [stored('0000000')] }),
    deployStep(`run_selftests ${COMMIT}`, {}, { env: { RING_TEST: '' } }),
  ]);
  const inOrder = (r) => r.posted.join() === 'containment,scenes,agent-loop'
    && (r.log.match(/^CALL .* -o ServerAliveInterval=30 -o ServerAliveCountMax=6 deploy@192\.0\.2\.1 curl -sSN .*'http:\/\/127\.0\.0\.1:8080\/admin\/selftest'$/gm) ?? []).length === 3;
  check('scripts/deploy.sh --selftest: one POST /admin/selftest per suite, containment, scenes, agent-loop, through scripts/ring.sh with SSH keepalives; a busy VM is reported, not refused; then /status.json must show every result on the deployed commit under runsc, read again while it still shows earlier ones; sourced without RING_TEST=1 it stops',
    okIdle.status === 0 && inOrder(okIdle) && /^idle: no task running or waiting, no self-test$/m.test(okIdle.stdout) && okIdle.statusReads === 1
      && /^18\/18 containment checks passed\n18\/18 scenes checks passed\n18\/18 agent-loop checks passed$/m.test(okIdle.stdout)
      && /^\/status\.json: agent-loop 168\/168 under runsc on abc1234 at 2026-11-04T15:07:00\.000Z$/m.test(okIdle.stdout)
      && okBusy.status === 0 && inOrder(okBusy) && okBusy.statusReads === 2
      && /^busy: 1 task\(s\) running, 2 waiting, self-test: none\. Each suite waits until no task runs/m.test(okBusy.stdout)
      && notTest.status !== 0 && notTest.log === '' && /sourced only by tests, with RING_TEST=1/.test(notTest.stderr),
    [okIdle, okBusy, notTest].map((r) => `exit ${r.status}, posted ${r.posted.join(' ') || 'nothing'}, ${r.statusReads} status read(s) ${deployLines(r)}`).join(' | '));

  const [badRuntime, badExit, noExit, badCount, noStart, staleStatus] = await Promise.all([
    selftestStep({ streams: { containment: stream('containment', { runtime: 'runc' }) } }),
    selftestStep({ streams: { scenes: stream('scenes', { passed: 19, total: 20, exit: 1 }) } }),
    selftestStep({ streams: { 'agent-loop': stream('agent-loop', { end: false }) } }),
    selftestStep({ streams: { containment: stream('containment', { passed: 17, total: 18 }) } }),
    selftestStep({ streams: { containment: '' }, codes: { containment: 255 } }),
    selftestStep({ status: stored('0000000') }, 2),
  ]);
  check('scripts/deploy.sh --selftest stops at the first suite that fails and names it: a start under another runtime than runsc, a last line other than "exit 0" or none, a summary line with n ≠ m, no start at all; results in /status.json on another commit fail after its retries',
    badRuntime.status !== 0 && /the containment self-test did not run under gVisor: 'selftest containment: started, runtime runc'/.test(badRuntime.stderr) && badRuntime.posted.join() === 'containment'
      && badExit.status !== 0 && /the scenes self-test failed: its last line is 'selftest scenes: exit 1', not 'selftest scenes: exit 0'/.test(badExit.stderr) && badExit.posted.join() === 'containment,scenes'
      && noExit.status !== 0 && /the agent-loop self-test failed: its last line is '18\/18 agent-loop checks passed', not 'selftest agent-loop: exit 0'/.test(noExit.stderr) && noExit.posted.length === 3
      && badCount.status !== 0 && /the containment self-test did not pass every check: 17\/18 containment checks passed/.test(badCount.stderr) && badCount.posted.join() === 'containment'
      && noStart.status !== 0 && /the containment self-test did not start \(no 'selftest containment: started' line; the last line: none\)/.test(noStart.stderr) && noStart.posted.join() === 'containment'
      && [badRuntime, badExit, noExit, badCount, noStart].every((r) => r.statusReads === 0)
      && staleStatus.status !== 0 && staleStatus.posted.length === 3 && staleStatus.statusReads === 2
      && /^\/status\.json: containment 18\/18 under runsc on 0000000 at .* \(not a pass under runsc on abc1234\)$/m.test(staleStatus.stderr)
      && /does not show every suite passing under runsc on abc1234/.test(staleStatus.stderr),
    [badRuntime, badExit, noExit, badCount, noStart, staleStatus].map((r) => `exit ${r.status}, posted ${r.posted.join(' ') || 'nothing'}, ${r.statusReads} status read(s): ${deployLines(r)}`).join(' | '));

  // /status.json that cannot be read after the suites passed: the deploy names the ssh/curl failure, not
  // missing results; one failed read before a good one is only tried again.
  const [unreadable, readLater] = await Promise.all([
    selftestStep({ statusCode: 255 }, 2),
    selftestStep({ statusCodes: { 1: 22 } }, 3),
  ]);
  check('scripts/deploy.sh --selftest: when /status.json cannot be read after every suite passed, it fails naming the ssh/curl exit code after its retries, not "no self-test results"; a read that fails once and then works passes',
    unreadable.status !== 0 && unreadable.posted.length === 3 && unreadable.statusReads === 2
      && /^could not read \/status\.json on the VM \(ssh\/curl exit 255\)$/m.test(unreadable.stderr)
      && /deploy: every suite passed \(lines above\), but \/status\.json could not be read on the VM after 2 tries \(ssh\/curl exit 255\)/.test(unreadable.stderr)
      && !/no self-test results/.test(unreadable.stdout + unreadable.stderr)
      && readLater.status === 0 && readLater.statusReads === 2 && /^\/status\.json: scenes 20\/20 under runsc on abc1234/m.test(readLater.stdout),
    [unreadable, readLater].map((r) => `exit ${r.status}, posted ${r.posted.join(' ') || 'nothing'}, ${r.statusReads} status read(s): ${deployLines(r)}`).join(' | '));

  // Step 7 checks the queue again just before the swap: steps 5 and 6 take half a minute or more, and a
  // task that started meanwhile would be interrupted by the restart. Refused, nothing is swapped.
  const swaps = (r) => (r.log.match(/^CALL .* deploy@192\.0\.2\.1 rsync -a --delete .* \/srv\/mantis-ring\/ ring-prev\/ && rsync -a --delete .* ring-next\/ \/srv\/mantis-ring\/$/gm) ?? []).length;
  const [swapIdle, swapBusy, swapSelftest, swapForced] = await Promise.all([
    deployStep('force=no; swap_in', {}),
    deployStep('force=no; swap_in', { busy: { running: 1, queued: 0, selftest: null, selftestsWaiting: 0 } }),
    deployStep('force=no; swap_in', { busy: { running: 0, queued: 0, selftest: 'scenes', selftestsWaiting: 1 } }),
    deployStep('force=yes; swap_in', { busy: { running: 0, queued: 1, selftest: null, selftestsWaiting: 0 } }),
  ]);
  check('scripts/deploy.sh step 7 asks /admin/busy again just before the swap and the restart: a task that runs or waits, or a self-test, stops it with the live tree untouched (no swap), and says so; idle, or with --force, it swaps',
    swapIdle.status === 0 && swaps(swapIdle) === 1 && /^idle: no task running or waiting, no self-test$/m.test(swapIdle.stdout)
      && swapBusy.status !== 0 && swaps(swapBusy) === 0
      && /deploy: 1 task\(s\) running, 0 waiting, self-test: none\. A restart would stop them\. Wait, or pass --force \(the staged tree is in ring-next\/; the live tree and the service were not touched\)/.test(swapBusy.stderr)
      && swapSelftest.status !== 0 && swaps(swapSelftest) === 0 && /0 task\(s\) running, 0 waiting, self-test: scenes\./.test(swapSelftest.stderr)
      && swapForced.status === 0 && swaps(swapForced) === 1 && /^0 running, 1 waiting, self-test none; going on anyway \(--force\)$/m.test(swapForced.stdout),
    [swapIdle, swapBusy, swapSelftest, swapForced].map((r) => `exit ${r.status}, ${swaps(r)} swap(s) ${deployLines(r)}`).join(' | '));

  // The outside checks of scripts/deploy.sh against a fake site on 127.0.0.1 that stands in for Caddy
  // and the app: RING_HEALTHCHECK's script when it is set, the built-in health check otherwise.
  const site = { seen: [], status: '<code>runtime: runsc</code>', latest: 200 };
  const siteServer = http.createServer((req, res) => {
    site.seen.push(req.url);
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (req.url === '/') return send(200, 'text/html', '<title>Mantis Ring</title>');
    if (req.url === '/latest/') return send(site.latest, 'text/html', '<title>Latest verified run</title>');
    if (req.url === '/status') return send(200, 'text/html', site.status);
    if (req.url === '/api/config') return send(200, 'application/json', JSON.stringify({ publicSampleRuns: false, publicGithubRuns: false }));
    return send(404, 'application/json', '{"error":"Not found."}');
  });
  await new Promise((ok) => siteServer.listen(0, '127.0.0.1', ok));
  try {
    const siteUrl = `http://127.0.0.1:${siteServer.address().port}`;
    const hcDir = path.join(stateDir, 'healthchecks');
    const hcArgsFile = path.join(stateDir, 'healthcheck-args.txt');
    await mkdir(hcDir, { recursive: true });
    await writeFile(path.join(hcDir, 'hc-ok.sh'), `printf '%s\\n' "$*" > '${hcArgsFile}'\necho "2026-11-04T15:00:00Z OK $1 | stand-in"\n`);
    await writeFile(path.join(hcDir, 'hc-fail.sh'), `printf '%s\\n' "$*" > '${hcArgsFile}'\necho "2026-11-04T15:00:00Z FAIL $1 | stand-in"\nexit 1\n`);
    const outside = async (env = {}, cwd = undefined) => {
      site.seen = [];
      await rm(hcArgsFile, { force: true });
      const r = await deployStep('outside_checks', {}, { cwd, env: { RING_URL: siteUrl, ...env } });
      return { ...r, seen: site.seen.join(' '), hcArgs: (await readFile(hcArgsFile, 'utf8').catch(() => '')).trim() };
    };
    const okLine = new RegExp(`^\\S+ OK ${siteUrl.replace(/[.]/g, '\\.')} \\| / 200 [0-9.]+s \\| /latest/ 200 [0-9.]+s \\| /status 200 [0-9.]+s$`, 'm');
    const builtIn = await outside();
    Object.assign(site, { status: '<code>runtime: unavailable</code>', latest: 404 });
    const builtInFails = await outside();
    Object.assign(site, { status: '<code>runtime: runsc</code>', latest: 200 });
    check('scripts/deploy.sh outside checks without RING_HEALTHCHECK: /, /latest/ and /status must answer 200 and /status name runsc, in one line as healthcheck.sh prints it, then /admin/health must be a 404 and both switches closed; a page that is not 200 or a /status without runsc stops the deploy',
      builtIn.status === 0 && okLine.test(builtIn.stdout) && /^\/admin\/health through Caddy: 404$/m.test(builtIn.stdout)
        && /^public runs: sample false, GitHub false$/m.test(builtIn.stdout) && builtIn.seen === '/ /latest/ /status /admin/health /api/config' && builtIn.log === ''
        && builtInFails.status !== 0 && /^\S+ FAIL .* \| \/latest\/ 404 [0-9.]+s FAIL \| \/status 200 [0-9.]+s \(no 'runsc'\)$/m.test(builtInFails.stderr)
        && /deploy: the outside health check did not pass/.test(builtInFails.stderr) && builtInFails.seen === '/ /latest/ /status',
      `ok: exit ${builtIn.status}, asked ${builtIn.seen}: ${oneLine(builtIn.stdout)} | failing: exit ${builtInFails.status}, asked ${builtInFails.seen}: ${oneLine(builtInFails.stderr)}`);

    const viaScript = await outside({ RING_HEALTHCHECK: 'hc-ok.sh' }, hcDir);
    const scriptFails = await outside({ RING_HEALTHCHECK: path.join(hcDir, 'hc-fail.sh') });
    const noScript = await outside({ RING_HEALTHCHECK: path.join(hcDir, 'no-such-healthcheck.sh') });
    const dirScript = await outside({ RING_HEALTHCHECK: hcDir });
    check('scripts/deploy.sh outside checks with RING_HEALTHCHECK: that script runs with the URL and --status-grep runsc instead of the built-in checks (a relative path is the caller\'s), and its failure stops the deploy; a RING_HEALTHCHECK that is no readable file stops deploy.sh before anything runs',
      viaScript.status === 0 && viaScript.hcArgs === `${siteUrl} --status-grep runsc` && viaScript.stdout.includes(`OK ${siteUrl} | stand-in`)
        && viaScript.seen === '/admin/health /api/config'
        && scriptFails.status !== 0 && scriptFails.stderr.includes(`FAIL ${siteUrl} | stand-in`) && /hc-fail\.sh did not pass \(its line above\)/.test(scriptFails.stderr) && scriptFails.seen === ''
        && noScript.status !== 0 && /RING_HEALTHCHECK is set but is not a readable file: \S*no-such-healthcheck\.sh/.test(noScript.stderr) && noScript.seen === '' && noScript.hcArgs === ''
        && dirScript.status !== 0 && /RING_HEALTHCHECK is set but is not a readable file/.test(dirScript.stderr) && dirScript.seen === '',
      [viaScript, scriptFails, noScript, dirScript].map((r) => `exit ${r.status}, args '${r.hcArgs}', asked '${r.seen}' ${deployLines(r)}`).join(' | '));

    const urls = ['', 'https://104-156-252-200.sslip.io', 'http://104-156-252-200.sslip.io', 'https://127.0.0.1', 'http://192.0.2.1:8080'];
    const refusedUrls = await Promise.all(urls.map((u) => outside({ RING_URL: u })));
    check('scripts/deploy.sh with RING_TEST=1 refuses any RING_URL but a loopback http:// address (the real site is the default), before anything runs',
      refusedUrls.every((r) => r.status !== 0 && /RING_TEST=1, but RING_URL is not a loopback http:\/\/ address/.test(r.stderr) && r.log === '') && site.seen.length === 0,
      refusedUrls.map((r, i) => `'${urls[i]}': exit ${r.status} ${deployLines(r)}`).join(' | '));
  } finally {
    siteServer.close();
  }

  check('no request reached the model service', gw.chats().length === 0, `${gw.chats().length} chat requests`);
} catch (err) {
  check('app-api tests ran to the end', false, `stopped: ${err.stack?.split('\n').slice(0, 3).join(' ') ?? err}`);
} finally {
  fake.releaseAll();
  try {
    if (app) await app.close();
  } catch (err) {
    console.error(`app close failed: ${err.message}`);
  }
  await gw.close();
  await rm(stateDir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass);
if (failed.length && journal.length) {
  console.log('\nlast lines of the app log:');
  for (const line of journal.slice(-12)) console.log(`      ${oneLine(line)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} app-api checks passed`);
process.exit(failed.length ? 1 : 0);
