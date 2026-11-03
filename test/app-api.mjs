#!/usr/bin/env node
// Tests for the web app's HTTP API (build spec §4, §6.1 A1-A6) with no Docker and no model: the real
// createApp() with its real config, task store, queue and spend ledger in a temporary state folder,
// and a fake runFix that finishes (or waits) on command. It checks the routes, the local-admin rule
// D-4 (loopback peer, no X-Forwarded-For, loopback Host), D-5 (public runs closed), the per-IP and
// queue limits, approve/patch with the owner token, and SSE replay. /status talks to
// test/fake-gateway.mjs, never to the real inference service. Each check prints PASS or FAIL.
// Usage: node test/app-api.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { FAKE_KEY, startFakeGateway } from './fake-gateway.mjs';

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
    containment: { runtime: 'runc', sandbox: 'ring-00000000', limits: { memory: '3g', cpus: '2', pids: 512 }, network: 'ring-internal → ring-proxy (allowlist)', destroyed: true, goneCheck: 'docker ps -a: gone' },
    mantis: { version: '0.7.1', baselineRunId: '2026-11-04T05-00-00', finalRunId: '2026-11-04T05-01-00', comparedWith: 'baseline run (R0)' },
    verdict: 'pass', publishable: false, promptVersion: 'ring-1',
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
  app = createApp({ config, store, queue, spend, runFix: fake.runFix, publish: fakePublish, status, now: Date.now, log, approval: approvalCfg });
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
  const st = await visitor('203.0.113.1', 'GET', '/status');
  const stj = await visitor('203.0.113.1', 'GET', '/status.json');
  check('GET /status (HTML) and /status.json answer; neither shows the key or the environment',
    st.status === 200 && /text\/html/.test(st.headers['content-type'] ?? '') && stj.status === 200 && stj.json && typeof stj.json === 'object'
      && ![st.text, stj.text].some((t) => t.includes(FAKE_KEY) || t.includes('VULTR_INFERENCE') || t.includes('RING_STATE_DIR')),
    `${st.status} / ${stj.status}; ok=${stj.json?.ok}; inference reachable=${stj.json?.inference?.reachable}`);
  const cfg = await visitor('203.0.113.1', 'GET', '/api/config');
  check('GET /api/config: provider, models, samples, publicRuns false',
    cfg.status === 200 && cfg.json?.provider === 'Vultr Serverless Inference' && cfg.json?.publicRuns === false && typeof cfg.json?.fixModel === 'string'
      && Array.isArray(cfg.json?.samples) && cfg.json.samples.some((s) => s.id === 'lumen' && typeof s.label === 'string' && typeof s.etaText === 'string'),
    oneLine(cfg.text));
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
    } finally {
      await new Promise((resolve) => side.close(resolve));
    }
  }
  const before = await admin('GET', '/admin/tasks');
  const listOf = (r) => (Array.isArray(r.json) ? r.json : r.json?.tasks ?? []);
  const countBefore = listOf(before).length;
  const hidden = [];
  for (const [method, p, body] of [['GET', '/admin/config'], ['GET', '/admin/tasks'], ['GET', '/admin/spend'], ['POST', '/admin/tasks', { sample: 'lumen' }],
    ['POST', '/admin/config', { publicRuns: true }], ['POST', '/admin/selftest', { suite: 'agent-loop' }], ['POST', '/admin/probe', { models: ['fake-coder'] }]]) {
    const r = await visitor('203.0.113.7', method, p, body === undefined ? {} : { body });
    if (r.status !== 404) hidden.push(`${method} ${p}: ${r.status}`);
  }
  const after = await admin('GET', '/admin/tasks');
  const cfgAfter = await admin('GET', '/admin/config');
  check('A1 every /admin/* route answers 404 through Caddy and changes nothing',
    hidden.length === 0 && listOf(after).length === countBefore && cfgAfter.json?.publicRuns === false && gw.chats().length === 0,
    hidden.join('; ') || `7 routes hidden; tasks ${countBefore} → ${listOf(after).length}; publicRuns ${cfgAfter.json?.publicRuns}`);

  // --- A2 / D-5: public runs are closed --------------------------------------------------------------
  const closed = await visitor('203.0.113.8', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  const afterClosed = listOf(await admin('GET', '/admin/tasks')).length;
  check('A2 POST /api/tasks answers 503 with a sentence while publicRuns is false, and starts nothing',
    closed.status === 503 && plainError(closed) && /open/i.test(closed.json?.error ?? '') && afterClosed === countBefore && fake.seen.length === 0,
    `${closed.status} ${oneLine(closed.text)}`);

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
    // The operator who created the task holds its owner token. With a passphrase set, the token alone
    // approves nothing: not through Caddy, and not over SSH to 127.0.0.1 with a made-up X-Forwarded-For.
    const tokenOnly = await visitor('203.0.113.9', 'POST', `/api/tasks/${id}/approve`, { body: {}, headers: owner });
    const spoofed = await admin('POST', `/api/tasks/${id}/approve`, { body: {}, headers: { ...owner, 'x-forwarded-for': '1.1.1.1' } });
    const wrongPass = await visitor('203.0.113.9', 'POST', `/api/tasks/${id}/approve`, { body: { passphrase: 'not it' }, headers: owner });
    const still = recordOf((await admin('GET', `/admin/tasks/${id}`)).json);
    check('A5 with an approval passphrase set, the owner token alone cannot approve (via Caddy, or admin + token + spoofed XFF): 403',
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
  const badValue = await admin('POST', '/admin/config', { body: { publicRuns: 'yes' } });
  check('/admin/config refuses unknown keys and bad values (400)', unknownKey.status === 400 && badValue.status === 400, `${unknownKey.status}, ${badValue.status}`);
  const open = await admin('POST', '/admin/config', { body: { publicRuns: true } });
  const cfgOpen = await visitor('203.0.113.1', 'GET', '/api/config');
  check('POST /admin/config {publicRuns:true} switches public runs on', open.status === 200 && cfgOpen.json?.publicRuns === true, `${open.status}; /api/config publicRuns ${cfgOpen.json?.publicRuns}`);

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
  const privateIp = await visitor('10.1.2.3', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  const loopIp = await visitor('127.0.0.1', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  check('task creation from a private or loopback client address → 403', privateIp.status === 403 && loopIp.status === 403, `10.1.2.3 → ${privateIp.status}; 127.0.0.1 → ${loopIp.status}`);

  const lastEntry = await visitor('10.9.9.9, 203.0.113.30', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  const lastId = lastEntry.json?.id;
  const lastSeen = fake.seen.find((t) => t.id === lastId);
  check('the client address is the last X-Forwarded-For entry (a spoofed first entry is ignored)', lastEntry.status === 202, `${lastEntry.status} ${oneLine(lastEntry.json?.error)}`);
  if (lastId) await settle(lastId);
  check('a public task always has the gate on, the configured model and at most $0.60',
    lastSeen?.gate === true && lastSeen?.model === config.get().fixModel && typeof lastSeen?.caps?.maxUsd === 'number' && lastSeen.caps.maxUsd <= 0.6,
    `gate ${lastSeen?.gate}, model ${lastSeen?.model}, maxUsd ${lastSeen?.caps?.maxUsd}`);

  // One run in progress per address.
  fake.mode = 'block';
  const first = await visitor('203.0.113.40', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  await wait(100);
  const second = await visitor('203.0.113.40', 'POST', '/api/tasks', { body: { sample: 'lumen' } });
  check('one run in progress per address: a second start → 429 with a sentence', first.status === 202 && second.status === 429 && plainError(second),
    `${first.status}, then ${second.status} ${oneLine(second.json?.error)}`);
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

  const pubTry = await admin('POST', `/admin/publish/${id ?? 'x'}`, { body: {} });
  check('POST /admin/publish/:id refuses a TEST RUN receipt (409) and publishes nothing', pubTry.status === 409 && published.length === 0, `${pubTry.status} ${oneLine(pubTry.json?.error ?? pubTry.text)}`);

  // Without a passphrase on the server the owner link alone approves, and the record says only that.
  approvalCfg.passphraseSha256 = null;
  const linkTask = lastEntry.json?.ownerToken ? lastId : null;
  if (!linkTask) {
    skip('approval with the owner link only', 'the public task from the XFF check did not start');
  } else {
    const viaLink = await visitor('203.0.113.30', 'POST', `/api/tasks/${linkTask}/approve`, { body: {}, headers: { 'x-ring-owner': lastEntry.json.ownerToken } });
    const linkRec = recordOf((await visitor('203.0.113.30', 'GET', `/api/tasks/${linkTask}`)).json);
    check('without an approval passphrase the owner link approves, recorded as approvedWith owner-link',
      viaLink.status === 200 && linkRec?.approvedWith === 'owner-link' && linkRec?.approvalNeedsPassphrase === false, `${viaLink.status}; approvedWith ${linkRec?.approvedWith}`);
  }

  // The publish bar and the published page (app/publish.mjs), on receipts the fake loop never writes.
  const pub = await import('../app/publish.mjs');
  const passing = { ...fakeReceipt({ id: `t_${'a'.repeat(32)}`, source: { kind: 'sample', name: 'lumen' }, matrix: {}, model: 'm' }), label: 'REAL RUN · Vultr VX1 sea · 2026-11-04 05:12 UTC', publishable: true };
  const sampleTask = { id: passing.taskId, source: { kind: 'sample', label: 'Lumen (sample site)' } };
  const lostOne = { ...passing, counts: { ...passing.counts, lost: 1 } };
  const screens = { ...passing, counts: { ...passing.counts, cellsCompared: 8, cellsExpected: 16 } };
  const noApply = { ...passing, diff: { ...passing.diff, applies: false } };
  check('the publish bar refuses lost controls, unmeasured screens and a patch that does not apply',
    pub.notPublishable(sampleTask, passing) === null && /lost control/.test(pub.notPublishable(sampleTask, lostOne) ?? '')
      && /compared 8 of the 16 screens/.test(pub.notPublishable(sampleTask, screens) ?? '') && /does not apply/.test(pub.notPublishable(sampleTask, noApply) ?? ''),
    [passing, lostOne, screens, noApply].map((r) => pub.notPublishable(sampleTask, r) ?? 'publishable').join(' | '));
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
  check('stats.json marks which finished runs may set the ETA (the full sample matrix: yes; one screen: no)',
    rowOf(id)?.comparable === true && rowOf(smoke.json?.id)?.comparable === false, `default ${rowOf(id)?.comparable}, one screen ${rowOf(smoke.json?.id)?.comparable}`);
  const zero = await admin('POST', '/admin/tasks', { body: { sample: 'lumen', caps: { maxUsd: 0 } } });
  check('caps.maxUsd 0 is refused at creation (400), as the loop would refuse it', zero.status === 400 && /maxUsd/.test(zero.json?.error ?? ''), `${zero.status} ${oneLine(zero.json?.error)}`);
  const busy = await admin('GET', '/admin/busy');
  check('/admin/busy answers running, queued and the self-test in progress', busy.status === 200 && busy.json?.running === 0 && busy.json?.queued === 0 && busy.json?.selftest === null,
    oneLine(busy.text));
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
