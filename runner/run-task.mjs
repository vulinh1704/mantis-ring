#!/usr/bin/env node
// Runs one task in a throwaway sandbox: bring the repo in (clone from GitHub or copy a local folder),
// install it, start its dev server, run `mantis look`, copy the report out, destroy the container.
// There is no AI in this file. The agent loop (agent/loop.mjs) drives the same steps between looks.
// look() reads the report that `mantis look --json` prints and finds the run folder from the report's
// own runId, so a missing or repeated run is an error (LookError), never a guess.
//
// A repository is judged inside its sandbox, never on the host:
// - bringIn() clones it there, and stops a clone that grows past MAX_REPO_MB;
// - inspectProject() reads package.json, the lock files and the workspace files there, and
//   planProject() (pure, unit-tested) picks the package manager, refuses a monorepo or a repository
//   with nothing to serve, and builds the command that starts the app;
// - installDeps() installs with that package manager. pnpm and yarn are first installed with npm into
//   the sandbox user's home, through the same proxy as every package. Corepack is not used: by default
//   it fetches Yarn 2+ from repo.yarnpkg.com, which the allowlist refuses. A lock file that is out of
//   date and a peer-dependency conflict are each retried once, within the same 300 s;
// - startDevServer() starts a dev server it knows (Vite, Astro, Next.js and others) directly, bound to
//   127.0.0.1:3000, and runs anything else through its package manager with PORT and HOST set. It then
//   waits for an answer on 127.0.0.1 or ::1, on port 3000 or on a port the server printed.
// A failed step throws SetupError: `publicMessage` is one plain sentence for the person who started the
// task (BUILD-SPEC §4.5), and `message` keeps the detail for the journal.
//
// Usage: node runner/run-task.mjs --repo <github url | local dir> [--routes /,/settings] [--locales en,vi]
//        [--port 3000] [--dev-cmd "npm run dev"] [--timeout 600] [--out out] [--runtime runsc]
import { realpathSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { usageText, usageVerdict } from './cgroup.mjs';
import { Sandbox } from './sandbox.mjs';

export const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const APP_DIR = '/work/app';
export const MANTIS_OUT = '/work/.mantis';
/** The most a cloned repository may take in the sandbox, its .git folder included. */
export const MAX_REPO_MB = 300;
export const CLONE_SEC = 120;
export const INSTALL_SEC = 300;
export const SERVE_SEC = 90;
/** The folders, in order, where a project without a dev server may keep its index.html ('' is the root). */
export const INDEX_DIRS = ['', 'public', 'src', 'docs', 'site', 'www', 'static', 'dist', 'build'];
/** The package.json scripts that may start the app, in order of preference. */
export const RUNNABLE = ['dev', 'start', 'develop', 'serve'];
/** Where pnpm or yarn is installed for one task: the sandbox user's home, a tmpfs. */
const PM_PREFIX = '/home/ring/.ring-pm';
const DEV_LOG = '/tmp/dev.log';
const DEV_PID = '/tmp/ring-dev.pid';
/** The hosts the proxy lets through (proxy/allowlist). */
const ALLOWLIST = ['registry.npmjs.org', 'github.com', 'codeload.github.com', 'objects.githubusercontent.com'];
const LOOPBACK = ['127.0.0.1', '::1'];
const PROJECT_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', '.yarnrc.yml', 'lerna.json', 'rush.json'];
const VERSION = /^\d{1,4}(?:\.\d{1,4}){0,2}(?:-[0-9A-Za-z.-]{1,40})?$/; // 12, 12.3 or 12.3.4, with an optional pre-release
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// The same rule as the app's public check (BUILD-SPEC §4.6); the clone URL is rebuilt from the two parts.
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/; // Mantis's run folder name: local time, -2, -3... when taken
const MAX_REPORT = 16 * 2 ** 20;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const lastLine = (text) => String(text).trim().split('\n').pop() ?? '';
const tailOf = (text) => String(text).trim().split('\n').slice(-20).join('\n').slice(-2000);

/** The last lines of a command's output on one line, without colour codes, for the journal. */
export function tailLine(text, max = 600) {
  const s = String(text ?? '').replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-6).join(' | ');
  return s.length > max ? `…${s.slice(-max)}` : s;
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`invalid port: ${port}`);
}

function checkHost(host) {
  if (!LOOPBACK.includes(host)) throw new TypeError(`invalid host: ${String(host).slice(0, 40)} (127.0.0.1 or ::1)`);
}

/** The address of the app inside its sandbox: http://127.0.0.1:3000 or http://[::1]:3000. */
export function baseUrl({ host = '127.0.0.1', port } = {}) {
  checkHost(host);
  checkPort(port);
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** The sentences a person sees when setup fails (BUILD-SPEC §4.5: one plain sentence each). */
export const SAY = Object.freeze({
  notFound: 'The repository was not found on GitHub, or it is private.',
  empty: 'The repository is empty.',
  tooBig: `The repository is larger than ${MAX_REPO_MB} MB, too big for the sandbox.`,
  cloneTime: `The repository could not be cloned within ${CLONE_SEC} s.`,
  clone: 'The repository could not be cloned from GitHub.',
  inspect: 'The project could not be inspected inside the sandbox.',
  badPackageJson: "The repository's package.json could not be read.",
  monorepo: 'This repository is a monorepo with several packages; give a repository with one app at its root.',
  nothingToServe: 'The repository has no dev or start script and no index.html to serve.',
  installTime: `The project's dependencies could not be installed within ${INSTALL_SEC} s.`,
  installMemory: "The install was stopped at the sandbox's memory limit.",
  installOutput: 'The install printed more output than the sandbox passes on, so it was stopped.',
  installSpace: 'The install ran out of space in the sandbox.',
  installPrivate: 'A dependency could not be found on the public npm registry.',
  installNode: "The project's dependencies need a different Node.js version than the sandbox's Node 22.",
  serveNode: "The app's dev server needs a newer Node.js than the sandbox's Node 22.",
  serveStopped: "The app's dev server stopped before it answered.",
  serveTime: `The app did not answer within ${SERVE_SEC} s, on port 3000 or on a port its dev server printed.`,
});

/** The sentence for an install that tried a host the proxy refuses; `host` is named when it is known. */
export function sayOffAllowlist(host) {
  return host
    ? `The install tried to reach ${host}, which is outside the sandbox's allowlist (only npm and GitHub).`
    : "The install tried to reach a host outside the sandbox's allowlist (only npm and GitHub).";
}

/** The sentence for any other install failure. */
export function sayInstallFailed(pm) {
  return `The project's dependencies could not be installed with ${['npm', 'pnpm', 'yarn'].includes(pm) ? pm : 'npm'}.`;
}

/** A setup step failed: `publicMessage` is one sentence for the person who started the task, `message` the detail. */
export class SetupError extends Error {
  /**
   * @param {string} publicMessage  one plain sentence
   * @param {string} [detail]  for the journal, on one line
   */
  constructor(publicMessage, detail = '') {
    super(detail ? String(detail).replace(/\s*\n\s*/g, ' | ') : publicMessage);
    this.name = 'SetupError';
    this.publicMessage = publicMessage;
  }
}

/**
 * `mantis look` gave no usable measurement. `reason` says why:
 * - 'timeout': its time limit ran out (the only path that is a timeout);
 * - 'memory', 'pids', 'sandbox': it was stopped, and the host cgroup or Docker shows the cause: the
 *   sandbox's memory limit, its process limit, or the sandbox itself stopped;
 * - 'killed': it was stopped by a signal (or exit code 128 or more) for a cause nothing showed;
 * - 'unreachable', 'no-report', 'stale', 'usage': it ran, and said why it could not measure.
 * The rest is for the journal (lookFailureText()), never for the public page: the exit code and its
 * signal, how long it ran, the end of its stderr, the host cgroup's usage and the post-mortem.
 */
export class LookError extends Error {
  /**
   * @param {'unreachable'|'timeout'|'memory'|'pids'|'sandbox'|'killed'|'no-report'|'stale'|'usage'} reason
   * @param {string} message  one sentence
   * @param {string} [stderrTail]
   * @param {{exitCode?: number|null, signal?: string|null, ms?: number|null, usage?: import('./cgroup.mjs').Usage|null, postmortem?: string[]}} [facts]
   *   postmortem: journal lines (postmortem())
   */
  constructor(reason, message, stderrTail = '', facts = {}) {
    super(message);
    this.name = 'LookError';
    this.reason = reason;
    this.stderrTail = stderrTail;
    this.exitCode = Number.isInteger(facts.exitCode) ? facts.exitCode : null;
    this.signal = facts.signal ?? null;
    this.ms = Number.isFinite(facts.ms) ? facts.ms : null;
    this.usage = facts.usage ?? null;
    this.postmortem = Array.isArray(facts.postmortem) ? facts.postmortem.map(String) : [];
  }
}

// Linux signal numbers: a shell reports a process that signal n stopped as exit code 128 + n, and
// `timeout` and `docker exec` pass that code on.
const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE',
  'SIGALRM', 'SIGTERM', 'SIGSTKFLT', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF',
  'SIGWINCH', 'SIGIO', 'SIGPWR', 'SIGSYS'];

/** The signal behind an exit code of 129 to 159 ('SIGKILL' for 137), or null for any other code. */
export function signalOf(code) {
  return Number.isInteger(code) && code > 128 && code <= 128 + SIGNALS.length ? SIGNALS[code - 129] : null;
}

/**
 * Text from the sandbox (stderr, a log, process names) made fit for the journal: no colour codes or
 * control characters, the last `lines` non-empty lines joined with " | ", at most `max` characters
 * (the end is kept), and anything shaped like a credential redacted. The sandbox never gets a
 * secret; this keeps one that a project prints, or the inference key, out of the journal all the same.
 */
export function journalSafe(text, { max = 600, lines = 8 } = {}) {
  let s = String(text ?? '').replace(ANSI, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  const key = process.env.VULTR_INFERENCE_API_KEY;
  if (key && key.length >= 8) s = s.split(key).join('[redacted]');
  s = s.replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2[redacted]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, '$1[redacted]@');
  const out = s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(-lines).join(' | ');
  return out.length > max ? `…${out.slice(-max)}` : out;
}

/** The app clips each journal line of a task to 400 characters (app/server.mjs): the runner's lines stay under this. */
export const JOURNAL_LINE = 320;

/** `text` cut into at most `n` pieces of at most JOURNAL_LINE characters, the end kept when it is longer. */
function pieces(text, n = 3) {
  const s = String(text ?? '');
  const room = JOURNAL_LINE * n;
  const kept = s.length > room ? `…${s.slice(-(room - 1))}` : s;
  const out = [];
  for (let i = 0; i < kept.length; i += JOURNAL_LINE) out.push(kept.slice(i, i + JOURNAL_LINE));
  return out;
}

/**
 * Everything a failed look left, as journal lines of at most JOURNAL_LINE characters (never for the
 * public page): the reason and sentence with the exit code, the signal and how long it ran; the host
 * cgroup during the look; the end of stderr; the post-mortem. Any other error gives its message.
 * @returns {string[]}
 */
export function lookFailureLines(err) {
  if (!(err instanceof LookError)) return [journalSafe(err?.message ?? err, { max: JOURNAL_LINE })];
  const how = [err.exitCode !== null ? `exit ${err.exitCode}${err.signal ? ` (${err.signal})` : ''}` : '', err.ms !== null ? `after ${(err.ms / 1000).toFixed(1)} s` : '']
    .filter(Boolean).join(', ');
  const lines = [journalSafe(`${err.reason}: ${err.message}${how ? ` (${how})` : ''}`, { max: JOURNAL_LINE })];
  if (err.usage) lines.push(...pieces(`host cgroup during the look: ${usageText(err.usage)}`, 2));
  lines.push(...pieces(`stderr: ${journalSafe(err.stderrTail, { max: 1200, lines: 12 }) || '(empty)'}`, 3));
  for (const l of Array.isArray(err.postmortem) ? err.postmortem : []) lines.push(...pieces(l, 2));
  return lines;
}

/** lookFailureLines() on one line, for the command line's result. */
export function lookFailureText(err) {
  return lookFailureLines(err).join(' · ');
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

// Inside the sandbox: the clone runs in the background while the folder's size is checked once a
// second. Past the limit git is stopped and the script exits 90. $1 the URL, $2 the folder, $3 the
// limit in KB. No credential helper and no prompt: a private or missing repository fails at once.
const CLONE = [
  'GIT_TERMINAL_PROMPT=0 git -c protocol.file.allow=never -c credential.helper= clone --depth 1 --no-tags -- "$1" "$2" 2> /tmp/clone.err &',
  'pid=$!',
  'while kill -0 "$pid" 2> /dev/null; do',
  '  sleep 1',
  '  kb=$(du -sk "$2" 2> /dev/null | cut -f1)',
  '  if [ -n "$kb" ] && [ "$kb" -gt "$3" ]; then kill "$pid" 2> /dev/null; wait "$pid" 2> /dev/null; echo "the clone passed $3 KB" >&2; exit 90; fi',
  'done',
  'wait "$pid"; s=$?',
  'tail -c 4000 /tmp/clone.err >&2',
  'exit "$s"',
].join('\n');

/** The sentence for a failed `git clone`: a repository that is missing or private, or any other failure. */
export function cloneFailure(stderr) {
  return /could not read Username|terminal prompts disabled|Repository not found|repository '[^']*' not found|Authentication failed|returned error: 40[134]/i.test(String(stderr ?? ''))
    ? SAY.notFound : SAY.clone;
}

/**
 * Bring the project into /work/app: copy a local folder in, or clone a public GitHub repository
 * inside the sandbox, through the allowlist proxy. The host never fetches the URL.
 * @param {Sandbox} box
 * @param {string | {kind: 'local'|'sample', dir: string} | {kind: 'github', owner: string, name: string}} source
 *   a local folder or a github.com URL (the old string form), or the parts; a sample is a local folder
 * @returns {Promise<{kind: 'local'} | {kind: 'github', url: string, commit: string}>}
 * @throws {SetupError} for a clone that fails, takes too long or grows past MAX_REPO_MB
 */
export async function bringIn(box, source) {
  const src = parseSource(source);
  if (src.kind === 'local') {
    if (!(await stat(src.dir).then((s) => s.isDirectory(), () => false))) throw new Error(`no such folder: ${src.dir}`);
    await box.copyIn(src.dir, APP_DIR);
    return { kind: 'local' };
  }
  const url = `https://github.com/${src.owner}/${src.name}.git`;
  const r = await box.execArgs(['timeout', '-k', '5', String(CLONE_SEC), 'sh', '-c', CLONE, 'clone', url, APP_DIR, String(MAX_REPO_MB * 1024)],
    { timeoutMs: (CLONE_SEC + 15) * 1000 });
  if (r.code === 90) throw new SetupError(SAY.tooBig, `git clone stopped past ${MAX_REPO_MB} MB: ${tailLine(r.stderr)}`);
  if (r.timedOut || r.code === 124 || r.code === 137) throw new SetupError(SAY.cloneTime, `git clone did not finish within ${CLONE_SEC} s`);
  if (r.code !== 0) throw new SetupError(cloneFailure(r.stderr), `git clone failed (exit ${r.code}): ${tailLine(r.stderr)}`);
  const head = await box.execArgs(['git', '-C', APP_DIR, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 });
  const commit = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
    throw new SetupError(/empty repository/i.test(r.stderr) ? SAY.empty : SAY.clone,
      `could not read the cloned commit: ${lastLine(head.stderr) || `exit ${head.code}`}`);
  }
  return { kind: 'github', url, commit };
}

// Inside the sandbox (its own Node 22): what planProject() needs, as one line of JSON. Values that
// come from the repository are cut to size here and checked again on the host.
const FACTS = `
const fs = require('fs');
process.chdir(${JSON.stringify(APP_DIR)});
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const head = (p, n) => {
  if (!isFile(p)) return null;
  try {
    const fd = fs.openSync(p, 'r');
    try { const b = Buffer.alloc(n); return b.subarray(0, fs.readSync(fd, b, 0, n, 0)).toString('utf8'); } finally { fs.closeSync(fd); }
  } catch { return null; }
};
const out = { node: process.version, files: {}, pkg: null, pkgError: null, index: [] };
for (const f of ${JSON.stringify(PROJECT_FILES)}) out.files[f] = isFile(f);
if (out.files['package.json']) {
  try {
    const j = JSON.parse(head('package.json', 2097152) || '');
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not a JSON object');
    const scripts = {};
    if (j.scripts && typeof j.scripts === 'object') for (const [k, v] of Object.entries(j.scripts)) if (typeof v === 'string' && k.length <= 100) scripts[k] = v.slice(0, 2000);
    const ws = Array.isArray(j.workspaces) ? j.workspaces : j.workspaces && Array.isArray(j.workspaces.packages) ? j.workspaces.packages : [];
    const count = (o) => (o && typeof o === 'object' ? Object.keys(o).length : 0);
    out.pkg = { scripts, packageManager: typeof j.packageManager === 'string' ? j.packageManager.slice(0, 200) : null, workspaces: ws.length, deps: count(j.dependencies) + count(j.devDependencies) };
  } catch (e) { out.pkgError = String((e && e.message) || e).slice(0, 200); }
}
out.pnpmWorkspace = head('pnpm-workspace.yaml', 16384);
out.yarnrc = head('.yarnrc.yml', 16384);
out.yarnLock = head('yarn.lock', 1024);
out.pnpmLock = head('pnpm-lock.yaml', 256);
for (const d of ${JSON.stringify(INDEX_DIRS)}) if (isFile(d ? d + '/index.html' : 'index.html')) out.index.push(d);
const m = /^yarnPath:[ \\t]*["']?([^"'\\s#]+)/m.exec(out.yarnrc || '');
out.yarnPath = m && isFile(m[1]) ? m[1].slice(0, 300) : null;
process.stdout.write(JSON.stringify(out));
`;

/**
 * Inspect /work/app inside the sandbox and plan the install and the start (planProject()).
 * @param {Sandbox} box
 * @param {{port?: number}} [o]
 * @returns {Promise<ReturnType<typeof planProject>>}
 * @throws {SetupError} for a monorepo, a broken package.json or a project with nothing to serve
 */
export async function inspectProject(box, { port = 3000 } = {}) {
  checkPort(port);
  const r = await box.execArgs(['timeout', '-k', '2', '20', 'node', '-e', FACTS], { timeoutMs: 40_000, maxBytes: 2 ** 20 });
  if (r.code !== 0 || r.truncated) throw new SetupError(SAY.inspect, `inspecting the project failed (exit ${r.code}): ${tailLine(r.stderr)}`);
  let facts;
  try {
    facts = JSON.parse(r.stdout);
  } catch {
    throw new SetupError(SAY.inspect, 'inspecting the project printed no JSON');
  }
  return planProject(facts, { port });
}

/** How many package folders pnpm-workspace.yaml lists under `packages:`, not counting the root ('.') or exclusions ('!…'). */
export function pnpmPackages(text) {
  if (typeof text !== 'string') return 0;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^packages\s*:/.test(l));
  if (at < 0) return 0;
  const items = [];
  const flow = /^packages\s*:\s*\[(.*)\]\s*(?:#.*)?$/.exec(lines[at]);
  if (flow) {
    items.push(...flow[1].split(','));
  } else {
    for (const l of lines.slice(at + 1)) {
      if (/^\s*(?:#.*)?$/.test(l)) continue;
      const m = /^\s+-\s*(.*?)\s*(?:#.*)?$/.exec(l);
      if (!m) break;
      items.push(m[1]);
    }
  }
  return items.map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter((s) => s && s !== '.' && s !== './' && !s.startsWith('!')).length;
}

/** Why the project counts as a monorepo (several packages, declared as workspaces), or null. */
export function monorepoOf(facts) {
  const files = facts?.files ?? {};
  if (Number(facts?.pkg?.workspaces) > 0) return 'package.json declares workspaces';
  if (pnpmPackages(facts?.pnpmWorkspace) > 0) return 'pnpm-workspace.yaml lists packages';
  if (files['lerna.json']) return 'it has lerna.json';
  if (files['rush.json']) return 'it has rush.json';
  return null;
}

/**
 * The package manager to install with, from the packageManager field, else the lock file.
 * @returns {{pm: 'npm'|'pnpm'|'yarn', version: string|null, lock: boolean, why: string, berry?: boolean,
 *   yarnPath?: string|null, note?: string}}  version: what npm installs (pnpm@<version>), checked against VERSION or 'latest'
 */
export function packageManagerOf(facts) {
  const files = facts?.files ?? {};
  const field = /^(npm|pnpm|yarn|bun)@(\S+)$/.exec(String(facts?.pkg?.packageManager ?? '').trim());
  const asked = field ? field[2].split('+')[0] : null; // "pnpm@10.15.1+sha512.…": the hash is not needed
  const pinned = asked && VERSION.test(asked) ? asked : null;
  const npmLock = files['package-lock.json'] ? 'package-lock.json' : files['npm-shrinkwrap.json'] ? 'npm-shrinkwrap.json' : null;
  const bunLock = files['bun.lock'] ? 'bun.lock' : files['bun.lockb'] ? 'bun.lockb' : null;
  const pm = field?.[1] ?? (files['pnpm-lock.yaml'] ? 'pnpm' : files['yarn.lock'] ? 'yarn' : bunLock ? 'bun' : 'npm');
  const why = field ? `packageManager ${field[1]}@${pinned ?? 'unreadable version'}`
    : { pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: bunLock, npm: npmLock ?? 'no lock file' }[pm];
  if (pm === 'bun') return { pm: 'npm', version: null, lock: false, why, note: 'bun is not in the sandbox, so npm installs from package.json' };
  if (pm === 'npm') return { pm, version: null, lock: Boolean(npmLock), why };
  if (pm === 'pnpm') {
    const lockMajor = /lockfileVersion:\s*['"]?(\d+)/.exec(String(facts?.pnpmLock ?? ''))?.[1];
    const version = pinned ?? ({ 5: '7', 6: '8', 9: '10' }[lockMajor] ?? 'latest');
    return { pm, version, lock: Boolean(files['pnpm-lock.yaml']), why };
  }
  const lock = String(facts?.yarnLock ?? '');
  const berry = pinned ? Number(pinned.split('.')[0]) >= 2 : /__metadata:/.test(lock) || (!/yarn lockfile v1/.test(lock) && Boolean(files['.yarnrc.yml']));
  const yarnPath = berry && typeof facts?.yarnPath === 'string' && /^(?!\/)(?!.*\.\.)[\w./-]{1,200}\.c?js$/.test(facts.yarnPath) ? facts.yarnPath : null;
  return { pm: 'yarn', version: pinned ?? (berry ? '4' : '1'), berry, yarnPath, lock: Boolean(files['yarn.lock']), why };
}

/** "npm ci", "npm install", "pnpm 10" or "yarn 4 (berry)": what installs the project. */
export function pmText(info) {
  if (!info || info.pm === 'npm') return info?.lock ? 'npm ci' : 'npm install';
  if (info.pm === 'pnpm') return `pnpm ${info.version}`;
  return `yarn ${info.yarnPath ? `from ${info.yarnPath}` : info.version}${info.berry ? ' (berry)' : ''}`;
}

/** A script that is one plain command: optional VAR=value words (or cross-env), a tool, its arguments. Null otherwise. */
export function parseCommand(script) {
  if (typeof script !== 'string') return null;
  const words = script.trim().split(/\s+/);
  // No quotes, $, globs, ~, redirections, pipes, &&, ; or subshells: every word is plain.
  if (!words[0] || words.length > 40 || !words.every((w) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(w))) return null;
  let i = 0;
  if (words[i] === 'cross-env') i++;
  const env = [];
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_@%+:,./-]*$/.test(words[i])) env.push(words[i++]);
  if (words[i] === 'npx' || words[i] === 'bunx') i++;
  if (i >= words.length || words[i].startsWith('-') || words[i].includes('=')) return null;
  return { env, tool: words[i], args: words.slice(i + 1) };
}

// Dev servers started directly, bound to the host and port Ring gives them. subs: the tool's
// subcommands (anything else first is an argument, as in `vite src`); dev: the ones that serve ('' for
// none); swap: production ones that need a build, replaced with the dev one; port and host: the
// tool's own flags, dropped from the script before Ring's are added (a repeated --port becomes an
// array in some CLIs); drop: flags dropped on their own. react-scripts reads PORT and HOST instead.
const DEV_TOOLS = (() => {
  const both = (h, p) => ['--host', h, '--port', p];
  const t = {
    vite: { subs: ['dev', 'serve', 'preview', 'build', 'optimize'], dev: ['', 'dev', 'serve'], swap: { preview: '' }, port: ['--port'], host: ['--host'], drop: ['--strictPort'], add: (h, p) => [...both(h, p), '--strictPort'] },
    astro: { subs: ['dev', 'start', 'preview', 'build', 'check', 'sync'], dev: ['dev', 'start'], swap: { preview: 'dev' }, port: ['--port'], host: ['--host'], add: both },
    next: { subs: ['dev', 'start', 'build', 'lint', 'export', 'info', 'telemetry'], dev: ['', 'dev'], swap: { start: 'dev' }, port: ['--port', '-p'], host: ['--hostname', '-H'], add: (h, p) => ['--hostname', h, '--port', p] },
    nuxt: { subs: ['dev', 'start', 'preview', 'build', 'generate'], dev: ['dev'], swap: { start: 'dev', preview: 'dev' }, port: ['--port', '-p'], host: ['--host'], add: both },
    'react-scripts': { subs: ['start', 'build', 'test', 'eject'], dev: ['start'], port: [], host: [], add: () => [] },
    'vue-cli-service': { subs: ['serve', 'build', 'lint', 'inspect'], dev: ['serve'], port: ['--port'], host: ['--host'], add: both },
    webpack: { subs: ['serve', 'build', 'watch', 'info'], dev: ['serve'], port: ['--port'], host: ['--host'], add: both },
    'webpack-dev-server': { subs: [], dev: [''], port: ['--port'], host: ['--host'], add: both },
    ng: { subs: ['serve', 'build', 'test', 'lint', 'e2e'], dev: ['serve'], port: ['--port'], host: ['--host'], add: both },
    gatsby: { subs: ['develop', 'build', 'serve', 'clean'], dev: ['develop'], swap: { serve: 'develop' }, port: ['--port', '-p'], host: ['--host', '-H'], add: both },
    docusaurus: { subs: ['start', 'build', 'serve', 'deploy', 'clear'], dev: ['start'], swap: { serve: 'start' }, port: ['--port'], host: ['--host'], drop: ['--no-open'], add: (h, p) => [...both(h, p), '--no-open'] },
    vitepress: { subs: ['dev', 'build', 'preview', 'serve'], dev: ['', 'dev'], swap: { preview: 'dev', serve: 'dev' }, port: ['--port'], host: ['--host'], add: both },
    'svelte-kit': { subs: ['dev', 'build', 'preview', 'sync'], dev: ['dev'], swap: { preview: 'dev' }, port: ['--port', '-p'], host: ['--host', '-H'], add: both },
    'react-router': { subs: ['dev', 'build', 'routes', 'typegen', 'reveal'], dev: ['dev'], port: ['--port'], host: ['--host'], add: both },
    remix: { subs: ['vite:dev', 'vite:build', 'dev', 'build', 'routes'], dev: ['vite:dev'], port: ['--port'], host: ['--host'], add: both },
    rsbuild: { subs: ['dev', 'build', 'preview', 'inspect'], dev: ['', 'dev'], swap: { preview: 'dev' }, port: ['--port'], host: ['--host'], add: both },
    vinxi: { subs: ['dev', 'build', 'start'], dev: ['dev'], swap: { start: 'dev' }, port: ['--port'], host: ['--host'], add: both },
    parcel: { subs: ['serve', 'watch', 'build'], dev: ['', 'serve'], port: ['--port', '-p'], host: ['--host'], add: both },
  };
  t.nuxi = t.nuxt;
  return t;
})();

/** The arguments without the tool's own port and host flags (and their values) and without `drop`. */
function stripFlags(args, tool) {
  const withValue = [...tool.port, ...tool.host];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((tool.drop ?? []).includes(a)) continue;
    if (withValue.includes(a.split('=')[0])) {
      if (!a.includes('=') && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const QUIET = 'NEXT_TELEMETRY_DISABLED=1 ASTRO_TELEMETRY_DISABLED=1 NUXT_TELEMETRY_DISABLED=1 GATSBY_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1';
// For the install: downloads that only test tools need (the allowlist would refuse them anyway) and
// git hooks are skipped.
const INSTALL_ENV = `PATH=${PM_PREFIX}/bin:$PATH PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 `
  + `CYPRESS_INSTALL_BINARY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 HUSKY=0 SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 DISABLE_OPENCOLLECTIVE=1 ADBLOCK=1 ${QUIET}`;
// Yarn 2+ in the sandbox: node_modules (so dev servers find their binaries), no global or in-repo cache, the proxy.
const YARN_BERRY_ENV = 'YARN_NODE_LINKER=node-modules YARN_ENABLE_IMMUTABLE_INSTALLS=false YARN_ENABLE_GLOBAL_CACHE=false '
  + 'YARN_CACHE_FOLDER=/work/.yarn-cache YARN_ENABLE_TELEMETRY=0 YARN_ENABLE_PROGRESS_BARS=false YARN_HTTP_PROXY=$HTTP_PROXY YARN_HTTPS_PROXY=$HTTPS_PROXY';
// An install's output goes to a file inside the sandbox, and only its last INSTALL_TAIL bytes come
// out. So an install that prints a flood (npm with loglevel=silly, or a hostile script) is neither cut
// off nor scanned on the app's event loop, and a process it leaves behind cannot hold the stream open.
// Output that bypasses the file (written straight to docker exec's own stream) is cut at
// INSTALL_MAX_OUTPUT and fails the install. The failure checks read at most INSTALL_TAIL characters.
const INSTALL_LOG = '/tmp/ring-install.log';
export const INSTALL_TAIL = 64 * 1024;
const INSTALL_MAX_OUTPUT = 2 ** 20;

/** The end of an install's output, at most INSTALL_TAIL characters: all that the failure checks read. */
function installTail(output) {
  const t = String(output ?? '');
  return t.length > INSTALL_TAIL ? t.slice(-INSTALL_TAIL) : t;
}

function devEnv(port, host, binFirst) {
  return `export PATH=${binFirst ? `${APP_DIR}/node_modules/.bin:` : ''}${PM_PREFIX}/bin:$PATH BROWSER=none PORT=${port} HOST=${host} ${QUIET}`;
}

/** The static file server on `root` (a folder from INDEX_DIRS). */
function staticCommand(root, port) {
  if (!INDEX_DIRS.includes(root)) throw new TypeError(`invalid static root: ${root}`);
  return `cd ${APP_DIR} && exec node /opt/ring/static-server.mjs ${root ? `${APP_DIR}/${root}` : APP_DIR} ${port}`;
}

/**
 * The command that starts the app from one package.json script. A plain command of a dev server in
 * DEV_TOOLS runs directly (node_modules/.bin first on PATH), with its own port and host flags replaced
 * by `host` and `port`; anything else runs as `<pm> run <name>` with PORT and HOST set. BROWSER=none
 * keeps `--open` from trying to start a browser.
 * @param {string} script  the script's text
 * @param {{name: string, pm?: string, port: number, host?: string}} o
 * @returns {{tool: string|null, start: string, shown: string}}  shown: the command, for the live log
 */
export function devCommand(script, { name, pm = 'npm', port, host = '127.0.0.1' }) {
  checkPort(port);
  checkHost(host);
  if (!RUNNABLE.includes(name)) throw new TypeError(`not a runnable script: ${name}`);
  const parsed = parseCommand(script);
  const tool = parsed && Object.hasOwn(DEV_TOOLS, parsed.tool) ? DEV_TOOLS[parsed.tool] : null;
  if (tool) {
    let args = parsed.args;
    let sub = args.length && tool.subs.includes(args[0]) ? args[0] : '';
    if (sub) args = args.slice(1);
    if (tool.swap && Object.hasOwn(tool.swap, sub)) sub = tool.swap[sub];
    if (tool.dev.includes(sub)) {
      const words = [parsed.tool, ...(sub ? [sub] : []), ...stripFlags(args, tool), ...tool.add(host, String(port))];
      const env = parsed.env.length ? `env ${parsed.env.join(' ')} ` : '';
      return { tool: parsed.tool, start: `cd ${APP_DIR} && ${devEnv(port, host, true)} && exec ${env}${words.join(' ')}`, shown: words.join(' ') };
    }
  }
  const run = `${['npm', 'pnpm', 'yarn'].includes(pm) ? pm : 'npm'} run ${name}`;
  return { tool: parsed?.tool ?? null, start: `cd ${APP_DIR} && ${devEnv(port, host, false)} && exec ${run}`, shown: `${run} (PORT=${port} HOST=${host})` };
}

/** Follow a script that only runs another one (`npm run dev`, `pnpm dev`, `yarn start`), two steps at most. */
function resolveScript(scripts, name) {
  let current = name;
  for (let depth = 0; depth < 2; depth++) {
    const p = parseCommand(scripts[current]);
    if (!p || p.env.length || !['npm', 'pnpm', 'yarn'].includes(p.tool)) break;
    const a = p.args[0] === 'run' || p.args[0] === 'run-script' ? p.args.slice(1) : p.args;
    if (a.length !== 1 || a[0] === current || !RUNNABLE.includes(a[0]) || typeof scripts[a[0]] !== 'string') break;
    current = a[0];
  }
  return current;
}

/**
 * Plan a project from what inspectProject() found: whether to install and with what, and how to start
 * it. Pure; it throws SetupError for a project Ring refuses. Everything taken from the repository is
 * checked here before it reaches a command.
 * @param {object} facts  the JSON that FACTS prints inside the sandbox
 * @param {{port?: number, host?: string}} [o]
 * @returns {{static: boolean, install: boolean, root: string|null, pm: string|null, pmInfo: object|null,
 *   script: string|null, tool: string|null, start: string, shown: string, notes: string[], lock: boolean,
 *   scripts: Record<string, string>}}
 *   static: no package.json at all; root: the folder the static server serves; shown: for the live log
 */
export function planProject(facts, { port = 3000, host = '127.0.0.1' } = {}) {
  checkPort(port);
  checkHost(host);
  const f = facts && typeof facts === 'object' ? facts : {};
  const files = f.files && typeof f.files === 'object' ? f.files : {};
  const index = (Array.isArray(f.index) ? f.index : []).filter((d) => INDEX_DIRS.includes(d));
  const notes = [];
  const servedFrom = (root) => `static files from /${root}`;
  if (!files['package.json']) {
    if (!index.length) throw new SetupError(SAY.nothingToServe, 'no package.json and no index.html');
    return {
      static: true, install: false, root: index[0], pm: null, pmInfo: null, script: null, tool: null,
      start: staticCommand(index[0], port), shown: servedFrom(index[0]), notes, lock: false, scripts: {},
    };
  }
  if (f.pkgError || !f.pkg || typeof f.pkg !== 'object') throw new SetupError(SAY.badPackageJson, `package.json: ${String(f.pkgError ?? 'not read').slice(0, 200)}`);
  const mono = monorepoOf(f);
  if (mono) throw new SetupError(SAY.monorepo, `a monorepo: ${mono}`);
  const pmInfo = packageManagerOf(f);
  if (pmInfo.note) notes.push(pmInfo.note);
  const scripts = {};
  for (const [k, v] of Object.entries(f.pkg.scripts && typeof f.pkg.scripts === 'object' ? f.pkg.scripts : {})) if (typeof v === 'string') scripts[k] = v;
  const deps = Number(f.pkg.deps) || 0;
  if (!deps) notes.push('no dependencies to install');
  const base = { static: false, install: deps > 0, pm: pmInfo.pm, pmInfo, notes, lock: pmInfo.lock, scripts };
  const name = RUNNABLE.find((n) => typeof scripts[n] === 'string' && scripts[n].trim());
  if (!name) {
    if (!index.length) throw new SetupError(SAY.nothingToServe, `package.json has no ${RUNNABLE.join(', ')} script, and there is no index.html`);
    notes.push(`no ${RUNNABLE.join('/')} script`);
    return { ...base, root: index[0], script: null, tool: null, start: staticCommand(index[0], port), shown: servedFrom(index[0]) };
  }
  const resolved = resolveScript(scripts, name);
  const dev = devCommand(scripts[resolved], { name: resolved, pm: pmInfo.pm, port, host });
  return { ...base, root: null, script: resolved, tool: dev.tool, start: dev.start, shown: dev.shown };
}

/** One line for the live log: the package manager and why, and how the app starts. */
export function describePlan(kind) {
  if (!kind || typeof kind !== 'object') return 'project: not inspected';
  const parts = kind.static ? ['no package.json'] : kind.pmInfo ? [`${pmText(kind.pmInfo)} (${kind.pmInfo.why})`] : [];
  parts.push(kind.script ? `start: ${kind.shown}` : kind.shown ?? 'static files');
  return `project: ${[...parts, ...(kind.notes ?? [])].join(' · ')}`.slice(0, 400);
}

/**
 * The start command: `devCmd` when given, else the one inspectProject() planned. The older shapes
 * ({static: true} or {scripts, lock}) still work.
 */
export function startCommand(kind, { devCmd, port = 3000 } = {}) {
  if (devCmd) return devCmd;
  if (typeof kind?.start === 'string') return kind.start;
  if (kind?.static || !kind?.scripts) return staticCommand('', port);
  const name = ['dev', 'start'].find((n) => typeof kind.scripts[n] === 'string');
  return name ? devCommand(kind.scripts[name], { name, port }).start : staticCommand('', port);
}

/** The first install command for a package manager. */
function installCommand(info) {
  if (info.pm === 'pnpm') return 'pnpm install --store-dir /work/.pnpm-store';
  if (info.pm === 'yarn') {
    return info.berry ? 'yarn install'
      : 'yarn install --non-interactive --ignore-engines --no-progress --cache-folder /work/.yarn-cache --network-timeout 300000 --proxy "$HTTP_PROXY" --https-proxy "$HTTPS_PROXY"';
  }
  return info.lock ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
}

/**
 * The command to try after an install failed, or null: `npm ci` with a lock file that is out of date
 * becomes `npm install`; a peer-dependency conflict (ERESOLVE) gets `--legacy-peer-deps`; pnpm's lock
 * file errors get `--no-frozen-lockfile`. Each happens at most once.
 */
export function installRetry(info, cmd, output) {
  const t = installTail(output);
  if (info?.pm === 'npm' || !info?.pm) {
    if (cmd.startsWith('npm ci') && /can only install packages when your package\.json and package-lock\.json|are in sync|Missing: \S+ from lock file|Invalid: lock file|\bEUSAGE\b/i.test(t)) return 'npm install --no-audit --no-fund';
    if (/\bERESOLVE\b/.test(t) && !cmd.includes('--legacy-peer-deps')) return 'npm install --no-audit --no-fund --legacy-peer-deps';
    return null;
  }
  if (info.pm === 'pnpm' && /ERR_PNPM_(?:OUTDATED_LOCKFILE|LOCKFILE_BREAKING_CHANGE|BROKEN_LOCKFILE|LOCKFILE_MISSING_DEPENDENCY|FROZEN_LOCKFILE)/.test(t) && !cmd.includes('--no-frozen-lockfile')) {
    return `${cmd} --no-frozen-lockfile`;
  }
  return null;
}

// A failure that reached out of the sandbox: a failed lookup, a refused connection, or a 403. The
// proxy (tinyproxy, FilterDefaultDeny) refuses a host off the allowlist with "403 Filtered", which npm
// reports as `npm error code E403` and `403 Filtered - GET https://<host>/…`, pnpm as
// ERR_PNPM_FETCH_403 and yarn as `Request failed "403 Filtered"`.
const NETWORK_FAILURE = /ENOTFOUND|EAI_AGAIN|getaddrinfo|tunneling socket|statusCode=403|\bE403\b|ERR_PNPM_FETCH_403|403 Forbidden|403 Filtered|Filtered - 403|Bad response: 403|Received HTTP code 403|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i;
// The ones that mean the proxy refused or the name did not resolve, whichever host it was. A 403 from
// an allowlisted host (the registry refusing a package) is not one of them.
const PROXY_REFUSAL = /tunneling socket|statusCode=403|403 Filtered|Filtered - 403|Bad response: 403|Received HTTP code 403 from proxy|ENOTFOUND|EAI_AGAIN/i;
// Hosts that tools name in their help text, never the host that failed.
const HELP_HOSTS = ['docs.npmjs.com', 'yarnpkg.com', 'classic.yarnpkg.com', 'pnpm.io', 'nodejs.org'];

/** The hosts off the allowlist that a piece of output names: after ENOTFOUND/EAI_AGAIN, and in URLs. */
function offHosts(text) {
  const hosts = [];
  for (const m of text.matchAll(/(?:ENOTFOUND|EAI_AGAIN)\s+([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) hosts.push(m[1]);
  for (const m of text.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?/gi)) hosts.push(m[1]);
  return hosts.map((h) => h.toLowerCase()).filter((h) => !ALLOWLIST.includes(h) && h.length <= 100);
}

/**
 * The host an install tried to reach outside the allowlist: its name, '' when the proxy refused a host
 * that the output does not name, or null when the failure was not about the network outside. The
 * host on the line that carries the failure (the 403, the failed lookup) wins; then the last one off
 * the allowlist anywhere in the output, leaving out the hosts of help text.
 */
export function offAllowlistHost(output) {
  const t = installTail(output);
  if (!NETWORK_FAILURE.test(t)) return null;
  const lines = t.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!NETWORK_FAILURE.test(lines[i])) continue;
    const here = offHosts(lines[i]);
    if (here.length) return here.at(-1);
  }
  const anywhere = offHosts(t).filter((h) => !HELP_HOSTS.includes(h));
  if (anywhere.length) return anywhere.at(-1);
  return PROXY_REFUSAL.test(t) ? '' : null;
}

/**
 * The sentence for an install that failed, from the end of its output, its exit code, whether its
 * time ran out and whether its output was cut off (`truncated`: the host stopped reading, which is
 * not the memory limit).
 */
export function installFailure(output, { code = 1, timedOut = false, truncated = false, pm = 'npm' } = {}) {
  const t = installTail(output);
  if (timedOut || code === 124) return SAY.installTime;
  if (truncated) return SAY.installOutput;
  if (/\bENOSPC\b|no space left on device/i.test(t)) return SAY.installSpace;
  const host = offAllowlistHost(t);
  if (host !== null) return sayOffAllowlist(host);
  if (/\bE404\b|404 Not Found - GET https:\/\/registry\.npmjs\.org|ERR_PNPM_FETCH_404|\bETARGET\b|No matching version found|Couldn't find package/i.test(t)) return SAY.installPrivate;
  if (/\bEBADENGINE\b|ERR_PNPM_UNSUPPORTED_ENGINE|engine "node" is incompatible|Unsupported engine/i.test(t)) return SAY.installNode;
  if (code === 137 || code > 128) return SAY.installMemory;
  return sayInstallFailed(pm);
}

/**
 * The download caches an install leaves in the sandbox, where every tmpfs folder is RAM: npm's (it
 * also installs pnpm and yarn) and yarn's. Nothing reads them after the install, and a Next.js app's
 * npm cache alone took 0.17 GB of the sandbox's 3 GB. pnpm's store stays: node_modules is hard-linked
 * into it, so removing it would free next to nothing.
 */
export const INSTALL_CACHES = Object.freeze(['/home/ring/.npm/_cacache', '/work/.yarn-cache']);

/** Remove INSTALL_CACHES after a successful install. Best effort: a cache left behind costs memory, never correctness. */
async function dropInstallCaches(box) {
  await Promise.resolve(box.exec(`rm -rf -- ${INSTALL_CACHES.join(' ')}`, { timeoutMs: 60_000 })).catch(() => {});
}

/**
 * Install the dependencies inside the sandbox, 300 s at most in all: pnpm or yarn first when the
 * project uses it, then the install, then at most two retries (installRetry()). After a successful
 * install the download caches go (INSTALL_CACHES).
 * @param {Sandbox} box
 * @param {object} kind  what inspectProject() returned
 * @returns {Promise<{pm: string|null, ran: string[]}>}  pm: pmText(); ran: the commands, in order
 * @throws {SetupError}
 */
export async function installDeps(box, kind) {
  if (kind?.static || kind?.install === false) return { pm: null, ran: [] };
  const info = kind?.pmInfo ?? { pm: 'npm', lock: Boolean(kind?.lock), version: null };
  const env = `${INSTALL_ENV}${info.pm === 'yarn' && info.berry ? ` ${YARN_BERRY_ENV}` : ''}`;
  const until = Date.now() + INSTALL_SEC * 1000;
  const ran = [];
  let last = null;
  const attempt = async (cmd) => {
    const left = Math.floor((until - Date.now()) / 1000);
    if (left < 5) throw new SetupError(SAY.installTime, `no time was left for: ${cmd}`);
    ran.push(cmd);
    // stdout and stderr go to INSTALL_LOG, in the order they were written (pnpm prints its errors on
    // stdout); only its end comes out, and the exit code is the install's own.
    const script = `rm -f ${INSTALL_LOG}; cd ${APP_DIR} && export ${env} && timeout -k 5 ${left} ${cmd} > ${INSTALL_LOG} 2>&1; s=$?; `
      + `tail -c ${INSTALL_TAIL} ${INSTALL_LOG} 2> /dev/null; rm -f ${INSTALL_LOG}; exit $s`;
    const r = await box.exec(script, { timeoutMs: (left + 20) * 1000, maxBytes: INSTALL_MAX_OUTPUT });
    last = { cmd, r, text: installTail(`${r.stderr}\n${r.stdout}`), outOfTime: Date.now() >= until - 1000 };
    return r.code === 0 && !r.timedOut && !r.truncated;
  };
  const fail = () => {
    const { cmd, r, text, outOfTime } = last;
    throw new SetupError(installFailure(text, { code: r.code, timedOut: r.timedOut || outOfTime, truncated: r.truncated, pm: info.pm }),
      `${cmd} failed (exit ${r.code}${r.truncated ? `, output cut off at ${INSTALL_MAX_OUTPUT} bytes` : ''}): ${tailLine(text)}`);
  };

  if (info.pm === 'yarn' && info.yarnPath) {
    // The project ships its own yarn: a `yarn` on PATH that runs it.
    const shim = `mkdir -p ${PM_PREFIX}/bin && printf '%s\\n' '#!/bin/sh' 'exec node ${APP_DIR}/${info.yarnPath} "$@"' > ${PM_PREFIX}/bin/yarn && chmod +x ${PM_PREFIX}/bin/yarn`;
    if (!(await attempt(`sh -c ${sh(shim)}`))) fail();
  } else if (info.pm === 'pnpm' || info.pm === 'yarn') {
    const name = info.pm === 'pnpm' ? 'pnpm' : info.berry ? '@yarnpkg/cli-dist' : 'yarn';
    const version = info.version === 'latest' || VERSION.test(String(info.version)) ? info.version : 'latest';
    const get = (v) => `npm install --global --prefix ${PM_PREFIX} --no-audit --no-fund ${name}@${v}`;
    if (!(await attempt(get(version)))) {
      // A version npm does not have: its major release line, once.
      const major = /^(\d+)\./.exec(version)?.[1];
      if (!major || last.r.truncated || !/\bETARGET\b|No matching version|\bE404\b/i.test(last.text) || !(await attempt(get(major)))) fail();
    }
  }
  let cmd = installCommand(info);
  for (let tries = 0; tries < 3; tries++) {
    if (await attempt(cmd)) {
      await dropInstallCaches(box);
      return { pm: pmText(info), ran };
    }
    // After output that was cut off, the install may still run in the sandbox: no second one beside it.
    const next = last.r.truncated ? null : installRetry(info, cmd, last.text);
    if (!next || last.outOfTime) break;
    cmd = next;
  }
  fail();
}

/** The ports a dev server printed in its log (http://localhost:5173/, "listening on port 8080"), at most 4. */
export function portsInLog(text) {
  const t = String(text ?? '').replace(ANSI, '');
  const found = [];
  const add = (s) => {
    const p = Number(s);
    if (Number.isInteger(p) && p >= 1 && p <= 65535 && !found.includes(p)) found.push(p);
  };
  for (const m of t.matchAll(/\bhttps?:\/\/(?:\[[0-9a-f:.]*\]|[a-z0-9.-]+):(\d{2,5})\b/gi)) add(m[1]);
  for (const m of t.matchAll(/\b(?:listening|running|started|serving|available|ready)\b[^\n]{0,40}?\bport\s*:?\s*(\d{2,5})\b/gi)) add(m[1]);
  return found.slice(0, 4);
}

/** The sentence for a dev server that never answered: a Node version it refuses, a process that exited, or silence. */
export function serveFailure(log, { alive = true } = {}) {
  const t = String(log ?? '').replace(ANSI, '');
  if (/You are using Node\.js|requires? Node(?:\.js)?(?: version)? *[>=v^~]*\d|Node\.js v?\d[\d.]* is not supported|Node\.js version [^\n]{0,40} is required|Unsupported Node\.js version/i.test(t)) return SAY.serveNode;
  return alive ? SAY.serveTime : SAY.serveStopped;
}

// Inside the sandbox: fetch every candidate address at once (4 s each) and print the first that
// answered, in the given order, and whether the dev server's process (its pid file) is still running.
const PROBE = `
const fs = require('fs');
const [list, pidFile] = process.argv.slice(1);
let alive = null;
let pid = 0;
try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch {}
if (pid > 1) {
  try { const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); alive = st.charAt(st.lastIndexOf(')') + 2) !== 'Z'; } catch { alive = false; }
}
const cands = JSON.parse(list);
const url = (c) => 'http://' + (c.host.includes(':') ? '[' + c.host + ']' : c.host) + ':' + c.port + '/';
Promise.all(cands.map((c) => fetch(url(c), { signal: AbortSignal.timeout(4000), redirect: 'manual' }).then(() => true, () => false)))
  .then((ok) => process.stdout.write(JSON.stringify({ up: ok.indexOf(true) >= 0 ? cands[ok.indexOf(true)] : null, alive })));
`;

// Inside the sandbox: request each route once, 60 s in all, so a dev server that compiles a page on
// its first request (Next.js, Astro) has done so before Mantis measures it. Then the scripts and
// stylesheets the page names by an absolute path on its own origin ("/…", at most 40), one at a time:
// a dev server that builds the browser's bundle only when the browser asks for it (Next.js with
// Turbopack) builds it here, alone, not while Mantis's browser pages fill the same memory.
const WARM = `
const [base, list] = process.argv.slice(1);
const until = Date.now() + 60000;
const left = () => until - Date.now();
const get = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(45000, left()))), redirect: 'manual' });
  const html = /html/i.test(String(res.headers.get('content-type') || ''));
  const body = html ? await res.text().catch(() => '') : await res.arrayBuffer().then(() => '', () => '');
  return { status: res.status, body };
};
const assetsOf = (html) => {
  const found = [];
  for (const m of String(html).slice(0, 2000000).matchAll(/<(script|link)\\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (/\\brel\\s*=\\s*["']?([^"'\\s>]+)/i.exec(tag) || [])[1] || '';
    if (m[1].toLowerCase() === 'link' && !['stylesheet', 'preload', 'modulepreload'].includes(rel.toLowerCase())) continue;
    const src = (/\\b(?:src|href)\\s*=\\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '';
    if (/^\\/(?![\\/\\\\])\\S*$/.test(src) && !found.includes(src)) found.push(src);
  }
  return found.slice(0, 40);
};
(async () => {
  const out = [];
  for (const r of JSON.parse(list)) {
    if (left() < 1000) break;
    const t = Date.now();
    let html = '';
    try {
      const page = await get(base + r);
      html = page.body;
      out.push(r + ' ' + page.status + ' in ' + (Date.now() - t) + ' ms');
    } catch (e) { out.push(r + ' ' + ((e && e.name) || 'error') + ' after ' + (Date.now() - t) + ' ms'); continue; }
    const assets = assetsOf(html);
    if (!assets.length) continue;
    const ta = Date.now();
    let ok = 0;
    for (const a of assets) {
      if (left() < 1000) break;
      try { if ((await get(base + a)).status < 400) ok++; } catch {}
    }
    out.push(r + ' assets ' + ok + '/' + assets.length + ' in ' + (Date.now() - ta) + ' ms');
  }
  process.stdout.write(out.join(', '));
})();
`;

/** The warm-up script itself, for the unit tests (it runs with the sandbox's Node, as `node -e WARM <base> <routes JSON>`). */
export const WARM_SCRIPT = WARM;

/** Where the app answers now, if anywhere, and whether its process is still running. */
async function probeServer(box, port) {
  const log = await box.exec(`tail -c 16384 ${DEV_LOG} 2> /dev/null`, { timeoutMs: 15_000 });
  const ports = [port, ...portsInLog(log.stdout).filter((p) => p !== port)].slice(0, 5);
  const cands = ports.flatMap((p) => LOOPBACK.map((host) => ({ host, port: p })));
  const r = await box.execArgs(['node', '-e', PROBE, JSON.stringify(cands), DEV_PID], { timeoutMs: 20_000, maxBytes: 4096 });
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { out = {}; }
  const up = out?.up && LOOPBACK.includes(out.up.host) && ports.includes(out.up.port) ? { host: out.up.host, port: out.up.port } : null;
  return { up, alive: typeof out?.alive === 'boolean' ? out.alive : null };
}

/**
 * Start the app in the background and wait until it answers, 90 s at most: on 127.0.0.1 or ::1, on
 * `port` or on a port its log names. Gives up early when its process has exited. Then each of
 * `routes` is requested once (warm-up).
 * @param {Sandbox} box
 * @param {string} start  startCommand()
 * @param {number} port
 * @param {() => boolean} [isExpired]
 * @param {{routes?: string[]}} [o]
 * @returns {Promise<{host: string, port: number, url: string, warm: string}>}
 * @throws {SetupError} when nothing answered; Error('task timed out') when isExpired()
 */
export async function startDevServer(box, start, port, isExpired = () => false, { routes = [] } = {}) {
  checkPort(port);
  const d = await box.execDetached(`echo $$ > ${DEV_PID}; ${start}`, DEV_LOG);
  if (d.code !== 0) throw new Error(isExpired() ? 'task timed out' : `could not start the dev server: ${lastLine(d.stderr) || `exit ${d.code}`}`);
  // Each probe is capped at 4 s, so a server that accepts connections but never answers cannot stall the wait.
  const until = Date.now() + SERVE_SEC * 1000;
  let gone = 0;
  while (Date.now() < until) {
    const p = await probeServer(box, port);
    if (p.up) {
      const url = baseUrl(p.up);
      const paths = (Array.isArray(routes) ? routes : []).filter((r) => typeof r === 'string' && r.startsWith('/') && r.length <= 200 && !/\s/.test(r)).slice(0, 3);
      let warm = '';
      if (paths.length && !isExpired()) {
        const w = await box.execArgs(['node', '-e', WARM, url, JSON.stringify(paths)], { timeoutMs: 75_000, maxBytes: 8192 });
        warm = String(w.stdout).slice(0, 500);
      }
      return { ...p.up, url, warm };
    }
    if (isExpired()) throw new Error('task timed out');
    gone = p.alive === false ? gone + 1 : 0;
    if (gone >= 2) break; // exited, and nothing answers in its place
    await sleep(1000);
  }
  if (isExpired()) throw new Error('task timed out');
  const tail = await box.exec(`tail -c 4000 ${DEV_LOG}`, { timeoutMs: 15_000 });
  throw new SetupError(serveFailure(tail.stdout, { alive: gone < 2 }),
    `dev server ${gone >= 2 ? 'exited' : `did not answer within ${SERVE_SEC} s`}: ${tailLine(tail.stdout) || 'no output'}`);
}

/**
 * One request to the app, 5 s at most. True when it answers at all, whatever the status code.
 * @param {Sandbox} box
 * @param {number | {host: string, port: number}} origin  a port on 127.0.0.1, or where startDevServer() found the app
 */
export async function devServerUp(box, origin) {
  const url = baseUrl(typeof origin === 'number' ? { port: origin } : origin);
  const r = await box.exec(`node -e "fetch('${url}/', { signal: AbortSignal.timeout(5000) }).then(() => process.exit(0), () => process.exit(1))"`, { timeoutMs: 20_000 });
  return r.code === 0;
}

// Inside the sandbox, right before the baseline look of a GitHub task and right after a look was
// stopped: every process (name, state, threads, resident memory), how full the tmpfs folders are
// (they live in RAM), what the sandbox kernel says about memory, whether the dev server runs, and the
// end of its log. With "du", also the size of node_modules, .next and the npm cache. One line of JSON.
const SANDBOX_VIEW = `
const fs = require('fs');
const [pidFile, logFile, du] = process.argv.slice(1);
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const out = { procs: [], mem: {}, dirs: {}, sizes: {}, dev: null, log: '' };
if (du === 'du') {
  let text = '';
  try { text = require('child_process').execFileSync('du', ['-sk', '/work/app/node_modules', '/work/app/.next', '/home/ring/.npm', '/home/ring/.cache'], { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { text = String((e && e.stdout) || ''); }
  for (const line of text.split('\\n')) { const m = /^(\\d+)\\s+(\\/\\S+)$/.exec(line.trim()); if (m) out.sizes[m[2]] = Number(m[1]) * 1024; }
}
for (const d of fs.readdirSync('/proc')) {
  if (!/^\\d+$/.test(d) || Number(d) === process.pid) continue;
  const st = read('/proc/' + d + '/stat');
  if (!st) continue;
  const close = st.lastIndexOf(')');
  const f = st.slice(close + 2).split(' ');
  out.procs.push({ pid: Number(d), comm: st.slice(st.indexOf('(') + 1, close).slice(0, 40), state: f[0], threads: Number(f[17]) || 0, rssKb: (Number(f[21]) || 0) * 4 });
}
for (const line of String(read('/proc/meminfo') || '').split('\\n')) {
  const m = /^(MemTotal|MemFree|MemAvailable|Shmem):\\s+(\\d+) kB/.exec(line);
  if (m) out.mem[m[1]] = Number(m[2]);
}
for (const d of ['/work', '/home/ring', '/tmp', '/dev/shm']) {
  try { const s = fs.statfsSync(d); out.dirs[d] = { used: (s.blocks - s.bfree) * s.bsize, size: s.blocks * s.bsize }; } catch {}
}
const pid = Number(String(read(pidFile) || '').trim());
if (pid > 1) { const st = read('/proc/' + pid + '/stat'); out.dev = Boolean(st) && st.charAt(st.lastIndexOf(')') + 2) !== 'Z'; }
const log = read(logFile);
if (log) out.log = log.slice(-4000);
process.stdout.write(JSON.stringify(out));
`;

const gbText = (bytes) => `${(bytes / 2 ** 30).toFixed(2)} GB`;

/** The sandbox from inside (SANDBOX_VIEW) as journal lines; `sizes` adds node_modules, .next and the npm cache. */
async function insideLines(box, { sizes = false } = {}) {
  if (typeof box.execArgs !== 'function') return [];
  const r = await box.execArgs(['timeout', '-k', '2', '25', 'node', '-e', SANDBOX_VIEW, DEV_PID, DEV_LOG, sizes ? 'du' : '-'], { timeoutMs: 40_000, maxBytes: 256 * 1024 });
  let facts = null;
  try { facts = JSON.parse(r.stdout); } catch { facts = null; }
  if (r.code !== 0 || !facts) return [`inside the sandbox: not read (exit ${r.code}): ${journalSafe(r.stderr, { max: 200, lines: 2 }) || 'no output'}`];
  return sandboxLines(facts);
}

/**
 * What the sandbox looked like right after a look was stopped, as journal lines: the container's state
 * (Docker), then, while it still runs, the inside view (sandboxLines()). `verdict` is 'memory' or
 * 'sandbox' when Docker shows the container stopped (OOM-killed or not), else null.
 * @param {Sandbox} box
 * @returns {Promise<{lines: string[], verdict: 'memory'|'sandbox'|null}>}
 */
export async function postmortem(box) {
  const st = typeof box.state === 'function' ? await box.state().catch(() => null) : null;
  const head = st ? `container ${st.status}${st.running ? '' : ` (exit ${st.exitCode})`}${st.oomKilled ? ', OOM-killed' : ''}` : 'container state unknown';
  if (st && !st.running) return { lines: [head], verdict: st.oomKilled ? 'memory' : 'sandbox' };
  return { lines: [head, ...(await insideLines(box))], verdict: null };
}

/**
 * The sandbox right before a look: journal lines (the host cgroup now, with memory and processes of
 * their limits, then the inside view with the size of node_modules, .next and the npm cache), and
 * the host cgroup's reading itself (null where it cannot be read).
 * @param {Sandbox} box
 * @returns {Promise<{lines: string[], usage: import('./cgroup.mjs').Usage|null}>}
 */
export async function sandboxSnapshot(box) {
  const w = typeof box.watchUsage === 'function' ? await box.watchUsage().catch(() => null) : null;
  const u = w ? w.stop() : null;
  const host = u && u.reads > 0 ? `host cgroup now: ${usageNow(u)}` : 'host cgroup: not read';
  return { lines: [host, ...(await insideLines(box, { sizes: true }))], usage: u && u.reads > 0 ? u : null };
}

/**
 * Below this much free memory before the first look, the live log says that measuring may run out
 * of memory. On 4 Nov a look of a Next.js 16 app, one group at a time, took 0.57 GB and 0.61 GB more
 * than the sandbox held before it.
 */
export const LOW_MEMORY_BYTES = 2 ** 30;

/** The live log's sentence when the sandbox has less than LOW_MEMORY_BYTES free before the first look, else null. */
export function memoryWarning(u) {
  if (!u || !(u.reads > 0) || !Number.isFinite(u.memMax) || !(u.memMax > 0) || !Number.isFinite(u.memPeak)) return null;
  if (u.memMax - u.memPeak >= LOW_MEMORY_BYTES) return null;
  return `memory is short: before the first look the sandbox already uses ${gbText(u.memPeak)} of its ${gbText(u.memMax)} `
    + "(the project's files and dependencies count too), so measuring may run out of memory";
}

/** One reading of the host cgroup: "memory 2.10 GB of 3.00 GB, 85 processes of 512". */
function usageNow(u) {
  const of = (n, f) => (Number.isFinite(n) ? ` of ${f(n)}` : '');
  return `memory ${gbText(u.memPeak)}${of(u.memMax, gbText)}, ${u.pidsPeak} processes${of(u.pidsMax, String)}`;
}

/**
 * SANDBOX_VIEW's JSON as journal lines of at most JOURNAL_LINE characters: the processes and the
 * largest ones; the tmpfs folders and the sizes asked for, with the kernel's view of memory; the dev
 * server and the end of its log.
 * @returns {string[]}
 */
export function sandboxLines(f) {
  const procs = Array.isArray(f?.procs) ? f.procs : [];
  const rss = (p) => (Number(p?.rssKb) || 0) * 1024;
  const threads = procs.reduce((n, p) => n + (Number(p?.threads) || 0), 0);
  const top = [...procs].sort((a, b) => rss(b) - rss(a)).slice(0, 6)
    .map((p) => `${journalSafe(p.comm, { max: 30, lines: 1 }) || '?'} ${gbText(rss(p))}/${Number(p.threads) || 0}t${p.state === 'Z' ? ' (zombie)' : ''}`);
  const lines = [`${procs.length} processes, ${threads} threads, ${gbText(procs.reduce((n, p) => n + rss(p), 0))} resident${top.length ? `; largest (memory/threads): ${top.join(', ')}` : ''}`];
  const dirs = Object.entries(f?.dirs ?? {}).map(([d, s]) => `${d} ${gbText(Number(s?.used) || 0)} of ${gbText(Number(s?.size) || 0)}`);
  const sizes = Object.entries(f?.sizes ?? {}).map(([d, n]) => `${d} ${gbText(Number(n) || 0)}`);
  const kb = (k) => (Number.isFinite(f?.mem?.[k]) ? gbText(f.mem[k] * 1024) : '?');
  const mem = f?.mem && Object.keys(f.mem).length ? [`sandbox kernel: ${kb('MemAvailable')} available of ${kb('MemTotal')}, ${kb('Shmem')} shared`] : [];
  const fsLine = [dirs.length ? `tmpfs: ${dirs.join(', ')}` : '', sizes.length ? `sizes: ${sizes.join(', ')}` : '', ...mem].filter(Boolean).join(' · ');
  if (fsLine) lines.push(fsLine);
  const log = journalSafe(f?.log, { max: 240, lines: 4 });
  lines.push(`dev server ${f?.dev === true ? 'running' : f?.dev === false ? 'not running' : 'unknown'}${log ? ` · dev log: ${log}` : ''}`);
  return lines.map((l) => (l.length > JOURNAL_LINE ? `${l.slice(0, JOURNAL_LINE - 1)}…` : l));
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
 * @param {{port: number, host?: string, routes?: string|string[], locales?: string|string[], viewports?: string|string[],
 *   schemes?: string|string[], baseline?: 'none'|string, prevRunId?: string, timeoutSec?: number}} o
 *   host: 127.0.0.1 (the default) or ::1, where startDevServer() found the app;
 *   baseline: 'none' (the default) or the absolute run folder inside the sandbox to compare with;
 *   prevRunId: the previous look's run id, which this look must not return again; timeoutSec: 300;
 *   concurrency: how many route × viewport groups Mantis opens at once, each with all its schemes
 *   (Mantis's own default, 3, when not given).
 * While it runs, the sandbox's host cgroup is watched (box.watchUsage(), where the box has it).
 * @returns {Promise<{report: object, runId: string, runDir: string, exitCode: 0|1|2, crashed: boolean, ms: number,
 *   usage: import('./cgroup.mjs').Usage|null}>}
 *   crashed: exit 2 with a report, some cells could not be analysed (the rest were measured)
 * @throws {LookError} when there is no usable report
 */
export async function look(box, { port, host = '127.0.0.1', routes = '/', locales, viewports, schemes, baseline = 'none', prevRunId, timeoutSec = 300, concurrency } = {}) {
  const url = baseUrl({ host, port });
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) throw new TypeError(`look: invalid timeoutSec ${timeoutSec}`);
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16)) throw new TypeError(`look: invalid concurrency ${concurrency}`);
  if (baseline !== 'none' && !(typeof baseline === 'string' && baseline.startsWith('/'))) {
    throw new TypeError(`look: baseline must be 'none' or an absolute run folder, got ${JSON.stringify(baseline)}`);
  }
  const args = ['look', url, '--routes', csv('routes', routes)];
  for (const [name, value] of [['locales', locales], ['viewports', viewports], ['schemes', schemes]]) {
    if (value != null && value !== '') args.push(`--${name}`, csv(name, value));
  }
  // --style none: the result must not depend on a stray style.json. cwd stays /work: a relative
  // --out, the proof aliases and Mantis's project detection all depend on it.
  if (concurrency !== undefined) args.push('--concurrency', String(concurrency));
  args.push('--out', MANTIS_OUT, '--baseline', baseline, '--style', 'none', '--json');
  const watch = typeof box.watchUsage === 'function' ? await box.watchUsage().catch(() => null) : null;
  const started = Date.now();
  let r;
  let usage = null;
  try {
    r = await box.exec(`cd /work && timeout -k 5 ${sh(timeoutSec)} mantis ${args.map(sh).join(' ')}`, { timeoutMs: (timeoutSec + 30) * 1000 });
  } finally {
    usage = watch?.stop() ?? null;
  }
  const ms = Date.now() - started;
  const stderrTail = tailOf(r.stderr);
  const facts = { exitCode: r.code, signal: signalOf(r.code), ms, usage };

  if (r.truncated) throw new LookError('no-report', 'mantis look printed more than 16 MiB, so its report was not read', stderrTail, facts);
  // Only the time limit is a timeout: the host's own timer, `timeout` itself (124), or the KILL that
  // `timeout -k 5` sends 5 s after the limit (137, once the limit has passed).
  if (r.timedOut || r.code === 124 || (r.code === 137 && ms >= timeoutSec * 1000)) {
    throw new LookError('timeout', `mantis look did not finish within ${timeoutSec} s`, stderrTail, facts);
  }
  // Anything else at 128 or more stopped it from outside or crashed it: say what, and look at the
  // sandbox at once, before anything else changes there.
  if (r.code >= 128) {
    const post = await postmortem(box).catch((err) => ({ lines: [`post-mortem failed: ${journalSafe(err?.message, { max: 200, lines: 1 })}`], verdict: null }));
    const reason = usageVerdict(usage) ?? post.verdict ?? 'killed';
    const how = facts.signal ? `was stopped by ${facts.signal}` : `ended with exit code ${r.code}`;
    throw new LookError(reason, `mantis look ${how} after ${(ms / 1000).toFixed(1)} s`, stderrTail, { ...facts, postmortem: post.lines });
  }
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* no report: judged below by the exit code */ }
  const hasReport = report !== null && typeof report === 'object' && typeof report.runId === 'string'
    && report.summary !== null && typeof report.summary === 'object';
  if (r.code === 0 || r.code === 1) {
    if (!hasReport) throw new LookError('no-report', 'mantis look finished but printed no report', stderrTail, facts);
  } else if (r.code === 2) {
    // Exit 2 with a report means some cells crashed and the rest were measured. Without one, Mantis could not run.
    if (!hasReport || !(report.summary.crashedCells > 0)) {
      const unreachable = r.stderr.split('\n').find((l) => /cannot reach/.test(l));
      if (unreachable) throw new LookError('unreachable', `mantis could not reach the app: ${unreachable.trim().slice(0, 300)}`, stderrTail, facts);
      throw new LookError('usage', `mantis look failed: ${lastLine(r.stderr).slice(0, 300) || 'exit 2'}`, stderrTail, facts);
    }
  } else {
    throw new LookError('usage', `mantis look could not run (exit ${r.code}): ${lastLine(r.stderr).slice(0, 300)}`, stderrTail, facts);
  }
  if (!RUN_ID.test(report.runId)) throw new LookError('no-report', `the report has an unexpected run id ${JSON.stringify(report.runId.slice(0, 40))}`, stderrTail, facts);
  if (prevRunId && report.runId === prevRunId) throw new LookError('stale', `mantis returned the previous run ${prevRunId} again`, stderrTail, facts);
  if (baseline !== 'none' && !report.baseline) throw new LookError('no-report', 'the report has no comparison with the baseline run', stderrTail, facts);
  return { report, runId: report.runId, runDir: `${MANTIS_OUT}/runs/${report.runId}`, exitCode: r.code, crashed: r.code === 2, ms, usage };
}

/**
 * Run one task without AI: bring the repo in, install, start the dev server, look once, copy the
 * report folder out, then destroy the sandbox, on every path (the wall-clock limit destroys it mid-step).
 * @param {{repo: string, routes?: string, locales?: string, port?: number, devCmd?: string,
 *   timeoutSec?: number, outDir?: string, runtime?: string}} opts
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ok: boolean, repo: string, steps: {name: string, ms: number}[], sandbox?: string,
 *   network?: string, plan?: string, url?: string, reportDir?: string, summary?: object, error?: string,
 *   destroyed?: boolean, seconds: number}>}
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
    const kind = await step('inspect the project', () => inspectProject(box, { port }));
    result.plan = describePlan(kind);
    log(`  ${result.plan}`);
    const start = startCommand(kind, { devCmd, port });
    if (!kind.static && kind.install !== false) await step('install dependencies', () => installDeps(box, kind));
    const routeList = String(routes).split(',').map((s) => s.trim()).filter(Boolean);
    const origin = await step('start the dev server', () => startDevServer(box, start, port, () => expired, { routes: routeList }));
    result.url = origin.url;
    const { report, runDir } = await step('mantis look', () => look(box, { port: origin.port, host: origin.host, routes, locales }));

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
    result.error = expired ? `task timed out after ${timeoutSec}s`
      : err.publicMessage ? `${err.publicMessage} (${err.message})` : err instanceof LookError ? lookFailureText(err) : err.message;
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
