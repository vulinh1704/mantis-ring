// TEST DATA for test/scenes.mjs: a dev server that never exits. It accepts every connection and
// never answers it, ignores SIGTERM and SIGHUP, and keeps the event loop busy. Ctrl-C still stops it.
// Usage: node server-never-exits.mjs [--port 3000]   (or PORT=3000)
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const i = process.argv.indexOf('--port');
const port = Number(i > -1 ? process.argv[i + 1] : process.env.PORT ?? 3000);

for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => console.log(`ignored ${signal}`));

createServer(() => { /* never answer */ }).listen(port, '127.0.0.1', () => {
  writeFileSync('/tmp/dev.pid', String(process.pid));
  console.log(`listening on ${port}, pid ${process.pid}`);
});
setInterval(() => {}, 1000);
