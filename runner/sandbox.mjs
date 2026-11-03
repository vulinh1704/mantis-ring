// One throwaway container per task, driven through the docker CLI from the host.
// The container gets nothing from the host environment: no API keys, no tokens. It runs read-only,
// without capabilities, with memory, CPU and process caps, on an internal network whose only exit
// is the allowlist proxy. Every task ends with destroy(), whatever happened.
// The host side is careful too: every child process (the docker CLI included) gets a minimal
// environment without the inference key, output is decoded UTF-8-safe and capped, and files come out
// of the sandbox one at a time with readFile(): regular files only, into names the host chooses.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';

export const LIMITS = { memory: '3g', cpus: '2', pids: 512, shm: '512m', work: '2g', tmp: '512m', home: '1g' };
/** The label of the app's own sandboxes. Self-test sandboxes lack it, so removeAll() never stops a self-test. */
export const APP_LABEL = 'mantis-ring.owner=app';
const PROXY_NAME = 'ring-proxy';
const PROXY = `http://${PROXY_NAME}:8888`;
const MAX_OUTPUT = 16 * 2 ** 20; // bytes kept per output stream of a child process
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LABEL_VALUE = /^[\x21-\x7e]{1,256}$/; // printable ASCII, no spaces
// readFile() inside the sandbox: $1 must be a regular file, not a symlink, of at most $2 bytes.
const READ_FILE = 'f=$1; m=$2; [ -f "$f" ] && [ ! -L "$f" ] || exit 3; s=$(stat -c %s -- "$f") || exit 3; [ "$s" -le "$m" ] || exit 4; exec cat -- "$f"';

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** The last lines of a command's output, on one line, for error messages. */
const tail = (text, n = 3) => String(text).trim().split('\n').slice(-n).join(' | ');

/**
 * The environment for every child process the host starts, the docker CLI included: PATH, HOME,
 * LANG=C.UTF-8 and the DOCKER_* variables, plus `extra`. Nothing else is inherited, so the inference
 * API key never reaches a child. A value that contains the key throws instead of being passed on.
 * @param {Record<string, string|number|undefined|null>} [extra]  undefined and null values are left out
 * @returns {Record<string, string>}
 */
export function childEnv(extra = {}) {
  const env = { PATH: process.env.PATH || DEFAULT_PATH, LANG: 'C.UTF-8' };
  if (process.env.HOME) env.HOME = process.env.HOME;
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('DOCKER_') && v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(extra ?? {})) if (v !== undefined && v !== null) env[k] = String(v);
  const key = process.env.VULTR_INFERENCE_API_KEY;
  if (key && key.length >= 8) {
    const leak = Object.keys(env).find((k) => env[k].includes(key));
    if (leak) throw new Error(`childEnv: ${leak} would hand the inference API key to a child process`);
  }
  return env;
}

/** The longest prefix of `s` that takes at most `room` bytes in UTF-8, cut at a character boundary. */
function fitUtf8(s, room) {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= room) return s;
  let end = Math.max(0, room);
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--; // back off from the middle of a character
  return b.subarray(0, end).toString('utf8');
}

/**
 * Run a command and resolve with its exit code and output. A failure of the command never rejects:
 * one that cannot start resolves with code 127 and the reason in stderr. It rejects only on a
 * programming error (an `input` or `maxBytes` of the wrong type).
 *
 * Output is decoded as UTF-8 across chunk edges (or kept as bytes with `binary`) and capped at
 * `maxBytes` per stream: past it the child is killed and `truncated` is set. A timeout, an abort or
 * the cap kills only this child (SIGKILL). For `docker exec` that is the CLI, not the process inside
 * the sandbox, so long commands there also get their own `timeout -k`.
 *
 * @typedef {{code: number, stdout: string|Buffer, stderr: string, timedOut: boolean, truncated: boolean}} RunResult
 * @param {string} cmd
 * @param {string[]} args
 * @param {{input?: import('node:stream').Readable|string|Buffer, timeoutMs?: number, onData?: (s: string) => void,
 *   maxBytes?: number, binary?: boolean, signal?: AbortSignal, env?: Record<string, string>}} [opts]
 *   `onData` gets every text chunk (stderr, and stdout unless `binary`); `env` defaults to childEnv().
 * @returns {Promise<RunResult>} code 137 after a timeout, an abort or the output cap; with `binary`, stdout is a Buffer
 */
export function run(cmd, args, { input, timeoutMs = 0, onData, maxBytes = MAX_OUTPUT, binary = false, signal, env } = {}) {
  const isBytes = typeof input === 'string' || input instanceof Uint8Array;
  if (input != null && !isBytes && typeof input.pipe !== 'function') {
    return Promise.reject(new TypeError('run(): input must be a readable stream, a string or a Buffer'));
  }
  if (!(maxBytes > 0)) return Promise.reject(new TypeError('run(): maxBytes must be a positive number'));
  const empty = () => (binary ? Buffer.alloc(0) : '');

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: 137, stdout: empty(), stderr: 'aborted before it started', timedOut: false, truncated: false });
      return;
    }
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? childEnv() });
    } catch (err) {
      resolve({ code: 127, stdout: empty(), stderr: `could not start ${cmd}: ${err.message}`, timedOut: false, truncated: false });
      return;
    }

    const out = { parts: [], bytes: 0, full: false };
    const err = { parts: [], bytes: 0, full: false };
    let timedOut = false, truncated = false, aborted = false, settled = false;
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs) : null;
    const onAbort = () => { aborted = true; kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code, note = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const stdout = binary ? Buffer.concat(out.parts) : out.parts.join('');
      resolve({ code, stdout, stderr: err.parts.join('') + note, timedOut, truncated });
    };
    // Keep at most maxBytes per stream. An output flood must not take the host's memory.
    const keep = (sink, chunk, text) => {
      if (sink.full) return;
      const size = text ? Buffer.byteLength(chunk) : chunk.length;
      if (sink.bytes + size > maxBytes) {
        const room = maxBytes - sink.bytes;
        chunk = text ? fitUtf8(chunk, room) : chunk.subarray(0, room);
        sink.full = true;
        truncated = true;
        kill();
      } else {
        sink.bytes += size;
      }
      sink.parts.push(chunk);
      if (text && chunk.length && onData) {
        try { onData(chunk); } catch { /* the caller's log hook must not break the run */ }
      }
    };

    // setEncoding before any listener: the decoder keeps a character that straddles two chunks whole.
    if (!binary) child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => keep(out, d, !binary));
    child.stderr.on('data', (d) => keep(err, d, true));
    child.on('error', (e) => { if (child.pid === undefined) finish(127, `could not start ${cmd}: ${e.message}`); });
    // 137 whenever this function killed the child, even if it had just exited by itself: the result is cut off either way.
    child.on('close', (code, sig) => finish(aborted || truncated || timedOut ? 137 : code ?? (sig ? 137 : 1)));

    child.stdin.on('error', () => {}); // EPIPE when the child exits without reading its input; the exit code tells
    if (input == null) child.stdin.end();
    else if (isBytes) child.stdin.end(input);
    else pipeline(input, child.stdin, () => {}); // a failed input shows in the child's exit code
  });
}

/**
 * Start a command whose stdout feeds another one (a tar stream). `done` resolves with its exit code
 * and the start of its stderr; `kill()` stops it.
 */
function produce(cmd, args) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { if (stderr.length < 8192) stderr += d; });
  const done = new Promise((ok) => {
    child.on('error', (e) => { if (child.pid === undefined) ok({ code: 127, stderr: `could not start ${cmd}: ${e.message}` }); });
    child.on('close', (code, sig) => ok({ code: code ?? (sig ? 137 : 1), stderr }));
  });
  return { stdout: child.stdout, done, kill: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } } };
}

/** Check a `key=value` label and return it, or throw. */
function checkLabel(label) {
  const m = /^([^=]+)=(.*)$/s.exec(typeof label === 'string' ? label : '');
  if (!m || !LABEL_KEY.test(m[1]) || !LABEL_VALUE.test(m[2])) throw new Error(`invalid label ${JSON.stringify(label)}: expected key=value`);
  return label;
}

export class Sandbox {
  constructor(name) { this.name = name; }

  /**
   * Start a fresh container. `runtime: 'runsc'` uses gVisor where it is installed (the Vultr VM).
   * `labels` adds --label key=value pairs; `mantis-ring=task` is always set (the tests filter on it).
   * @param {{image?: string, runtime?: string, limits?: typeof LIMITS, labels?: Record<string, string>}} [o]
   * @returns {Promise<Sandbox>}
   */
  static async create({ image = 'mantis-ring/sandbox', runtime, limits = LIMITS, labels = {} } = {}) {
    const labelArgs = [];
    for (const [k, v] of Object.entries(labels ?? {})) {
      if (k === 'mantis-ring') throw new Error('the sandbox label mantis-ring is reserved (always mantis-ring=task)');
      if (typeof v !== 'string') throw new Error(`the value of sandbox label ${k} must be a string`);
      labelArgs.push('--label', checkLabel(`${k}=${v}`));
    }
    const name = `ring-${randomBytes(4).toString('hex')}`;
    // The proxy's name goes into the sandbox's /etc/hosts. Under gVisor (runsc), Docker's embedded
    // DNS on a user-defined network cannot be reached, so `ring-proxy` would not resolve; see "DNS
    // doesn't work on a Docker user defined bridge network" in https://gvisor.dev/docs/user_guide/faq/.
    const ip = await run('docker', ['inspect', '-f', `{{(index .NetworkSettings.Networks "ring-internal").IPAddress}}`, PROXY_NAME], { timeoutMs: 30_000 });
    const proxyIp = ip.stdout.trim();
    if (ip.code !== 0 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(proxyIp)) throw new Error(`${PROXY_NAME} is not running on ring-internal: run scripts/setup.sh`);
    const args = [
      'run', '-d', '--name', name, '--label', 'mantis-ring=task', ...labelArgs,
      '--network', 'ring-internal', '--add-host', `${PROXY_NAME}:${proxyIp}`,
      '--read-only',
      // Writable scratch space, owned by the sandbox user (uid 10001); everything else is read-only.
      '--tmpfs', `/work:rw,exec,size=${limits.work},uid=10001,gid=10001,mode=0755`,
      '--tmpfs', `/tmp:rw,exec,size=${limits.tmp},mode=1777`,
      '--tmpfs', `/home/ring:rw,exec,size=${limits.home},uid=10001,gid=10001,mode=0755`,
      '--shm-size', limits.shm,
      '--memory', limits.memory, '--memory-swap', limits.memory,
      '--cpus', limits.cpus, '--pids-limit', String(limits.pids),
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-e', `HTTP_PROXY=${PROXY}`, '-e', `HTTPS_PROXY=${PROXY}`, '-e', `http_proxy=${PROXY}`, '-e', `https_proxy=${PROXY}`,
      '-e', 'NO_PROXY=localhost,127.0.0.1', '-e', 'no_proxy=localhost,127.0.0.1',
      ...(runtime ? ['--runtime', runtime] : []),
      image,
    ];
    const r = await run('docker', args, { timeoutMs: 120_000 });
    if (r.code !== 0) {
      // The container can exist although `docker run` failed (created, then the runtime would not start it).
      await run('docker', ['rm', '-f', name], { timeoutMs: 60_000 });
      throw new Error(`docker run failed: ${r.timedOut ? 'no answer within 120 s' : tail(r.stderr, 5)}`);
    }
    return new Sandbox(name);
  }

  /** Run a shell command inside the sandbox: docker exec [-i] <name> sh -c <script>. */
  exec(script, opts = {}) {
    return run('docker', ['exec', ...(opts.input ? ['-i'] : []), this.name, 'sh', '-c', script], opts);
  }

  /**
   * Run a program inside the sandbox with positional arguments: docker exec [-i] <name> ...argv.
   * Nothing is spliced into a shell string, so paths and patterns can be passed as they are.
   * @param {string[]} argv
   * @param {Parameters<typeof run>[2]} [opts]
   * @returns {Promise<RunResult>}
   */
  async execArgs(argv, opts = {}) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) throw new TypeError('execArgs needs a non-empty array of strings');
    if (argv.some((a) => a.includes('\0'))) throw new TypeError('execArgs: an argument contains a NUL byte');
    return run('docker', ['exec', ...(opts.input ? ['-i'] : []), this.name, ...argv], opts);
  }

  /**
   * Read one file out of the sandbox as bytes: only a regular file that is not a symlink, of at most
   * `maxBytes`. The caller writes the bytes to a host file whose name the host chooses.
   * @param {string} absPath  absolute path inside the sandbox
   * @param {{maxBytes?: number}} [o]
   * @returns {Promise<Buffer>}
   */
  async readFile(absPath, { maxBytes = 20 * 2 ** 20 } = {}) {
    if (typeof absPath !== 'string' || !absPath.startsWith('/') || absPath.includes('\0')) throw new TypeError(`readFile needs an absolute path, got ${JSON.stringify(absPath)}`);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('readFile: maxBytes must be a positive whole number');
    // The size limit is checked inside the sandbox first. The extra 4 KiB catch a file that grows after that check.
    const r = await this.execArgs(['sh', '-c', READ_FILE, 'rf', absPath, String(maxBytes)], { binary: true, maxBytes: maxBytes + 4096, timeoutMs: 30_000 });
    if (r.code === 3) throw new Error(`not a regular file: ${absPath}`);
    if (r.code === 4 || r.truncated || r.stdout.length > maxBytes) throw new Error(`file too large: ${absPath} (limit ${maxBytes} bytes)`);
    if (r.timedOut) throw new Error(`reading ${absPath} took more than 30 s`);
    if (r.code !== 0) throw new Error(`could not read ${absPath}: ${tail(r.stderr) || `exit ${r.code}`}`);
    return r.stdout;
  }

  /** The OCI runtime the container really runs under, as Docker reports it: 'runsc' (gVisor) or 'runc'. */
  async runtimeName() {
    const r = await run('docker', ['inspect', '--type', 'container', '-f', '{{.HostConfig.Runtime}}', this.name], { timeoutMs: 30_000 });
    const name = r.stdout.trim();
    if (r.code !== 0 || !name) throw new Error(`could not read the runtime of ${this.name}: ${tail(r.stderr) || 'empty answer'}`);
    return name;
  }

  /** True once `docker ps -a` no longer lists the container. False also when docker cannot be asked. */
  async gone() {
    const r = await run('docker', ['ps', '-aq', '--filter', `name=^${this.name}$`], { timeoutMs: 15_000 });
    return r.code === 0 && r.stdout.trim() === '';
  }

  /** Start a long-running command (a dev server) in the background; its output goes to `log`. */
  execDetached(script, log) {
    return run('docker', ['exec', '-d', this.name, 'sh', '-c', `${script} > ${log} 2>&1`]);
  }

  /** Copy a host directory into the sandbox (as a tar stream: `docker cp` can't write to tmpfs). */
  async copyIn(hostDir, dest) {
    const tar = produce('tar', ['-C', path.resolve(hostDir), '--exclude=node_modules', '--exclude=.git', '-cf', '-', '.']);
    const r = await this.execArgs(['sh', '-c', 'mkdir -p -- "$1" && tar -xf - -C "$1"', 'copy-in', dest], { input: tar.stdout, timeoutMs: 120_000 });
    if (r.code !== 0) tar.kill();
    const packed = await tar.done;
    if (r.code !== 0) {
      const host = packed.code !== 0 ? ` (tar on the host: ${tail(packed.stderr) || `exit ${packed.code}`})` : '';
      throw new Error(`copy into sandbox failed: ${tail(r.stderr) || `exit ${r.code}`}${host}`);
    }
    if (packed.code !== 0) throw new Error(`could not pack ${hostDir}: ${tail(packed.stderr) || `tar exit ${packed.code}`}`);
  }

  /**
   * Copy a sandbox directory out to the host. Kept for runTask's report folder only: the agent loop
   * copies single files with readFile(). The tar is made inside the sandbox, so the project chooses
   * what is in it. After extracting, everything that is not a regular file or a directory is
   * deleted, symlinks above all, which could point at host secrets; if that clean-up fails, the
   * whole folder is deleted. Never serve or publish files from here.
   */
  async copyOut(src, hostDir) {
    if (typeof src !== 'string' || !src.startsWith('/')) throw new TypeError(`copyOut needs an absolute sandbox path, got ${JSON.stringify(src)}`);
    const dir = path.resolve(hostDir);
    if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) throw new Error(`copy out of sandbox: no such folder on the host: ${dir}`);
    const pack = produce('docker', ['exec', this.name, 'tar', '-C', src, '-cf', '-', '.']);
    const r = await run('tar', ['--no-same-owner', '--no-same-permissions', '-xf', '-', '-C', dir], { input: pack.stdout, timeoutMs: 120_000 });
    if (r.code !== 0) pack.kill();
    const packed = await pack.done;
    // Purge even after a failed extraction: a partial one can hold symlinks too. chmod first, so that
    // a directory the archive made unreadable cannot hide one from find (chmod -R skips symlinks).
    const open = await run('chmod', ['-R', 'u+rwX,go-w,ug-s', '--', dir], { timeoutMs: 60_000 });
    const purge = await run('find', [dir, '-mindepth', '1', '!', '-type', 'f', '!', '-type', 'd', '-delete'], { timeoutMs: 60_000 });
    if (open.code !== 0 || purge.code !== 0) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(`copy out of sandbox: could not clean ${dir}, so it was deleted: ${tail(purge.stderr || open.stderr) || 'no output'}`);
    }
    if (packed.code !== 0) throw new Error(`copy out of sandbox failed: ${tail(packed.stderr) || `exit ${packed.code}`}`);
    if (r.code !== 0) throw new Error(`copy out of sandbox failed: ${tail(r.stderr) || `exit ${r.code}`}`);
  }

  /**
   * Remove the container and everything in it. Calls made while a removal runs share it, and it
   * resolves only once the container is really gone (a second `docker rm -f` returns while the first
   * is still busy). A removal that failed is forgotten, so the next call really tries again.
   */
  destroy() {
    this.destroying ??= (async () => {
      await run('docker', ['rm', '-f', this.name], { timeoutMs: 60_000 });
      for (let i = 0; i < 50; i++) {
        if (await this.gone()) return;
        await sleep(200);
      }
      throw new Error(`container ${this.name} was not removed`);
    })().catch((err) => {
      this.destroying = null;
      throw err;
    });
    return this.destroying;
  }

  /**
   * Remove every container that carries `label` and wait until they are gone. The default is the
   * app's own sandboxes (startup and shutdown); self-test sandboxes are never touched.
   * @param {string} [label]  key=value
   * @returns {Promise<number>} how many containers were found and removed
   */
  static async removeAll(label = APP_LABEL) {
    checkLabel(label);
    const list = async () => {
      const r = await run('docker', ['ps', '-aq', '--filter', `label=${label}`], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(`docker ps failed: ${tail(r.stderr) || `exit ${r.code}`}`);
      return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    };
    const ids = await list();
    if (ids.length === 0) return 0;
    const r = await run('docker', ['rm', '-f', ...ids], { timeoutMs: 120_000 });
    // `docker rm -f` also fails for a container that a task's own destroy() removed meanwhile, so
    // success is judged by what is left, not by its exit code.
    let left = ids;
    for (let i = 0; i < 50 && left.length; i++) {
      if (i) await sleep(200);
      const now = await list();
      left = ids.filter((id) => now.includes(id));
    }
    if (left.length) throw new Error(`${left.length} of ${ids.length} containers labelled ${label} are still there: ${tail(r.stderr) || 'docker rm -f gave no reason'}`);
    return ids.length;
  }
}
