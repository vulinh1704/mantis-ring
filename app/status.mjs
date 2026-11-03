// The /status page and its JSON (BUILD-SPEC §4.7): every value is measured live or read from a real
// self-test run. Docker, the egress proxy and Serverless Inference are asked with short timeouts and the
// answers are cached (5 min, 30 s, 60 s), so a flood of /status requests never becomes a flood of
// processes or API calls. No environment variable and no key is shown anywhere, and a self-test that
// has no result file is shown as missing, never as a number.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ping } from '../agent/inference.mjs';
import { APP_LABEL, LIMITS, run } from '../runner/sandbox.mjs';
import { PROVIDER, STATE_DIR } from './config.mjs';

export const NETWORK = 'ring-internal → ring-proxy (allowlist)';
const SUITES = [['containment', 'containment'], ['scenes', 'scenes'], ['agentLoop', 'agent-loop']];
const VERSION_FILE = new URL('./VERSION.json', import.meta.url);

/** HTML-escape a value for text and attribute positions. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** One line, at most `max` characters: for logs and short notes. */
export function oneLine(v, max = 300) {
  const s = String(v?.message ?? v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "2026-11-04 05:12 UTC" from an ISO time, or '' for anything else. */
export function utcText(iso) {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
}

/** "$0.0731" for small amounts, "$1.25" otherwise, "n/a" when unknown. */
export function usdText(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/**
 * Cache an async probe that never rejects. `ttl(value)` says how long a value stays fresh. Only the
 * first call waits; after that a stale value is returned at once while one refresh runs in the
 * background, so /status stays fast even when Docker or the model service is slow to answer.
 */
function cached(fn, ttl) {
  let value, at = 0, pending = null;
  const refresh = () => {
    pending ??= fn()
      .then((v) => { value = v; at = Date.now(); return v; })
      .finally(() => { pending = null; });
    return pending;
  };
  return () => {
    if (value === undefined) return refresh();
    if (Date.now() - at >= ttl(value)) refresh().catch(() => {});
    return Promise.resolve(value);
  };
}

/** Docker's runtimes, from `docker info`: {docker, runtimes[], error}. Cached 5 min (30 s after a failure). */
const runtimeInfo = cached(async () => {
  const r = await run('docker', ['info', '--format', '{{json .Runtimes}}'], { timeoutMs: 8000 });
  if (r.code !== 0) return { docker: false, runtimes: [], error: oneLine(r.stderr || `docker info exit ${r.code}`, 160) };
  let runtimes = [];
  try { runtimes = Object.keys(JSON.parse(r.stdout)); } catch { runtimes = r.stdout.includes('"runsc"') ? ['runsc'] : []; }
  return { docker: true, runtimes, error: null };
}, (v) => (v.docker ? 300_000 : 30_000));

/** 'running' | 'stopped' | 'missing' for the allowlist proxy container. Cached 30 s. */
async function proxyState() {
  const r = await run('docker', ['inspect', '-f', '{{.State.Running}}', 'ring-proxy'], { timeoutMs: 5000 });
  if (r.code !== 0) return 'missing';
  return r.stdout.trim() === 'true' ? 'running' : 'stopped';
}
const proxyInfo = cached(proxyState, () => 30_000);

/** Serverless Inference reachability with the key (no tokens spent). Cached 60 s. */
const inferenceInfo = cached(async () => {
  const checkedAt = new Date().toISOString();
  let p;
  try { p = await ping(); } catch (err) { p = { ok: false, error: oneLine(err, 120) }; }
  return {
    reachable: !!p?.ok, status: p?.status ?? null, ms: p?.ms ?? null,
    error: p?.ok ? null : oneLine(p?.error ?? 'no answer', 120), checkedAt,
  };
}, () => 60_000);

let selftestCache = { at: 0, value: null };
/**
 * The last self-test results (§1.13): ~/.ring/selftest/<suite>.json, written by the test suites.
 * A suite without a readable file is null. Cached 30 s.
 */
export function readSelftests(home = os.homedir()) {
  if (selftestCache.value && Date.now() - selftestCache.at < 30_000 && home === os.homedir()) return selftestCache.value;
  const out = {};
  for (const [key, suite] of SUITES) {
    try {
      const j = JSON.parse(readFileSync(path.join(home, '.ring', 'selftest', `${suite}.json`), 'utf8'));
      out[key] = Number.isInteger(j?.passed) && Number.isInteger(j?.total)
        ? { passed: j.passed, total: j.total, at: typeof j.at === 'string' ? j.at : null, runtime: typeof j.runtime === 'string' ? j.runtime : null }
        : null;
    } catch {
      out[key] = null;
    }
  }
  if (home === os.homedir()) selftestCache = { at: Date.now(), value: out };
  return out;
}

let versionCache;
/** app/VERSION.json, written by scripts/deploy.sh; null when the app was not deployed with it. */
function readVersion() {
  if (versionCache !== undefined) return versionCache;
  try {
    const v = JSON.parse(readFileSync(VERSION_FILE, 'utf8'));
    versionCache = { commit: typeof v.commit === 'string' ? v.commit : null, dirty: typeof v.dirty === 'boolean' ? v.dirty : null, deployedAt: typeof v.deployedAt === 'string' ? v.deployedAt : null };
  } catch {
    versionCache = null;
  }
  return versionCache;
}

/** The last published run, from <STATE_DIR>/latest.json (written by POST /admin/publish). */
export function readLatest() {
  try {
    const j = JSON.parse(readFileSync(path.join(STATE_DIR, 'latest.json'), 'utf8'));
    return typeof j?.taskId === 'string' ? { taskId: j.taskId, at: j.at ?? null, line: j.line ?? null } : null;
  } catch {
    return null;
  }
}

function spendSummary(spend, cfg) {
  if (!spend) return null;
  try {
    const t = spend.today();
    const caps = spend.caps ?? cfg.spendCaps;
    return {
      day: t.day, publicUsd: t.publicUsd, publicCapUsd: caps.publicDayUsd, adminUsd: t.adminUsd, adminCapUsd: caps.adminDayUsd,
      dayUsd: t.totalUsd, totalUsd: spend.total(), totalCapUsd: caps.totalUsd, tokens: t.tokens, unpricedCalls: t.unpricedCalls ?? 0,
    };
  } catch (err) {
    return { error: oneLine(err, 120) };
  }
}

/**
 * Everything /status shows (§4.7).
 * @param {{cfg:object, queue:{running():string[], queued():string[], maxRunning:number}, spend:object|null,
 *          startedAt:number, now?:() => number, runtime?:string, etaSec?:number|null}} ctx
 */
export async function statusData(ctx) {
  const { cfg, queue, spend, startedAt, now = Date.now, runtime, etaSec = null } = ctx;
  const [rt, proxy, inference] = await Promise.all([runtimeInfo(), proxyInfo(), inferenceInfo()]);
  const configured = runtime || 'runc';
  const available = rt.docker && (configured === 'runc' || rt.runtimes.includes(configured));
  const selftest = readSelftests();
  return {
    ok: rt.docker && available && proxy === 'running' && inference.reachable,
    version: readVersion() ?? { commit: null, dirty: null, deployedAt: null },
    runtime: { configured, available, proxy, docker: rt.docker, limits: { memory: LIMITS.memory, cpus: LIMITS.cpus, pids: LIMITS.pids }, network: NETWORK },
    inference: { provider: PROVIDER, ...inference, fixModel: cfg.fixModel, visionModel: cfg.visionModel },
    selftest,
    spend: spendSummary(spend, cfg),
    queue: { running: queue.running().length, queued: queue.queued().length, maxRunning: queue.maxRunning, etaSec },
    latest: readLatest(),
    publicRuns: !!cfg.publicRuns,
    uptimeSec: Math.max(0, Math.round((now() - startedAt) / 1000)),
  };
}

/** Live checks for GET /admin/health, never cached: Docker, the runtime, the proxy and the app's own sandboxes. */
export async function healthData({ runtime } = {}) {
  const configured = runtime || 'runc';
  const [info, proxy, boxes] = await Promise.all([
    run('docker', ['info', '--format', '{{json .Runtimes}}'], { timeoutMs: 4000 }),
    proxyState(),
    run('docker', ['ps', '-aq', '--filter', `label=${APP_LABEL}`], { timeoutMs: 4000 }),
  ]);
  return {
    docker: info.code === 0,
    runtimeAvailable: info.code === 0 && (configured === 'runc' || info.stdout.includes(`"${configured}"`)),
    proxy: proxy === 'running',
    sandboxes: boxes.code === 0 ? boxes.stdout.split('\n').filter((s) => s.trim()).length : null,
  };
}

/** One startup line that shows whether the service user may use Docker (§4.10 step 4). */
export async function dockerVersionLine() {
  const r = await run('docker', ['version', '--format', 'client {{.Client.Version}}, server {{.Server.Version}}'], { timeoutMs: 10_000 });
  if (r.code === 0) return `docker: ${oneLine(r.stdout, 120)}`;
  const why = oneLine(r.stderr || `exit ${r.code}`, 200);
  const hint = /permission denied/i.test(why) ? ' (the service user is not in the docker group: the owner adds SupplementaryGroups=docker as root)' : '';
  return `docker: NOT usable: ${why}${hint}`;
}

// ---------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------
const row = (label, value) => `<div class="kv-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const pill = (ok, yes, no) => `<span class="pill ${ok ? 'is-ok' : 'is-bad'}">${esc(ok ? yes : no)}</span>`;

function runtimeText(rt) {
  // healthcheck.sh greps this page for "runsc": it may appear only when gVisor really is available.
  if (rt.available) return `<code>runtime: ${esc(rt.configured)}</code> ${pill(true, 'available', '')}`;
  if (!rt.docker) return `<code>runtime: unknown</code> ${pill(false, '', 'Docker does not answer')}`;
  if (rt.configured === 'runsc') return `<code>runtime: unavailable</code> ${pill(false, '', 'gVisor is configured, but Docker does not list it')}`;
  return `<code>runtime: unavailable</code> ${pill(false, '', 'the configured runtime is not in Docker')}`;
}

/** "gVisor" for runsc, so the literal "runsc" on the page only ever comes from the live runtime check. */
export const runtimeName = (r) => (r === 'runsc' ? 'gVisor' : String(r ?? ''));
/** "3 GB" from Docker's "3g". */
export const sizeText = (s) => String(s).replace(/^(\d+)g$/i, '$1 GB').replace(/^(\d+)m$/i, '$1 MB');

function selftestText(s) {
  if (!s) return '<span class="muted">no self-test result on record</span>';
  const ok = s.total > 0 && s.passed === s.total;
  const where = s.runtime ? ` under ${esc(runtimeName(s.runtime))}` : '';
  const when = s.at ? ` · ${esc(utcText(s.at))}` : '';
  return `${pill(ok, `${s.passed}/${s.total} passed`, `${s.passed}/${s.total} passed`)}<span class="muted">${where}${when}</span>`;
}

function etaText(sec) {
  if (sec === null || sec === undefined) return 'a few minutes';
  return `about ${Math.max(1, Math.round(sec / 60))} min`;
}

/** The /status page: plain HTML, no script. Contains the literal "runtime: runsc" when gVisor is available. */
export function statusHtml(d) {
  const rt = d.runtime;
  const inf = d.inference;
  const sp = d.spend;
  const st = d.selftest ?? {};
  const v = d.version ?? {};

  const problems = [];
  if (!rt.docker) problems.push('Docker does not answer');
  else if (!rt.available) problems.push('the sandbox runtime is not available');
  if (rt.proxy !== 'running') problems.push(`the egress proxy is ${rt.proxy}`);
  if (!inf.reachable) problems.push('the model service did not answer');

  const sandbox = [
    row('Runtime', runtimeText(rt)),
    row('Egress proxy', pill(rt.proxy === 'running', 'running', rt.proxy)),
    row('Limits per run', esc(`${sizeText(rt.limits.memory)} memory · ${rt.limits.cpus} CPUs · ${rt.limits.pids} processes`)),
    row('Network', esc(rt.network)),
  ].join('');

  const model = [
    row('Provider', esc(inf.provider)),
    row('Reachable', inf.reachable
      ? `${pill(true, 'yes', '')} <span class="muted">HTTP ${esc(inf.status)} · ${esc(inf.ms)} ms</span>`
      : `${pill(false, '', 'no')} <span class="muted">${esc(inf.error ?? '')}</span>`),
    row('Checked', esc(utcText(inf.checkedAt))),
    row('Fix model', `<code>${esc(inf.fixModel)}</code>`),
    row('Vision model', inf.visionModel ? `<code>${esc(inf.visionModel)}</code>` : '<span class="muted">none</span>'),
  ].join('');

  const tests = [
    row('Containment', selftestText(st.containment)),
    row('Hostile-repo scenes', selftestText(st.scenes)),
    row('Agent loop', selftestText(st.agentLoop)),
  ].join('');

  const spend = !sp
    ? row('Ledger', '<span class="muted">not loaded</span>')
    : sp.error
      ? row('Ledger', `<span class="muted">${esc(sp.error)}</span>`)
      : [
        row('Day (UTC)', esc(sp.day)),
        row('Public runs', esc(`${usdText(sp.publicUsd)} of ${usdText(sp.publicCapUsd)}`)),
        row('Admin runs', esc(`${usdText(sp.adminUsd)} of ${usdText(sp.adminCapUsd)}`)),
        row('Until 13 Nov', esc(`${usdText(sp.totalUsd)} of ${usdText(sp.totalCapUsd)}`)),
        row('Prices', '<span class="muted">list prices from the Vultr catalogue; billing may differ</span>'),
      ].join('');

  const queue = [
    row('Running', esc(`${d.queue.running} of ${d.queue.maxRunning} at once`)),
    row('Waiting', esc(d.queue.queued)),
    row('A new run would finish in', esc(etaText(d.queue.etaSec))),
    row('Public runs', d.publicRuns ? pill(true, 'open', '') : '<span class="muted">not open yet</span>'),
  ].join('');

  const latest = d.latest
    ? [row('Result', `<code>${esc(d.latest.line ?? '')}</code>`), row('Published', esc(utcText(d.latest.at))), row('Page', '<a href="/latest/">/latest/</a>')].join('')
    : row('Result', '<span class="muted">nothing published yet</span>');

  const version = [
    row('Commit', v.commit ? `<code>${esc(v.commit)}</code>${v.dirty ? ' <span class="pill is-warn">uncommitted changes</span>' : ''}` : '<span class="muted">unknown (not deployed with scripts/deploy.sh)</span>'),
    row('Deployed', esc(utcText(v.deployedAt)) || '<span class="muted">unknown</span>'),
    row('Up for', esc(`${Math.floor(d.uptimeSec / 3600)} h ${Math.floor((d.uptimeSec % 3600) / 60)} min`)),
  ].join('');

  const card = (title, body) => `<section class="card"><h2>${esc(title)}</h2><dl class="kv">${body}</dl></section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Status · Mantis Ring</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="top"><div class="wrap top-in">
<a class="brand" href="/"><img src="/favicon.svg" alt="" width="28" height="28"><span>Mantis Ring</span></a>
<nav class="nav"><a href="/latest/">Latest verified run</a><a href="/status" aria-current="page">Status</a></nav>
</div></header>
<main class="wrap page">
<div class="page-head"><h1>Status</h1>${problems.length ? pill(false, '', 'Needs attention') : pill(true, 'Ready', '')}</div>
<p class="muted">${problems.length ? `${esc(problems.join('; '))}. ` : ''}Every value on this page is read live, or comes from the last real self-test run. Raw data: <a href="/status.json">/status.json</a>.</p>
<div class="grid">
${card('Sandbox', sandbox)}
${card('Model service', model)}
${card('Self-tests', tests)}
${card('Spend today', spend)}
${card('Queue', queue)}
${card('Latest verified run', latest)}
${card('Version', version)}
</div>
</main>
<footer class="foot"><div class="wrap">Mantis Ring · measurements by <a href="https://github.com/vulinh1704/mantis">Mantis</a>, which uses no AI.</div></footer>
</body>
</html>
`;
}
