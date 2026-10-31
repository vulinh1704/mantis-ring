// TEST DATA for test/scenes.mjs: the network half of the hostile repository (see hostile.sh).
// Each call tries one way out and prints one line saying how far it got.
//   node exfil.mjs direct <host> <port>      a plain TCP connection
//   node exfil.mjs proxy <host> <port>       CONNECT through $HTTPS_PROXY; prints the proxy's status line
//   node exfil.mjs proxy-get <url>           a plain HTTP GET through $HTTP_PROXY
//   node exfil.mjs dns <name>                a DNS lookup
import dns from 'node:dns/promises';
import net from 'node:net';

const [mode, target, portArg] = process.argv.slice(2);
const port = Number(portArg);
const say = (result) => {
  console.log(`${mode} ${target}${portArg ? `:${port}` : ''} ${result}`);
  process.exit(0);
};
setTimeout(() => say('timeout'), 8000);

if (mode === 'direct') {
  net.connect(port, target).on('connect', () => say('connected')).on('error', (e) => say(`error ${e.code}`));
} else if (mode === 'proxy' || mode === 'proxy-get') {
  const proxy = new URL((mode === 'proxy' ? process.env.HTTPS_PROXY : process.env.HTTP_PROXY) ?? 'http://ring-proxy:8888');
  const request = mode === 'proxy'
    ? `CONNECT ${target}:${port} HTTP/1.1\r\nHost: ${target}:${port}\r\n\r\n`
    : `GET ${target} HTTP/1.1\r\nHost: ${new URL(target).host}\r\nConnection: close\r\n\r\n`;
  const socket = net.connect(Number(proxy.port), proxy.hostname);
  socket.on('connect', () => socket.write(request));
  socket.once('data', (d) => say(`status ${String(d).split('\r\n')[0]}`));
  socket.on('error', (e) => say(`error ${e.code}`));
} else if (mode === 'dns') {
  dns.lookup(target, { all: true }).then(
    (addresses) => say(`resolved ${addresses.map((a) => a.address).join(',')}`),
    (e) => say(`error ${e.code}`),
  );
} else {
  console.error('usage: node exfil.mjs direct|proxy <host> <port> | proxy-get <url> | dns <name>');
  process.exit(64);
}
