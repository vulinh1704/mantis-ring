// TEST DATA for test/scenes.mjs: a yarn that the repository ships itself (yarnPath), so the runner
// runs it as the install. It prints a flood, 20 MiB on stdout and 5 MiB on stderr, then one last line,
// and exits with the code written in ./flood-exit. The runner must still finish an install that
// exits 0, and for one that fails it must read the end of the output and the install's own exit code.
// Like hostile.sh, it refuses to run anywhere but a Mantis Ring sandbox: inside Docker, as uid 10001,
// behind the ring proxy.
import { existsSync, readFileSync, writeSync } from 'node:fs';

if (!existsSync('/.dockerenv') || process.getuid?.() !== 10001 || process.env.HTTPS_PROXY !== 'http://ring-proxy:8888') {
  console.error('flood.mjs: refusing to run, this is not a Mantis Ring sandbox');
  process.exit(3);
}

let code = 0;
try { code = Number(readFileSync('flood-exit', 'utf8').trim()) || 0; } catch { code = 0; }
const block = 'ring-flood: an install that prints far more than anyone reads ................\n'.repeat(1024); // 80 KiB
for (let i = 0; i < 256; i++) {
  writeSync(1, block);
  if (i % 4 === 0) writeSync(2, block);
}
writeSync(1, 'ring-flood-last-line\n');
process.exit(code);
