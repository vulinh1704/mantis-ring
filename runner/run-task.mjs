#!/usr/bin/env node
// Runs one task in a throwaway sandbox: bring the repo in (clone from GitHub or copy a local folder),
// install it, start its dev server, run `mantis look`, copy the report out, destroy the container.
// There is no AI in this file. The agent loop (agent/loop.mjs) drives the same steps between looks.
// look() reads the report that `mantis look --json` prints and finds the run folder from the report's
// own runId, so a missing or repeated run is an error (LookError), never a guess.
//
// Usage: node runner/run-task.mjs --repo <github url | local dir> [--routes /,/settings] [--locales en,vi]
//        [--port 3000] [--dev-cmd "npm run dev"] [--timeout 600] [--out out] [--runtime runsc]
import { realpathSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Sandbox } from './sandbox.mjs';

export const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const APP_DIR = '/work/app';
export const MANTIS_OUT = '/work/.mantis';

// The same rule as the app's public check (BUILD-SPEC §4.6); the clone URL is rebuilt from the two parts.
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/; // Mantis's run folder name: local time, -2, -3... when taken
const MAX_REPORT = 16 * 2 ** 20;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const lastLine = (text) => String(text).trim().split('\n').pop() ?? '';
const tailOf = (text) => String(text).trim().split('\n').slice(-20).join('\n').slice(-2000);

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`invalid port: ${port}`);
}

/** `mantis look` gave no usable measurement. `reason` says why; `stderrTail` is the end of its stderr. */
export class LookError extends Error {
  /**
   * @param {'unreachable'|'timeout'|'no-report'|'stale'|'usage'} reason
   * @param {string} message  one sentence
   * @param {string} [stderrTail]
   */
  constructor(reason, message, stderrTail = '') {
    super(message);
    this.name = 'LookError';
    this.reason = reason;
    this.stderrTail = stderrTail;
  }
}

/** Every accepted form of a source, as {kind:'local', dir} or {kind:'github', owner, name}; throws on anything else. */
function parseSource(source) {
  const notGithub = 'only public github.com repositories are supported, written as https://github.com/owner/name';
  if (typeof source === 'string') {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
      const m = GITHUB_URL.exec(source);
      if (!m || m[2] === '.' || m[2] === '..') throw new Error(notGithub);
      return { kind: 'github', owner: m[1], name: m[2] };
    }
    if (!source) throw new Error('no project folder or repository given');
    return { kind: 'local', dir: path.resolve(source) };
  }
  if (source?.kind === 'local' || source?.kind === 'sample') {
    if (typeof source.dir !== 'string' || !source.dir) throw new Error(`a ${source.kind} source needs a folder (dir)`);
    return { kind: 'local', dir: path.resolve(source.dir) };
  }
  if (source?.kind === 'github') {
    const { owner, name } = source;
    if (typeof owner !== 'string' || !GITHUB_OWNER.test(owner) || typeof name !== 'string' || !GITHUB_NAME.test(name) || name === '.' || name === '..') {
      throw new Error(notGithub);
    }
    return { kind: 'github', owner, name };
  }
  throw new Error('unknown source: give a local folder, a github.com URL, {kind: "local", dir} or {kind: "github", owner, name}');
}

/**
 * Bring the project into /work/app: copy a local folder in, or clone a public GitHub repository
 * inside the sandbox, through the allowlist proxy. The host never fetches the URL.
 * @param {Sandbox} box
 * @param {string | {kind: 'local'|'sample', dir: string} | {kind: 'github', owner: string, name: string}} source
 *   a local folder or a github.com URL (the old string form), or the parts; a sample is a local folder
 * @returns {Promise<{kind: 'local'} | {kind: 'github', url: string, commit: string}>}
 */
export async function bringIn(box, source) {
  const src = parseSource(source);
  if (src.kind === 'local') {
    if (!(await stat(src.dir).then((s) => s.isDirectory(), () => false))) throw new Error(`no such folder: ${src.dir}`);
    await box.copyIn(src.dir, APP_DIR);
    return { kind: 'local' };
  }
  const url = `https://github.com/${src.owner}/${src.name}.git`;
  const r = await box.execArgs(['env', 'GIT_TERMINAL_PROMPT=0', 'timeout', '-k', '5', '120',
    'git', '-c', 'protocol.file.allow=never', 'clone', '--depth', '1', '--no-tags', '--', url, APP_DIR], { timeoutMs: 135_000 });
  if (r.timedOut || r.code === 124 || r.code === 137) throw new Error('git clone did not finish within 120 s');
  if (r.code !== 0) throw new Error(`git clone failed: ${lastLine(r.stderr) || `exit ${r.code}`}`);
  const head = await box.execArgs(['git', '-C', APP_DIR, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 });
  const commit = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
    throw new Error(`could not read the cloned commit: ${lastLine(head.stderr) || `exit ${head.code}`}`);
  }
  return { kind: 'github', url, commit };
}

/** Read package.json scripts; a folder without one is served as static files. */
export async function inspectProject(box) {
  const r = await box.exec(`cd ${APP_DIR} && if [ -f package.json ]; then timeout -k 2 20 node -p "JSON.stringify({scripts: require('./package.json').scripts || {}, lock: require('fs').existsSync('package-lock.json')})"; else echo static; fi`, { timeoutMs: 40_000 });
  if (r.code !== 0) {
    const why = r.stderr.split('\n').find((l) => /Error/.test(l))?.trim() || lastLine(r.stderr) || `exit ${r.code}`;
    throw new Error(`could not read the project's package.json: ${why.slice(0, 300)}`);
  }
  const out = r.stdout.trim();
  if (out === 'static') return { static: true };
  try {
    return JSON.parse(out);
  } catch {
    throw new Error("could not read the project's package.json: unexpected output");
  }
}

export function startCommand(kind, { devCmd, port }) {
  if (devCmd) return devCmd;
  if (kind.static) return `node /opt/ring/static-server.mjs ${APP_DIR} ${port}`;
  if (kind.scripts.dev) return `PORT=${port} npm run dev -- --port ${port}`;
  if (kind.scripts.start) return `PORT=${port} npm start`;
  return `node /opt/ring/static-server.mjs ${APP_DIR} ${port}`;
}

/** Install the dependencies inside the sandbox (npm ci when there is a lock file), 300 s at most. */
export async function installDeps(box, kind) {
  if (kind.static) return;
  const r = await box.exec(`cd ${APP_DIR} && timeout -k 5 300 ${kind.lock ? 'npm ci' : 'npm install'} --no-audit --no-fund`, { timeoutMs: 320_000 });
  if (r.timedOut || r.code === 124) throw new Error('install failed (timeout): it did not finish within 300 s');
  if (r.code !== 0) {
    const killed = r.code >= 128 ? ', killed at the time or memory limit' : '';
    throw new Error(`install failed (exit ${r.code}${killed}): ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
}

/** Start the dev server in the background and wait until it answers (90 s at most). */
export async function startDevServer(box, start, port, isExpired = () => false) {
  checkPort(port);
  const d = await box.execDetached(`cd ${APP_DIR} && ${start}`, '/tmp/dev.log');
  if (d.code !== 0) throw new Error(isExpired() ? 'task timed out' : `could not start the dev server: ${lastLine(d.stderr) || `exit ${d.code}`}`);
  // Each probe is capped at 5 s, so a server that accepts connections but never answers cannot stall the wait.
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    if (await devServerUp(box, port)) return;
    if (isExpired()) throw new Error('task timed out');
    await sleep(1000);
  }
  const tail = await box.exec('tail -n 20 /tmp/dev.log', { timeoutMs: 15_000 });
  throw new Error(`dev server did not answer on port ${port} within 90 s:\n${tail.stdout}`);
}

/** One request to the dev server, 5 s at most. True when it answers at all, whatever the status code. */
export async function devServerUp(box, port) {
  checkPort(port);
  const r = await box.exec(`node -e "fetch('http://127.0.0.1:${port}/', { signal: AbortSignal.timeout(5000) }).then(() => process.exit(0), () => process.exit(1))"`, { timeoutMs: 20_000 });
  return r.code === 0;
}

/** A matrix value for the command line: a comma-separated string, or an array of strings joined with commas. */
function csv(name, value) {
  const s = Array.isArray(value) ? value.join(',') : value;
  if (typeof s !== 'string' || s === '') throw new TypeError(`look: ${name} must be a non-empty comma-separated string or array`);
  return s;
}

/**
 * Run `mantis look` once against the dev server and read its report. It is compared with an
 * explicit baseline run folder or with none, never `auto`, which would pick up a rejected run.
 * The run is time-limited inside the sandbox (`timeout -k`), so a stuck look never outlives its limit.
 * @param {Sandbox} box
 * @param {{port: number, routes?: string|string[], locales?: string|string[], viewports?: string|string[],
 *   schemes?: string|string[], baseline?: 'none'|string, prevRunId?: string, timeoutSec?: number}} o
 *   baseline: 'none' (the default) or the absolute run folder inside the sandbox to compare with;
 *   prevRunId: the previous look's run id, which this look must not return again; timeoutSec: 300.
 * @returns {Promise<{report: object, runId: string, runDir: string, exitCode: 0|1|2, crashed: boolean, ms: number}>}
 *   crashed: exit 2 with a report, some cells could not be analysed (the rest were measured)
 * @throws {LookError} when there is no usable report
 */
export async function look(box, { port, routes = '/', locales, viewports, schemes, baseline = 'none', prevRunId, timeoutSec = 300 } = {}) {
  checkPort(port);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) throw new TypeError(`look: invalid timeoutSec ${timeoutSec}`);
  if (baseline !== 'none' && !(typeof baseline === 'string' && baseline.startsWith('/'))) {
    throw new TypeError(`look: baseline must be 'none' or an absolute run folder, got ${JSON.stringify(baseline)}`);
  }
  const args = ['look', `http://127.0.0.1:${port}`, '--routes', csv('routes', routes)];
  for (const [name, value] of [['locales', locales], ['viewports', viewports], ['schemes', schemes]]) {
    if (value != null && value !== '') args.push(`--${name}`, csv(name, value));
  }
  // --style none: the result must not depend on a stray style.json. cwd stays /work: a relative
  // --out, the proof aliases and Mantis's project detection all depend on it.
  args.push('--out', MANTIS_OUT, '--baseline', baseline, '--style', 'none', '--json');
  const started = Date.now();
  const r = await box.exec(`cd /work && timeout -k 5 ${sh(timeoutSec)} mantis ${args.map(sh).join(' ')}`, { timeoutMs: (timeoutSec + 30) * 1000 });
  const ms = Date.now() - started;
  const stderrTail = tailOf(r.stderr);

  if (r.truncated) throw new LookError('no-report', 'mantis look printed more than 16 MiB, so its report was not read', stderrTail);
  if (r.timedOut || r.code === 124 || r.code >= 128) throw new LookError('timeout', `mantis look did not finish within ${timeoutSec} s`, stderrTail);
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* no report: judged below by the exit code */ }
  const hasReport = report !== null && typeof report === 'object' && typeof report.runId === 'string'
    && report.summary !== null && typeof report.summary === 'object';
  if (r.code === 0 || r.code === 1) {
    if (!hasReport) throw new LookError('no-report', 'mantis look finished but printed no report', stderrTail);
  } else if (r.code === 2) {
    // Exit 2 with a report means some cells crashed and the rest were measured. Without one, Mantis could not run.
    if (!hasReport || !(report.summary.crashedCells > 0)) {
      const unreachable = r.stderr.split('\n').find((l) => /cannot reach/.test(l));
      if (unreachable) throw new LookError('unreachable', `mantis could not reach the app: ${unreachable.trim().slice(0, 300)}`, stderrTail);
      throw new LookError('usage', `mantis look failed: ${lastLine(r.stderr).slice(0, 300) || 'exit 2'}`, stderrTail);
    }
  } else {
    throw new LookError('usage', `mantis look could not run (exit ${r.code}): ${lastLine(r.stderr).slice(0, 300)}`, stderrTail);
  }
  if (!RUN_ID.test(report.runId)) throw new LookError('no-report', `the report has an unexpected run id ${JSON.stringify(report.runId.slice(0, 40))}`, stderrTail);
  if (prevRunId && report.runId === prevRunId) throw new LookError('stale', `mantis returned the previous run ${prevRunId} again`, stderrTail);
  if (baseline !== 'none' && !report.baseline) throw new LookError('no-report', 'the report has no comparison with the baseline run', stderrTail);
  return { report, runId: report.runId, runDir: `${MANTIS_OUT}/runs/${report.runId}`, exitCode: r.code, crashed: r.code === 2, ms };
}

/**
 * Run one task without AI: bring the repo in, install, start the dev server, look once, copy the
 * report folder out, then destroy the sandbox, on every path (the wall-clock limit destroys it mid-step).
 * @param {{repo: string, routes?: string, locales?: string, port?: number, devCmd?: string,
 *   timeoutSec?: number, outDir?: string, runtime?: string}} opts
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ok: boolean, repo: string, steps: {name: string, ms: number}[], sandbox?: string,
 *   network?: string, reportDir?: string, summary?: object, error?: string, destroyed?: boolean, seconds: number}>}
 *   `destroyed`: the container is gone and so is its own network
 */
export async function runTask(opts, log = () => {}) {
  const { repo, routes = '/', locales, port = 3000, devCmd, timeoutSec = 600, outDir = 'out', runtime } = opts;
  const started = Date.now();
  const result = { ok: false, repo, steps: [] };
  const step = async (name, fn) => {
    const t = Date.now();
    log(`→ ${name}`);
    try { return await fn(); } finally { result.steps.push({ name, ms: Date.now() - t }); }
  };

  let box;
  try {
    box = await Sandbox.create({ runtime });
  } catch (err) {
    result.error = `could not start the sandbox: ${err.message}`;
    result.seconds = Math.round((Date.now() - started) / 1000);
    return result;
  }
  result.sandbox = box.name;
  result.network = box.network;
  // Wall-clock cap for the whole task: when it fires, the container is destroyed mid-step.
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    log(`! task timed out after ${timeoutSec}s, destroying ${box.name}`);
    box.destroy().catch(() => {}); // the same removal is awaited, and its failure reported, below
  }, timeoutSec * 1000);

  try {
    await step('bring the repo in', () => bringIn(box, repo));
    const kind = await step('inspect the project', () => inspectProject(box));
    const start = startCommand(kind, { devCmd, port });
    if (!kind.static) await step('install dependencies', () => installDeps(box, kind));
    await step('start the dev server', () => startDevServer(box, start, port, () => expired));
    const { report, runDir } = await step('mantis look', () => look(box, { port, routes, locales }));

    const dest = path.resolve(outDir, box.name);
    await step('copy the report out', async () => {
      await mkdir(dest, { recursive: true });
      await box.copyOut(runDir, dest);
      // The task only counts as done once the copy holds the very report mantis printed.
      const file = path.join(dest, 'report.json');
      const { size } = await stat(file);
      if (size > MAX_REPORT) throw new Error(`the copied report.json is too large (${size} bytes)`);
      const copied = JSON.parse(await readFile(file, 'utf8'));
      if (copied?.runId !== report.runId) throw new Error('the copied report.json is not the report mantis printed');
    });
    Object.assign(result, { ok: true, reportDir: dest, summary: report.summary });
  } catch (err) {
    result.error = expired ? `task timed out after ${timeoutSec}s` : err.message;
  } finally {
    clearTimeout(deadline);
    try {
      await box.destroy();
      result.destroyed = true;
    } catch (err) {
      Object.assign(result, { ok: false, destroyed: false, error: [result.error, err.message].filter(Boolean).join('; ') });
    }
    result.seconds = Math.round((Date.now() - started) / 1000);
  }
  return result;
}

/** True when node was started with this file (also through a symlinked path). */
function isMain() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const usage = 'usage: run-task.mjs --repo <github url | local dir> [--routes /] [--locales en,vi] [--port 3000] [--dev-cmd "npm run dev"] [--timeout 600] [--out out] [--runtime runsc]';
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        repo: { type: 'string' }, routes: { type: 'string' }, locales: { type: 'string' }, port: { type: 'string' },
        'dev-cmd': { type: 'string' }, timeout: { type: 'string' }, out: { type: 'string' }, runtime: { type: 'string' },
      },
    }));
  } catch (err) {
    console.error(`${err.message}\n${usage}`);
    process.exit(64);
  }
  const port = values.port === undefined ? undefined : Number(values.port);
  const timeoutSec = values.timeout === undefined ? undefined : Number(values.timeout);
  const badPort = port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535);
  const badTimeout = timeoutSec !== undefined && !(Number.isInteger(timeoutSec) && timeoutSec >= 1 && timeoutSec <= 86_400);
  if (!values.repo || badPort || badTimeout) { console.error(usage); process.exit(64); }
  const result = await runTask({
    repo: values.repo, routes: values.routes, locales: values.locales, port,
    devCmd: values['dev-cmd'], timeoutSec, outDir: values.out, runtime: values.runtime,
  }, (m) => console.error(m));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
