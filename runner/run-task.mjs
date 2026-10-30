#!/usr/bin/env node
// Runs one task in a throwaway sandbox: bring the repo in (clone from GitHub or copy a local folder),
// install it, start its dev server, run `mantis look`, copy the report out, destroy the container.
// There is no AI in this file. During the event the agent loop drives the same Sandbox between looks.
//
// Usage: node runner/run-task.mjs --repo <github url | local dir> [--routes /,/settings] [--locales en,vi]
//        [--port 3000] [--dev-cmd "npm run dev"] [--timeout 600] [--out out] [--runtime runsc]
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Sandbox } from './sandbox.mjs';

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export async function runTask(opts, log = () => {}) {
  const { repo, routes = '/', locales, port = 3000, devCmd, timeoutSec = 600, outDir = 'out', runtime } = opts;
  const started = Date.now();
  const result = { ok: false, repo, steps: [] };
  const step = async (name, fn) => {
    const t = Date.now();
    log(`→ ${name}`);
    try { return await fn(); } finally { result.steps.push({ name, ms: Date.now() - t }); }
  };

  const box = await Sandbox.create({ runtime });
  result.sandbox = box.name;
  // Wall-clock cap for the whole task: when it fires, the container is destroyed mid-step.
  let expired = false;
  const deadline = setTimeout(() => { expired = true; log(`! task timed out after ${timeoutSec}s, destroying ${box.name}`); box.destroy(); }, timeoutSec * 1000);

  try {
    await step('bring the repo in', async () => {
      if (/^https?:\/\//.test(repo)) {
        if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(repo)) throw new Error('only public github.com repositories are supported');
        const r = await box.exec(`git clone --depth 1 ${sh(repo)} /work/app`, { timeoutMs: 120_000 });
        if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.trim().split('\n').pop()}`);
      } else {
        await box.copyIn(path.resolve(repo), '/work/app');
      }
    });

    const kind = await step('inspect the project', async () => {
      const r = await box.exec(`cd /work/app && if [ -f package.json ]; then node -p "JSON.stringify({scripts: require('./package.json').scripts || {}, lock: require('fs').existsSync('package-lock.json')})"; else echo static; fi`);
      return r.stdout.trim() === 'static' ? { static: true } : JSON.parse(r.stdout);
    });

    let start;
    if (devCmd) start = devCmd;
    else if (kind.static) start = `node /opt/ring/static-server.mjs /work/app ${port}`;
    else if (kind.scripts.dev) start = `PORT=${port} npm run dev -- --port ${port}`;
    else if (kind.scripts.start) start = `PORT=${port} npm start`;
    else start = `node /opt/ring/static-server.mjs /work/app ${port}`;

    if (!kind.static) {
      await step('install dependencies', async () => {
        const r = await box.exec(`cd /work/app && ${kind.lock ? 'npm ci' : 'npm install'} --no-audit --no-fund`, { timeoutMs: 300_000 });
        if (r.code !== 0) throw new Error(`install failed (${r.timedOut ? 'timeout' : `exit ${r.code}`}): ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
      });
    }

    await step('start the dev server', async () => {
      await box.execDetached(`cd /work/app && ${start}`, '/tmp/dev.log');
      for (let i = 0; i < 90; i++) {
        const r = await box.exec(`node -e "fetch('http://127.0.0.1:${port}/').then(() => process.exit(0), () => process.exit(1))"`);
        if (r.code === 0) return;
        if (expired) throw new Error('task timed out');
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      const tail = await box.exec('tail -n 20 /tmp/dev.log');
      throw new Error(`dev server did not answer on port ${port} within 90 s:\n${tail.stdout}`);
    });

    const look = await step('mantis look', async () => {
      const args = [`http://127.0.0.1:${port}`, '--routes', routes, ...(locales ? ['--locales', locales] : []), '--out', '/work/.mantis'];
      return box.exec(`cd /work && mantis look ${args.map(sh).join(' ')}`, { timeoutMs: 300_000 });
    });
    if (look.code === 2 || look.timedOut) throw new Error(`mantis could not check the app: ${(look.stderr || look.stdout).trim().split('\n').slice(-3).join(' | ')}`);

    const dest = path.resolve(outDir, box.name);
    await step('copy the report out', async () => {
      await mkdir(dest, { recursive: true });
      await box.copyOut('/work/.mantis/latest', dest);
    });
    const report = JSON.parse(await readFile(path.join(dest, 'report.json'), 'utf8'));
    Object.assign(result, { ok: true, reportDir: dest, summary: report.summary });
  } catch (err) {
    result.error = expired ? `task timed out after ${timeoutSec}s` : err.message;
  } finally {
    clearTimeout(deadline);
    await box.destroy();
    result.destroyed = true;
    result.seconds = Math.round((Date.now() - started) / 1000);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' }, routes: { type: 'string' }, locales: { type: 'string' }, port: { type: 'string' },
      'dev-cmd': { type: 'string' }, timeout: { type: 'string' }, out: { type: 'string' }, runtime: { type: 'string' },
    },
  });
  if (!values.repo) { console.error('usage: run-task.mjs --repo <github url | local dir> [--routes /] [--locales en,vi]'); process.exit(64); }
  const result = await runTask({
    repo: values.repo, routes: values.routes, locales: values.locales, port: values.port ? Number(values.port) : undefined,
    devCmd: values['dev-cmd'], timeoutSec: values.timeout ? Number(values.timeout) : undefined, outDir: values.out, runtime: values.runtime,
  }, (m) => console.error(m));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
