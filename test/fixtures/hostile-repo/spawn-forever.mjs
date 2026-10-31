// TEST DATA for test/scenes.mjs: the fork-bomb half of the hostile repository (see hostile.sh).
// Starts `sleep` processes as fast as it can and never gives up: when the kernel refuses a new
// process, it tries again. Only a time limit or the container's removal stops it.
// Like hostile.sh, it refuses to run anywhere but a Mantis Ring sandbox: inside Docker, as uid 10001,
// behind the ring proxy.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('/.dockerenv') || process.getuid?.() !== 10001 || process.env.HTTPS_PROXY !== 'http://ring-proxy:8888') {
  console.error('spawn-forever.mjs: refusing to run, this is not a Mantis Ring sandbox');
  process.exit(3);
}

let started = 0;
let refused = 0;
setInterval(() => console.log(`started ${started} refused ${refused}`), 1000);

const again = () => {
  try {
    spawn('sleep', ['7771'], { stdio: 'ignore' })
      .on('spawn', () => { started += 1; })
      .on('error', () => { refused += 1; });
  } catch {
    refused += 1;
  }
  setImmediate(again);
};
again();
