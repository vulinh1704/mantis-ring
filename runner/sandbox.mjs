// One throwaway container per task, driven through the docker CLI from the host.
// The container gets nothing from the host environment: no API keys, no tokens. It runs read-only,
// without capabilities, with memory, CPU and process caps, on an internal network whose only exit
// is the allowlist proxy. Every task ends with destroy(), whatever happened.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const LIMITS = { memory: '3g', cpus: '2', pids: 512, shm: '512m', work: '2g', tmp: '512m', home: '1g' };
const PROXY_NAME = 'ring-proxy';
const PROXY = `http://${PROXY_NAME}:8888`;

/** Run a command; resolve with its exit code and output. `input` is piped to stdin. */
export function run(cmd, args, { input, timeoutMs = 0, onData } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.stdout.on('data', (d) => { stdout += d; onData?.(String(d)); });
    child.stderr.on('data', (d) => { stderr += d; onData?.(String(d)); });
    child.on('close', (code, signal) => { if (timer) clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 1), stdout, stderr, timedOut }); });
    if (input) input.pipe(child.stdin); else child.stdin.end();
  });
}

export class Sandbox {
  constructor(name) { this.name = name; }

  /** Start a fresh container. `runtime: 'runsc'` uses gVisor where it is installed (the Vultr VM). */
  static async create({ image = 'mantis-ring/sandbox', runtime, limits = LIMITS } = {}) {
    const name = `ring-${randomBytes(4).toString('hex')}`;
    // The proxy's name goes into the sandbox's /etc/hosts. Under gVisor (runsc), Docker's embedded
    // DNS on a user-defined network cannot be reached, so `ring-proxy` would not resolve; see "DNS
    // doesn't work on a Docker user defined bridge network" in https://gvisor.dev/docs/user_guide/faq/.
    const ip = await run('docker', ['inspect', '-f', `{{(index .NetworkSettings.Networks "ring-internal").IPAddress}}`, PROXY_NAME]);
    const proxyIp = ip.stdout.trim();
    if (ip.code !== 0 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(proxyIp)) throw new Error(`${PROXY_NAME} is not running on ring-internal: run scripts/setup.sh`);
    const args = [
      'run', '-d', '--name', name, '--label', 'mantis-ring=task',
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
    const r = await run('docker', args);
    if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim()}`);
    return new Sandbox(name);
  }

  /** Run a shell command inside the sandbox. */
  exec(script, opts = {}) {
    return run('docker', ['exec', ...(opts.input ? ['-i'] : []), this.name, 'sh', '-c', script], opts);
  }

  /** Start a long-running command (a dev server) in the background; its output goes to `log`. */
  execDetached(script, log) {
    return run('docker', ['exec', '-d', this.name, 'sh', '-c', `${script} > ${log} 2>&1`]);
  }

  /** Copy a host directory into the sandbox (as a tar stream: `docker cp` can't write to tmpfs). */
  async copyIn(hostDir, dest) {
    const tar = spawn('tar', ['-C', hostDir, '--exclude=node_modules', '--exclude=.git', '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const r = await this.exec(`mkdir -p ${dest} && tar -xf - -C ${dest}`, { input: tar.stdout });
    if (r.code !== 0) throw new Error(`copy into sandbox failed: ${r.stderr.trim()}`);
  }

  /** Copy a sandbox directory out to the host. */
  async copyOut(src, hostDir) {
    const out = spawn('docker', ['exec', this.name, 'tar', '-C', src, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const r = await run('tar', ['-xf', '-', '-C', hostDir], { input: out.stdout });
    if (r.code !== 0) throw new Error(`copy out of sandbox failed: ${r.stderr.trim()}`);
  }

  /**
   * Remove the container and everything in it. Every call shares one removal and resolves only
   * once the container is really gone (a second `docker rm -f` returns while the first is still busy).
   */
  destroy() {
    this.destroying ??= (async () => {
      await run('docker', ['rm', '-f', this.name]);
      for (let i = 0; i < 50; i++) {
        if ((await run('docker', ['ps', '-aq', '--filter', `name=^${this.name}$`])).stdout.trim() === '') return;
        await new Promise((ok) => setTimeout(ok, 200));
      }
      throw new Error(`container ${this.name} was not removed`);
    })();
    return this.destroying;
  }
}
