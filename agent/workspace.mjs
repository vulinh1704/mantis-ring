// Git snapshots of the project inside the task sandbox. The agent loop commits /work/app before the
// model starts and after every accepted check, so a rejected round (cover-up, tamper, failed check)
// is undone exactly with `reset --hard`, and the final patch is the diff of the files the model
// touched, nothing else. Mantis writes its runs to /work/.mantis, outside the repository, so
// reports never enter a diff.
//
// Every git command runs inside the sandbox through `execArgs` (positional arguments, never a
// spliced shell string), under an in-sandbox `timeout -k 5 60`, with hooks, fsmonitor, signing and
// auto-gc switched off and literal pathspecs, so a file the model named `*.css` cannot widen a diff.

export const GIT = 'git -C /work/app -c user.name=ring -c user.email=ring@sandbox.invalid -c core.hooksPath=/dev/null ' +
  '-c commit.gpgsign=false -c core.fsmonitor=false -c gc.auto=0 -c core.autocrlf=false -c core.quotepath=off';

const APP = '/work/app';
const VERIFY_DIR = '/work/.verify';
const GIT_ARGV = [...GIT.split(' '), '--literal-pathspecs'];
const IN_BOX_TIMEOUT = ['timeout', '-k', '5', '60'];
const HOST_TIMEOUT_MS = 75_000; // longer than the in-sandbox timeout, so `timeout` reports first
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
// Words that only appear when an edit targets the measurement instead of the page (§2.6). The
// spec's list, plus `mantis-ignore`/`mantisIgnore` (the attribute set through `dataset`), `mantis`
// on its own, `webdriver` on its own (`navigator['webdriver']`), headless and user-agent sniffing,
// and the usual ways to hide a word in a string (atob, character codes, \x and \u escapes). A UI fix
// never needs any of them. This is a denylist, so it raises the bar rather than closing the door:
// the README's Known limits says so.
const TAMPER = new RegExp([
  'data-mantis', 'mantis-?(?:ignore|overlay)', 'mantis', 'navigator\\.webdriver', 'webdriver', 'headlesschrome', 'headless',
  'useragent', 'playwright', 'puppeteer', '__nightmare', 'cypress', 'atob\\s*\\(', 'fromcharcode', 'fromcodepoint',
  '\\\\x[0-9a-f]{2}', '\\\\u00[0-9a-f]{2}', '\\\\u\\{[0-9a-f]+\\}',
].join('|'), 'gi');
// A word split across string literals ('data-man' + 'tis-ignore', ['web', 'driver'].join('')) is
// joined back before the scan: the quotes and the + or , between two literals are dropped.
const JOINS = /(['"`])\s*[+,]\s*(['"`])/g;

const lastLine = (s) => String(s ?? '').trim().split('\n').pop().slice(0, 200);

/** Run one git command in the sandbox's project; throw a plain error unless the exit code is allowed. */
async function git(box, args, { input, okCodes = [0], argv = GIT_ARGV } = {}) {
  const r = await box.execArgs([...IN_BOX_TIMEOUT, ...argv, ...args], { timeoutMs: HOST_TIMEOUT_MS, ...(input === undefined ? {} : { input }) });
  if (r.timedOut || r.code === 124 || r.code === 137) throw new Error(`git ${args[0]} timed out in the sandbox`);
  if (r.truncated) throw new Error(`git ${args[0]} printed more output than the runner keeps`);
  if (!okCodes.includes(r.code)) throw new Error(`git ${args[0]} failed (exit ${r.code}): ${lastLine(r.stderr) || 'no message'}`);
  return r;
}

function checkSha(sha, what = 'commit') {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error(`not a ${what} id: ${String(sha).slice(0, 80)}`);
  return sha;
}

/** Project-relative paths, deduplicated. Anything else is a bug upstream (tools.mjs checks paths), so it throws. */
function relPaths(paths) {
  const out = new Set();
  for (const p of paths ?? []) {
    const rel = typeof p === 'string' && p.startsWith(`${APP}/`) ? p.slice(APP.length + 1) : p;
    if (typeof rel !== 'string' || rel === '' || rel.startsWith('/') || rel.split('/').includes('..') || /[\x00-\x1f]/.test(rel)) {
      throw new Error(`not a project-relative path: ${JSON.stringify(String(p)).slice(0, 120)}`);
    }
    out.add(rel);
  }
  return [...out];
}

/**
 * Prepare /work/app for snapshots: `git init` when the project has no repository (a copied sample),
 * remember the cloned commit for GitHub projects, keep node_modules/ and .mantis/ out, and commit
 * everything as the base snapshot.
 * @param {import('../runner/sandbox.mjs').Sandbox} box
 * @param {{kind: 'local'|'github'}} src  what bringIn() returned
 * @returns {Promise<{base: string, upstream: string|null}>}
 */
export async function initWorkspace(box, { kind } = {}) {
  const probe = await box.execArgs(['sh', '-c', 'if [ -L "$1" ]; then exit 4; elif [ -d "$1" ]; then exit 0; elif [ -e "$1" ]; then exit 4; else exit 3; fi', 'probe', `${APP}/.git`], { timeoutMs: 20_000 });
  if (probe.code === 4) throw new Error(`${APP}/.git is not a plain directory`);
  if (probe.code !== 0 && probe.code !== 3) throw new Error(`could not inspect ${APP} (exit ${probe.code}): ${lastLine(probe.stderr) || 'no message'}`);
  if (probe.code === 3 && kind === 'github') throw new Error('the cloned project has no .git directory');
  if (probe.code === 3) await git(box, ['init', '-q', '-b', 'ring']);

  let upstream = null;
  if (kind === 'github') upstream = checkSha((await git(box, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim(), 'cloned commit');

  const ex = await box.execArgs(['sh', '-c', 'mkdir -p "$1/info" && printf "%s\\n" "node_modules/" ".mantis/" >> "$1/info/exclude"', 'exclude', `${APP}/.git`], { timeoutMs: 20_000 });
  if (ex.code !== 0) throw new Error(`could not write .git/info/exclude (exit ${ex.code}): ${lastLine(ex.stderr) || 'no message'}`);

  await stageAll(box);
  const base = await snapshot(box, 'base');
  return { base, upstream };
}

/**
 * Stage the whole project (`git add -A`). `force` lists the paths the model wrote since the last
 * check: they are resolved inside the sandbox (realpath, so a write through a symlinked folder is
 * staged under its real name) and added with `-f`, so a file the project's .gitignore ignores still
 * reaches the diff, the tamper scan, a revert and the patch.
 * @param {import('../runner/sandbox.mjs').Sandbox} box
 * @param {string[]} [force]  project-relative paths
 * @returns {Promise<string[]>}  the resolved project-relative paths that were force-staged
 */
export async function stageAll(box, force = []) {
  await git(box, ['add', '-A']);
  const list = relPaths(force);
  if (!list.length) return [];
  // The script gets the paths as positional parameters; only our own constant is spliced into it.
  const script = [
    `cd ${APP} || exit 3`,
    'list=$(mktemp) || exit 3',
    'for p in "$@"; do',
    '  [ -e "$p" ] || [ -L "$p" ] || continue',
    `  r=$(realpath -m --relative-to=${APP} -- "$p") || continue`,
    '  case "$r" in .|..|../*|/*) continue ;; esac',
    `  printf '%s\\0' "$r" >> "$list"`,
    'done',
    `s=0; if [ -s "$list" ]; then ${IN_BOX_TIMEOUT.join(' ')} ${GIT_ARGV.join(' ')} add -f --pathspec-from-file="$list" --pathspec-file-nul; s=$?; fi`,
    'cat "$list"; rm -f "$list"; exit $s',
  ].join('\n');
  const r = await box.execArgs(['sh', '-c', script, 'stage', ...list], { timeoutMs: HOST_TIMEOUT_MS });
  if (r.timedOut || r.code === 124 || r.code === 137) throw new Error('git add timed out in the sandbox');
  if (r.code !== 0) throw new Error(`git add -f failed (exit ${r.code}): ${lastLine(r.stderr) || 'no message'}`);
  return r.stdout.split('\0').filter(Boolean);
}

/**
 * Commit what is staged as one snapshot (empty commits allowed, hooks skipped).
 * @param {import('../runner/sandbox.mjs').Sandbox} box
 * @param {string} label  becomes the message "ring: <label>"
 * @returns {Promise<string>} the new commit id
 */
export async function snapshot(box, label) {
  await git(box, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `ring: ${String(label).slice(0, 80)}`]);
  return checkSha((await git(box, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim(), 'snapshot commit');
}

/**
 * Put the project back exactly as snapshot `sha` left it. Everything is staged first, so files
 * created since `sha` are deleted too. Throws when anything is left over afterwards.
 * @param {import('../runner/sandbox.mjs').Sandbox} box
 * @param {string} sha
 * @returns {Promise<void>}
 */
export async function revertTo(box, sha) {
  checkSha(sha);
  await git(box, ['add', '-A']);
  await git(box, ['reset', '-q', '--hard', sha]);
  const st = await git(box, ['status', '--porcelain']);
  if (st.stdout.trim() !== '') throw new Error(`files still differ after the revert to ${sha.slice(0, 12)}: ${st.stdout.trim().split('\n').slice(0, 5).join('; ').slice(0, 300)}`);
}

/**
 * Whether the working tree's tracked files equal commit `sha` (`git diff --quiet <sha>`): the
 * after-revert confirmation the loop logs.
 * @param {import('../runner/sandbox.mjs').Sandbox} box
 * @param {string} sha
 * @returns {Promise<boolean>}
 */
export async function isClean(box, sha) {
  checkSha(sha);
  const r = await git(box, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', sha], { okCodes: [0, 1] });
  return r.code === 0;
}

/**
 * The staged changes to `paths` since `sha`, without context lines: what the tamper guard scans.
 * Empty `paths` means "nothing touched" and returns '' (git would otherwise diff every file).
 * @param {import('../runner/sandbox.mjs').Sandbox} box
 * @param {string} sha
 * @param {string[]} paths  project-relative
 * @returns {Promise<string>}
 */
export async function changedSince(box, sha, paths) {
  checkSha(sha);
  const list = relPaths(paths);
  if (!list.length) return '';
  // --text: a repo's .gitattributes (`*.js -diff`, `*.html binary`) would otherwise turn the added
  // lines into "Binary files differ" and blind the scan. The tools only ever write UTF-8 text.
  return (await git(box, ['diff', '--cached', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', sha, '--', ...list])).stdout;
}

/**
 * The patch of `paths` since `sha` (binary-safe), as `git apply` reads it. The index must hold the
 * final state: the loop calls this after the last snapshot or revert. Empty `paths` returns ''.
 * @param {import('../runner/sandbox.mjs').Sandbox} box
 * @param {string} sha
 * @param {string[]} paths  project-relative
 * @returns {Promise<string>}
 */
export async function patchSince(box, sha, paths) {
  checkSha(sha);
  const list = relPaths(paths);
  if (!list.length) return '';
  return (await git(box, ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--src-prefix=a/', '--dst-prefix=b/', sha, '--', ...list])).stdout;
}

/**
 * Whether `patch` applies cleanly to commit `sha`: a throwaway worktree at /work/.verify and
 * `git apply --check` with the patch on stdin. An empty patch trivially applies. Throws only when
 * the worktree cannot be set up; a patch that does not apply returns false.
 * @param {import('../runner/sandbox.mjs').Sandbox} box
 * @param {string} patch
 * @param {string} sha  the cloned commit (GitHub) or the base snapshot (sample)
 * @returns {Promise<boolean>}
 */
export async function patchApplies(box, patch, sha) {
  checkSha(sha);
  if (!patch) return true;
  const wipe = async () => {
    await box.execArgs(['rm', '-rf', '--', VERIFY_DIR], { timeoutMs: 30_000 });
    await git(box, ['worktree', 'prune']);
  };
  await wipe();
  try {
    await git(box, ['worktree', 'add', '-q', '--detach', VERIFY_DIR, sha]);
    // Same options as GIT, run in the verify worktree instead of /work/app.
    const inVerify = ['git', '-C', VERIFY_DIR, ...GIT_ARGV.slice(3)];
    const r = await git(box, ['apply', '--check', '--whitespace=nowarn', '-'], { input: patch, okCodes: [0, 1, 128], argv: inVerify });
    return r.code === 0;
  } finally {
    await wipe().catch(() => {}); // best effort: the sandbox is destroyed at the end of the task anyway
  }
}

/**
 * The added and removed lines of a unified diff, in order. Hunk headers are counted, so a content
 * line such as `++i` (shown as `+++i`) is still a line; outside hunks only bare `+`/`-` lines count
 * (hand-written fixtures), never `+++ `/`--- ` file headers. Pure.
 * @param {string} diffText
 * @returns {{sign: '+'|'-', text: string}[]}
 */
export function diffLines(diffText) {
  const out = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of String(diffText ?? '').split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === '+') { newLeft--; out.push({ sign: '+', text: line.slice(1) }); continue; }
      if (c === '-') { oldLeft--; out.push({ sign: '-', text: line.slice(1) }); continue; }
      if (c === ' ') { oldLeft--; newLeft--; continue; }
      if (c === '\\') continue; // "\ No newline at end of file"
      oldLeft = 0; // not a hunk line: the hunk ended early (a hand-written diff)
      newLeft = 0;
    }
    const h = HUNK.exec(line);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      newLeft = h[2] === undefined ? 1 : Number(h[2]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line[0] === '+' || line[0] === '-') out.push({ sign: line[0], text: line.slice(1) });
  }
  return out;
}

/**
 * The measurement-tamper guard (§2.6): words in ADDED lines that only make sense if the edit is
 * aimed at the checker (data-mantis-ignore, headless-browser checks). Distinct matches, first
 * spelling kept; an empty list means no tamper. Pure.
 * @param {string} diffText
 * @returns {string[]}
 */
export function tamperHits(diffText) {
  const seen = new Map();
  for (const { sign, text } of diffLines(diffText)) {
    if (sign !== '+') continue;
    const joined = text.replace(JOINS, '');
    for (const line of joined === text ? [text] : [text, joined]) {
      for (const m of line.matchAll(TAMPER)) if (!seen.has(m[0].toLowerCase())) seen.set(m[0].toLowerCase(), m[0]);
    }
  }
  return [...seen.values()];
}
