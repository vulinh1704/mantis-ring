// TEST DATA for test/scenes.mjs: the fork-bomb half of the hostile repository (see hostile.sh).
// Starts `sleep` processes as fast as it can and never gives up: when the kernel refuses a new
// process, it tries again. Only a time limit or the container's removal stops it.
import { spawn } from 'node:child_process';

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
