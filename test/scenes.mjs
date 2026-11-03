#!/usr/bin/env node
// Containment scenes built on the fixtures in test/fixtures/: a hostile repository and a dev server
// that never exits. The fixtures are test data: each is copied into a fresh sandbox and runs there,
// and hostile.sh refuses to run anywhere else. Each check prints PASS or FAIL, like containment.mjs.
// Usage: node test/scenes.mjs   (after scripts/setup.sh; RING_RUNTIME=runsc runs the sandboxes in gVisor)
// At exit it writes ~/.ring/selftest/scenes.json, the result the app shows on /status.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, Sandbox, run } from '../runner/sandbox.mjs';
import { runTask } from '../runner/run-task.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const HOSTILE = path.join(FIXTURES, 'hostile-repo');
const NEVER = path.join(FIXTURES, 'never-exits');
const runtime = process.env.RING_RUNTIME || undefined;

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const gone = async (name) => (await run('docker', ['ps', '-aq', '--filter', `name=^${name}$`])).stdout.trim() === '';
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** The rest of the first output line that starts with `key `, or 'no result'. */
const field = (out, key) => out.split('\n').find((l) => l.startsWith(`${key} `))?.slice(key.length + 1).trim() ?? 'no result';

console.log(`runtime: ${runtime ?? 'docker default'}`);

// The result file for /status, written at exit. A suite that crashes part-way gets one failed check
// more, so a partial run never reads as a full pass. `runtime` is what Docker reports for the sandbox;
// `commit` is the deployed commit (app/VERSION.json), so /status can tell a result from older code.
let sandboxRuntime = null;
let finished = false;
const deployedCommit = () => {
  try { return JSON.parse(readFileSync(new URL('../app/VERSION.json', import.meta.url), 'utf8')).commit ?? null; } catch { return null; }
};
process.on('exit', () => {
  const checks = results.map(({ name, pass }) => ({ name, pass }));
  if (!finished) checks.push({ name: 'the suite ran to the end', pass: false });
  const file = path.join(os.homedir(), '.ring', 'selftest', 'scenes.json');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const data = { suite: 'scenes', runtime: sandboxRuntime ?? runtime ?? null, commit: deployedCommit(), passed: checks.filter((c) => c.pass).length, total: checks.length, at: new Date().toISOString(), checks };
    writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.error(`could not write ${file}: ${err.message}`);
  }
});
// Stopped from outside (the app's 20-minute self-test limit, Ctrl-C, a dropped SSH session): the
// sandboxes this run made go first, with their networks (8 s at most), then exit through the handler
// above, so the result file records a failed run instead of keeping the previous one.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    Sandbox.destroyLive().catch(() => {}).finally(() => process.exit(1));
  });
}

// Secrets on the host that must never reach the sandbox: one in this process's environment (the
// docker CLI inherits it) and one in a file outside the fixture. A canary file checks the host is untouched.
const SECRET = `sk-ring-host-${randomBytes(8).toString('hex')}`;
process.env.RING_FAKE_API_KEY = SECRET;
const hostDir = await mkdtemp(path.join(os.tmpdir(), 'ring-host-'));
const secretFile = path.join(hostDir, 'secrets.env');
const canary = path.join(hostDir, 'canary.txt');
await writeFile(secretFile, `RING_FAKE_API_KEY=${SECRET}\n`, { mode: 0o600 });
await writeFile(canary, 'untouched\n');

// The guards first: on the host, hostile.sh and spawn-forever.mjs must refuse before they do anything.
const outside = spawnSync('sh', [path.join(HOSTILE, 'hostile.sh'), 'check'], { encoding: 'utf8' });
const outsideSpawn = spawnSync(process.execPath, [path.join(HOSTILE, 'spawn-forever.mjs')], { encoding: 'utf8', timeout: 10_000 });
check('hostile.sh and spawn-forever.mjs refuse to run outside a sandbox', outside.status === 3 && outsideSpawn.status === 3,
  `${(outside.stderr || outside.stdout).trim()}; ${(outsideSpawn.stderr || outsideSpawn.stdout).trim() || `exit ${outsideSpawn.status ?? outsideSpawn.signal}`}`);

// Scene 1: the hostile repository, phase by phase, in one sandbox.
const box = await Sandbox.create({ runtime });
try {
  sandboxRuntime = await box.runtimeName().catch(() => null);
  await box.copyIn(HOSTILE, '/work/app');
  const inside = await box.exec('cd /work/app && sh hostile.sh check');
  check('hostile.sh runs inside the sandbox', inside.code === 0, inside.stdout.trim() || inside.stderr.trim());

  const s = await box.exec(`cd /work/app && sh hostile.sh secrets ${sh(secretFile)}`, { timeoutMs: 60_000 });
  const ranSecrets = s.stdout.includes('ran secrets');
  const suspicious = field(s.stdout, 'env-suspicious');
  check('hostile repo: no secret in its environment or any process environment',
    ranSecrets && suspicious === 'none' && !s.stdout.includes(SECRET),
    ranSecrets ? `credential-like variable names: ${suspicious}; host key value absent` : 'phase did not run');
  const found = s.stdout.split('\n').filter((l) => l.startsWith('found '));
  const tried = s.stdout.split('\n').filter((l) => /^(found|denied|not-visible) /.test(l)).length;
  check('hostile repo: no secrets file, SSH key or Docker socket to read',
    ranSecrets && tried > 0 && found.length === 0,
    `${tried} paths tried, incl. /etc/mantis-ring/secrets.env and the host's secret file; ${found.length ? `found: ${found.join(', ')}` : 'none visible'}`);

  const e = await box.exec('cd /work/app && sh hostile.sh egress', { timeoutMs: 120_000 });
  const viaProxy = {
    'example.org:443': field(e.stdout, 'proxy example.org:443'),
    'http://example.org/': field(e.stdout, 'proxy-get http://example.org/'),
    '169.254.169.254:80': field(e.stdout, 'proxy 169.254.169.254:80'),
  };
  const npm = field(e.stdout, 'proxy registry.npmjs.org:443');
  check('hostile repo: hosts off the allowlist get 403 from the proxy, cloud metadata address included',
    Object.values(viaProxy).every((r) => /^status HTTP\/1\.[01] 403/.test(r)) && /^status HTTP\/1\.[01] 200/.test(npm),
    `${Object.entries(viaProxy).map(([k, v]) => `${k} ${v.replace('status ', '')}`).join('; ')}; allowlisted registry.npmjs.org ${npm.replace('status ', '')}`);
  const direct = ['example.org:443', '1.1.1.1:443', '169.254.169.254:80'].map((t) => `${t} ${field(e.stdout, `direct ${t}`)}`);
  check('hostile repo: no direct connection out, cloud metadata address included',
    e.stdout.includes('ran egress') && direct.every((r) => !r.endsWith(' connected') && !r.endsWith('no result')), direct.join('; '));
  const lookup = field(e.stdout, 'dns example.org');
  check('hostile repo: public host names do not resolve inside the sandbox', lookup.startsWith('error'), `example.org: ${lookup}`);

  const w = await box.exec('cd /work/app && sh hostile.sh wipe', { timeoutMs: 180_000 });
  const before = Number(field(w.stdout, 'rootfs-before'));
  const after = Number(field(w.stdout, 'rootfs-after'));
  const tools = await box.exec('mantis --version && test -f /opt/ring/static-server.mjs', { timeoutMs: 30_000 });
  check('hostile repo: rm -rf / leaves the read-only root filesystem intact',
    w.stdout.includes('ran wipe') && before > 1000 && after === before && tools.code === 0,
    `${before} → ${after} entries on /, ${field(w.stdout, 'refused')} refusals; mantis ${tools.stdout.trim() || 'missing'} still runs`);
  const left = ['/work', '/tmp', '/home/ring'].map((d) => `${d} ${field(w.stdout, `left ${d}`)}`);
  check('hostile repo: rm -rf / only empties the throwaway tmpfs mounts',
    left.every((l) => l.endsWith(' 0')), `${left.join(', ')} entries left; the fixture deleted itself`);
} finally {
  await box.destroy();
}
check('hostile repo: its container is gone after destroy()', await gone(box.name));

const hostOk = (await readFile(canary, 'utf8')) === 'untouched\n'
  && (await readFile(secretFile, 'utf8')).includes(SECRET)
  && existsSync(path.join(HOSTILE, 'hostile.sh'));
check('hostile repo: the host is untouched', hostOk, 'canary, secret file and the fixture itself still in place');

// The spawn loop in its own sandbox: once the process table is full, nothing new can start inside,
// so the process count is read from the host.
const spin = await Sandbox.create({ runtime });
try {
  await spin.copyIn(HOSTILE, '/work/app');
  const t = Date.now();
  const r = await spin.exec('cd /work/app && sh hostile.sh spawn', { timeoutMs: 20_000 });
  const secs = Math.round((Date.now() - t) / 1000);
  const t2 = Date.now();
  const pids = Number((await run('docker', ['stats', '--no-stream', '--format', '{{.PIDs}}', spin.name])).stdout.trim());
  const answered = ((Date.now() - t2) / 1000).toFixed(1);
  const last = r.stdout.trim().split('\n').filter((l) => l.startsWith('started ')).pop() ?? 'no progress line';
  const refused = Number(last.match(/refused (\d+)/)?.[1] ?? 0);
  check('hostile repo: an endless spawn loop is held at the process cap until its time limit',
    r.stdout.includes('ran spawn') && r.timedOut && refused > 0 && pids > 0 && pids <= LIMITS.pids,
    `${pids} processes (cap ${LIMITS.pids}); last progress "${last}"; cut off after ${secs}s; docker stats answered in ${answered}s`);
} finally {
  await spin.destroy();
}
check('hostile repo: the spawn-loop container is gone too', await gone(spin.name));

// Scene 2: a dev server that never exits: it listens, never answers and ignores SIGTERM.
const dev = await Sandbox.create({ runtime });
try {
  await dev.copyIn(NEVER, '/work/app');
  await dev.execDetached('cd /work/app && node server-never-exits.mjs --port 3000', '/tmp/dev.log');
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    up = (await dev.exec('cat /tmp/dev.log')).stdout.includes('listening');
    if (!up) await sleep(250);
  }
  const probe = await dev.exec(`node -e "fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(3000) }).then(() => console.log('answered'), (e) => console.log(e.name))"`, { timeoutMs: 20_000 });
  await dev.exec('kill -TERM "$(cat /tmp/dev.pid)"');
  await sleep(1000);
  const alive = (await dev.exec('kill -0 "$(cat /tmp/dev.pid)" && echo alive')).stdout.includes('alive');
  check('dev server: it listens, never answers and survives SIGTERM inside the sandbox',
    up && probe.stdout.trim() === 'TimeoutError' && alive,
    `request: ${probe.stdout.trim() || probe.stderr.trim()} after 3 s; after SIGTERM: ${alive ? 'still running' : 'stopped'}`);
} finally {
  await dev.destroy();
}
check('dev server: destroy() removes it anyway', await gone(dev.name));

// The same project through the runner: install, `npm run dev`, wait for an answer that never comes.
const t = Date.now();
const hung = await runTask({ repo: NEVER, timeoutSec: 30, runtime, outDir: hostDir });
const secs = Math.round((Date.now() - t) / 1000);
const steps = hung.steps.map((s) => s.name);
check('dev server: the runner stops the project at the task time limit',
  !hung.ok && /timed out/.test(hung.error ?? '') && steps.includes('start the dev server') && secs <= 45,
  `${hung.error?.split('\n')[0]} after ${secs}s; steps: ${steps.join(' → ')}`);
check('dev server: its container is destroyed too', hung.destroyed && await gone(hung.sandbox));

await rm(hostDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} scene checks passed`);
finished = true;
process.exit(failed.length ? 1 : 0);
