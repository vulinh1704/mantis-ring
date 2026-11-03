#!/usr/bin/env node
// TEST DOUBLE for test/agent-loop.mjs (U11): the docker commands that runner/sandbox.mjs runs for a
// sandbox container and its own network, played against a JSON state file named by
// DOCKER_FAKE_STATE (a DOCKER_* variable, so childEnv() passes it on). It never calls the real
// docker and makes no container and no network. `fail` in the state makes an operation fail that
// many times: run, rm, network-create, network-connect, network-rm. `run-late` plays a `docker run`
// whose client gives up while the daemon goes on: the run fails and makes nothing, and the container
// appears, running on its network, at the next `network disconnect` (after destroy() saw it gone).
// Usage: put a `docker` shim that runs this file first on PATH (U11 does), or call it directly.
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';

const file = process.env.DOCKER_FAKE_STATE;
if (!file) {
  console.error('fake docker: DOCKER_FAKE_STATE is not set');
  process.exit(2);
}
const args = process.argv.slice(2);
if (args[0] === 'fake-docker-ping') {
  console.log('fake docker');
  process.exit(0);
}

const VALUE_FLAGS = ['--label', '--filter', '--format', '--name', '--network', '--add-host', '--type', '--tmpfs', '--shm-size',
  '--memory', '--memory-swap', '--cpus', '--pids-limit', '--cap-drop', '--security-opt', '-e', '--runtime', '--alias'];
const out = [];
const err = [];
let st;

/** Flags (with their values, repeated ones as a list) and positional arguments. */
function parse(list, extra = []) {
  const takes = new Set([...VALUE_FLAGS, ...extra]);
  const flags = {};
  const pos = [];
  for (let i = 0; i < list.length; i++) {
    const x = list[i];
    if (takes.has(x)) (flags[x] ??= []).push(list[++i]);
    else if (x.startsWith('-')) flags[x] = [true];
    else pos.push(x);
  }
  return { flags, pos };
}

const labelsOf = (list = []) => Object.fromEntries(list.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

/** docker's --filter: name=<regexp>, label=<key> or label=<key>=<value>; every filter must match. */
function matches(name, labels, filters = []) {
  return filters.every((f) => {
    const eq = f.indexOf('=');
    const key = f.slice(0, eq);
    const value = f.slice(eq + 1);
    if (key === 'name') return new RegExp(value).test(name);
    if (key !== 'label') return false;
    const e = value.indexOf('=');
    return e < 0 ? Object.hasOwn(labels ?? {}, value) : labels?.[value.slice(0, e)] === value.slice(e + 1);
  });
}

function fails(op) {
  if ((st.fail[op] ?? 0) <= 0) return false;
  st.fail[op]--;
  return true;
}

function no(message, code = 1) {
  err.push(message);
  return code;
}

function handle(a) {
  const [cmd, sub] = a;
  if (cmd === 'network' && sub === 'create') {
    const { flags, pos } = parse(a.slice(2));
    const name = pos.at(-1);
    if (fails('network-create')) return no('Error response from daemon: all predefined address pools have been fully subnetted');
    if (st.networks[name]) return no(`Error response from daemon: network with name ${name} already exists`);
    const n = ++st.seq;
    st.networks[name] = { id: `net${n}`, internal: Boolean(flags['--internal']), labels: labelsOf(flags['--label']), created: new Date().toISOString(), subnet: n, members: {} };
    out.push(`net${n}`);
    return 0;
  }
  if (cmd === 'network' && sub === 'connect') {
    const [net, ctr] = parse(a.slice(2)).pos;
    if (fails('network-connect')) return no(`Error response from daemon: container ${ctr} is not running`);
    if (!st.networks[net]) return no(`Error response from daemon: network ${net} not found`);
    if (ctr !== 'ring-proxy' || !st.proxy) return no(`Error response from daemon: No such container: ${ctr}`);
    st.networks[net].members[ctr] = `10.${st.networks[net].subnet}.0.2`;
    return 0;
  }
  if (cmd === 'network' && sub === 'disconnect') {
    if (st.late) {
      const { name, net: home, ...c } = st.late;
      delete st.late;
      if (st.networks[home]) {
        st.containers[name] = { ...c, network: home, running: true };
        st.networks[home].members[name] = `10.${st.networks[home].subnet}.0.3`;
      }
    }
    const [net, ctr] = parse(a.slice(2)).pos;
    if (!st.networks[net]) return no(`Error response from daemon: network ${net} not found`);
    if (!Object.hasOwn(st.networks[net].members, ctr)) return no(`Error response from daemon: container ${ctr} is not connected to network ${net}`);
    delete st.networks[net].members[ctr];
    return 0;
  }
  if (cmd === 'network' && sub === 'rm') {
    let code = 0;
    for (const net of parse(a.slice(2)).pos) {
      if (!st.networks[net]) { code = no(`Error response from daemon: network ${net} not found`); continue; }
      if (fails('network-rm')) { code = no(`Error response from daemon: error while removing network: ${net}`); continue; }
      if (Object.keys(st.networks[net].members).length) { code = no(`Error response from daemon: error while removing network: network ${net} has active endpoints`); continue; }
      delete st.networks[net];
      out.push(net);
    }
    return code;
  }
  if (cmd === 'network' && sub === 'ls') {
    const { flags } = parse(a.slice(2));
    for (const [name, n] of Object.entries(st.networks)) if (matches(name, n.labels, flags['--filter'])) out.push(flags['-q'] ? n.id : name);
    return 0;
  }
  if (cmd === 'network' && sub === 'inspect') {
    let code = 0;
    for (const net of parse(a.slice(2)).pos) {
      const n = st.networks[net];
      if (!n) { code = no(`Error: No such network: ${net}`); continue; }
      const Containers = Object.fromEntries(Object.keys(n.members).map((m, i) => [`ep${i}`, { Name: m }]));
      out.push(JSON.stringify({ Name: net, Id: n.id, Created: n.created, Internal: n.internal, Labels: n.labels, Containers }));
    }
    return code;
  }
  if (cmd === 'inspect') {
    const { flags, pos } = parse(a.slice(1), ['-f']);
    const fmt = flags['-f']?.[0] ?? '';
    const m = /^\{\{\(index \.NetworkSettings\.Networks "([^"]+)"\)\.IPAddress\}\}$/.exec(fmt);
    if (m) {
      const ip = st.networks[m[1]]?.members[pos[0]];
      if (!ip) return no('template: :1:3: executing "" at <...>: nil pointer evaluating *network.EndpointSettings.IPAddress');
      out.push(ip);
      return 0;
    }
    if (fmt === '{{.HostConfig.Runtime}}') {
      if (!st.containers[pos[0]]) return no(`Error: No such container: ${pos[0]}`);
      out.push('runc');
      return 0;
    }
    if (fmt === '{{.Id}} {{.Created}}' && flags['--type']?.[0] === 'container') {
      // Like the real one: a reference that is gone fails the command, and the others are still printed.
      let code = 0;
      for (const ref of pos) {
        const c = st.containers[ref] ?? Object.values(st.containers).find((x) => x.id === ref);
        if (!c) { code = no(`Error: No such container: ${ref}`); continue; }
        out.push(`${c.id} ${c.created}`);
      }
      return code;
    }
    return no(`fake docker: this inspect format is not played: ${fmt}`, 2);
  }
  if (cmd === 'run') {
    const { flags, pos } = parse(a.slice(1));
    const name = flags['--name']?.[0];
    const net = flags['--network']?.[0];
    if (st.containers[name]) return no(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use`, 125);
    if (!st.networks[net]) return no(`docker: Error response from daemon: network ${net} not found`, 125);
    const id = `ctr${++st.seq}`;
    const record = { id, labels: labelsOf(flags['--label']), network: net, addHost: flags['--add-host'] ?? [], running: false, image: pos.at(-1), created: new Date().toISOString() };
    if (fails('run-late')) {
      st.late = { name, net, ...record };
      return no('docker: error during connect: context canceled', 125);
    }
    // Like the real one, a run that fails to start may leave the container created.
    st.containers[name] = record;
    if (fails('run')) return no('docker: Error response from daemon: failed to create task for container: OCI runtime create failed', 125);
    st.containers[name].running = true;
    st.networks[net].members[name] = `10.${st.networks[net].subnet}.0.3`;
    out.push(id);
    return 0;
  }
  if (cmd === 'rm') {
    let code = 0;
    for (const ref of parse(a.slice(1)).pos) {
      const name = st.containers[ref] ? ref : Object.keys(st.containers).find((k) => st.containers[k].id === ref);
      if (!name) { code = no(`Error response from daemon: No such container: ${ref}`); continue; }
      if (fails('rm')) { code = no(`Error response from daemon: could not kill container: ${ref}`); continue; }
      const net = st.networks[st.containers[name].network];
      if (net) delete net.members[name];
      delete st.containers[name];
    }
    return code;
  }
  if (cmd === 'ps') {
    const { flags } = parse(a.slice(1));
    for (const [name, c] of Object.entries(st.containers)) if (matches(name, c.labels, flags['--filter'])) out.push(c.id);
    return 0;
  }
  return no(`fake docker: this command is not played: ${a.join(' ')}`, 2);
}

// One command at a time: the create() and destroy() of two sandboxes can run at once.
const lock = `${file}.lock`;
const nap = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; ; i++) {
  try {
    mkdirSync(lock);
    break;
  } catch (e) {
    if (e.code !== 'EEXIST' || i >= 1000) throw e;
    Atomics.wait(nap, 0, 0, 10);
  }
}
let code;
try {
  st = JSON.parse(readFileSync(file, 'utf8'));
  st.log.push(args.join(' '));
  code = handle(args);
  writeFileSync(`${file}.tmp`, JSON.stringify(st));
  renameSync(`${file}.tmp`, file);
} finally {
  rmdirSync(lock);
}
if (out.length) process.stdout.write(`${out.join('\n')}\n`);
if (err.length) process.stderr.write(`${err.join('\n')}\n`);
process.exit(code);
