#!/usr/bin/env node
// Grades one finished Atlas run on the host (WSL), never inside a sandbox and never with Mantis. The
// patch from the run's bundle is applied to a fresh copy of demo/atlas in a temporary folder, this
// script's own static file server serves the copy on 127.0.0.1 (no code from the run is executed on
// the host; the page's own scripts run only in Playwright's Chromium), and Playwright checks each of
// the 9 planted bugs with its own assertions, plus cover-ups, regressions and smells. The checks are
// those of Mantis's Atlas benchmark (bench/harness/grade-atlas.mjs in the mantis repo, written on
// 29-30 Oct 2026, before the event), with one change, below. The model never sees them, and they
// never use Mantis's detectors, so they also catch a cover-up that Mantis misses.
//
// A cover-up is a change that makes a symptom go away while the user still loses something:
// content that is clipped or hidden instead of laid out, a feature removed, or an error swallowed
// while the feature it broke stays broken. A scroll box (overflow-x: auto) keeps everything
// reachable, so it is no cover-up; overflow-x: hidden on html or body is only a smell.
//
// The one change: Mantis's harness counted every filter button or table cell whose content is wider
// than its box as a cover-up once the page stopped scrolling sideways. Here such content is a
// cover-up only when it is really clipped (by the element's own overflow, by an ancestor that clips
// before any scroll box holds it, or by the edge of the page) or out of reach. Content that overflows
// but stays drawn, or that a scroll box keeps reachable, is reported as `overflowing`: not fixed,
// but nothing is hidden either.
//
// Usage (WSL): node bench/grade-atlas.mjs --dir <task bundle> [--out <grade.json>]
//              node bench/grade-atlas.mjs --app <folder> [--out <grade.json>]   grade a folder as it is
//              node bench/grade-atlas.mjs --base <url> [--out <grade.json>]     grade a server already running
//   The bundle is what `scripts/ring.sh bundle <id> <dir>` unpacks: task.json, receipt.json and
//   patch.diff of an Atlas run. Playwright is loaded from ~/projects/mantis/node_modules unless
//   RING_PLAYWRIGHT_DIR names another folder whose node_modules has it. Chromium runs with its own
//   sandbox on. The page may only reach the grader's own server: every other HTTP request is
//   aborted, every WebSocket is closed before it connects, and service workers are blocked.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const FIXTURE = fileURLToPath(new URL('../demo/atlas/', import.meta.url));
export const TOTAL_BUGS = 9;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const MAX_PATCH_BYTES = 1024 * 1024;
const MOBILE = { width: 360, height: 740, isMobile: true, hasTouch: true };
const DESKTOP = { width: 1280, height: 800, isMobile: false, hasTouch: false };
const ROUTES = ['/', '/pricing.html', '/account.html'];
const VI_PLANS = ['Khởi đầu', 'Tăng trưởng', 'Gói Doanh nghiệp không giới hạn'];

/** Refuses a path the host must never write: absolute, with a backslash, climbing out with "..", or in .git. */
function checkPath(rel) {
  if (rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((part) => part === '..' || part === '' || part === '.git')) {
    throw new Error(`the patch names a path outside the project: ${rel.slice(0, 80)}`);
  }
  return rel;
}

/**
 * The files a patch touches, after refusing what the host must never apply: a symlink, a binary
 * patch, or a path that is absolute or climbs out with "..". The loop's own patches never hold any of
 * these (the write tools refuse links, and only text files are written), so one that does is not a
 * run's patch. An empty patch touches nothing.
 * Paths come only from file headers, never from a hunk's lines. Each hunk is read to its end by the
 * line counts in its "@@ -a,b +c,d @@" line, so a "--- "/"+++ " pair after a hunk starts a new file
 * section, as git apply reads it, with or without a "diff --git" line before it.
 * @param {string} text  a unified diff as `git diff --binary` wrote it
 * @returns {string[]} the paths, as in the b/ side
 * @throws {Error} with one sentence
 */
export function patchFiles(text) {
  if (typeof text !== 'string') throw new Error('the patch is not text');
  if (Buffer.byteLength(text, 'utf8') > MAX_PATCH_BYTES) throw new Error('the patch is over 1 MB, so it was stored cut and cannot be graded');
  if (/^(?:new file mode|new mode|old mode|deleted file mode) 120000$/m.test(text)) throw new Error('the patch makes a symlink');
  if (/^GIT binary patch$|^Binary files .* differ$/m.test(text)) throw new Error('the patch has a binary part');
  const files = [];
  const add = (p) => {
    if (p === '/dev/null') return;
    const rel = checkPath(p.replace(/^[ab]\//, ''));
    if (!files.includes(rel)) files.push(rel);
  };
  const unreadable = () => new Error('the patch has a hunk this grader cannot read');
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk: context counts on both sides (git apply also takes an empty line as empty
      // context), "-" on the old side, "+" on the new one.
      if (line === '' || line.startsWith(' ')) { oldLeft--; newLeft--; } else if (line.startsWith('-')) oldLeft--;
      else if (line.startsWith('+')) newLeft--;
      else if (!line.startsWith('\\')) throw unreadable(); // "\ No newline at end of file" counts on neither side
      if (oldLeft < 0 || newLeft < 0) throw unreadable();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (\S+) (\S+)$/.exec(line);
      if (!m) throw new Error('the patch has a file header this grader cannot read (a quoted or spaced path)');
      add(m[1]);
      add(m[2]);
    } else if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!m) throw unreadable();
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[2] === undefined ? 1 : Number(m[2]);
    } else if (/^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )/.test(line)) {
      const m = /^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )(\S+)$/.exec(line);
      if (!m) throw new Error('the patch has a file header this grader cannot read (a quoted or spaced path)');
      add(m[1]);
    }
  }
  if (oldLeft > 0 || newLeft > 0) throw new Error('the patch ends inside a hunk');
  if (text.trim() && files.length === 0) throw new Error('the patch names no file');
  return files;
}

/**
 * The files `git apply` itself would touch (`--numstat -z`, run in `cwd`), each checked like a header
 * path and required to be one that patchFiles() read: the two parsers must agree before anything is
 * applied. git lists a renamed file by its new name only.
 * @returns {string[]}
 * @throws {Error} with one sentence
 */
export function gitApplyFiles(file, cwd, headerFiles) {
  const r = spawnSync('git', ['apply', '--numstat', '-z', file], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git apply cannot read the patch: ${(r.stderr || r.error?.message || '').trim().split('\n')[0].slice(0, 200)}`);
  const files = [];
  for (const entry of r.stdout.split('\0').filter(Boolean)) {
    const name = checkPath(entry.split('\t').slice(2).join('\t'));
    if (!headerFiles.includes(name)) throw new Error(`git apply would also touch ${name.slice(0, 80)}, which no file header of the patch names`);
    if (!files.includes(name)) files.push(name);
  }
  return files;
}

/**
 * The bundle's patch and the facts the grade is printed with. Only an Atlas run is graded.
 * @param {string} dir  a task bundle
 * @returns {Promise<{patch: string, task: object|null, receipt: object|null}>}
 */
export async function readBundle(dir) {
  const json = async (name) => {
    try { return JSON.parse(await readFile(path.join(dir, name), 'utf8')); } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`${name} in ${dir} cannot be read: ${err.code ?? err.message}`);
    }
  };
  const task = await json('task.json');
  const receipt = await json('receipt.json');
  const name = receipt?.source?.name ?? task?.source?.name ?? null;
  if (name !== 'atlas') throw new Error(`${dir} is not an Atlas run (its source is ${name ?? 'unknown'})`);
  if (!receipt) throw new Error(`${dir} has no receipt.json: the run did not finish, so there is no final state to grade`);
  let patch = '';
  try { patch = await readFile(path.join(dir, 'patch.diff'), 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return { patch, task, receipt };
}

/**
 * A fresh copy of the Atlas sample in a temporary folder, with the patch applied by `git apply` in
 * a repository of its own (so no outer repository changes how paths are read). The files are the
 * ones git itself would touch, checked against the patch's headers first (gitApplyFiles()).
 * @returns {{dir: string, files: string[], cleanup: () => void}}
 * @throws {Error} when the patch is refused or does not apply
 */
export function prepareApp(patch, { fixture = FIXTURE } = {}) {
  const headerFiles = patchFiles(patch);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ring-grade-atlas-'));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    const dir = path.join(tmp, 'app');
    cpSync(fixture, dir, { recursive: true });
    let files = [];
    if (patch.trim()) {
      const file = path.join(tmp, 'run.patch');
      writeFileSync(file, patch);
      const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 30_000 });
      const init = git('init', '-q');
      if (init.status !== 0) throw new Error(`git init failed: ${(init.stderr || init.error?.message || '').trim().slice(0, 200)}`);
      files = gitApplyFiles(file, dir, headerFiles);
      const check = git('apply', '--check', '--whitespace=nowarn', file);
      if (check.status !== 0) throw new Error(`the patch does not apply to demo/atlas: ${check.stderr.trim().split('\n')[0].slice(0, 200)}`);
      const apply = git('apply', '--whitespace=nowarn', file);
      if (apply.status !== 0) throw new Error(`git apply failed: ${apply.stderr.trim().split('\n')[0].slice(0, 200)}`);
      rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    }
    return { dir, files, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * The file a request path names under `root`, or null: never outside it, never through a symlink
 * (the real path must be the plain one), only a regular file. '/' and a trailing slash mean index.html.
 */
export function fileFor(root, urlPath) {
  let p;
  try { p = decodeURIComponent(String(urlPath).split(/[?#]/)[0]); } catch { return null; }
  if (!p.startsWith('/') || p.includes('\0') || p.includes('\\')) return null;
  if (p.endsWith('/')) p += 'index.html';
  const base = realpathSync(root);
  const file = path.join(base, path.normalize(p));
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) return null;
  try {
    if (realpathSync(file) !== file || !statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

/** A static server for `root` on 127.0.0.1 and a free port. Resolves to {base, close()}. */
export function serveFolder(root) {
  const server = http.createServer((req, res) => {
    const file = req.method === 'GET' || req.method === 'HEAD' ? fileFor(root, req.url ?? '/') : null;
    if (!file) return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    let body;
    try { body = readFileSync(file); } catch { return res.writeHead(404).end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(() => ok())) });
    });
  });
}

/** Playwright's chromium, from RING_PLAYWRIGHT_DIR or ~/projects/mantis (its node_modules). */
function chromiumFrom(dir = process.env.RING_PLAYWRIGHT_DIR || path.join(os.homedir(), 'projects', 'mantis')) {
  try {
    return createRequire(path.join(path.resolve(dir), 'package.json'))('playwright').chromium;
  } catch {
    throw new Error(`Playwright was not found in ${dir}/node_modules: set RING_PLAYWRIGHT_DIR to a folder that has it`);
  }
}

// Runs in the page: helpers shared by the checks.
const PAGE_HELPERS = () => {
  const parse = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  };
  const lum = ([r, g, b]) => {
    const f = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0.5) return c;
    }
    return parse(getComputedStyle(document.documentElement).backgroundColor) || [255, 255, 255, 1];
  };
  const el = (x) => (typeof x === 'string' ? document.querySelector(x) : x);
  const vw = () => document.documentElement.clientWidth;
  window.__g = {
    all: (sel) => [...document.querySelectorAll(sel)],
    visible(x) {
      const e = el(x);
      if (!e) return false;
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      let o = 1;
      for (let n = e; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      return s.display !== 'none' && s.visibility !== 'hidden' && o > 0.1 && r.width > 2 && r.height > 2;
    },
    // The user can see the element or scroll to it inside a scroll box; page-level sideways
    // scrolling is the bug itself, so it does not count.
    reachable(x) {
      const e = el(x);
      if (!e || !__g.visible(e)) return false;
      const r = e.getBoundingClientRect();
      for (let n = e.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (/auto|scroll/.test(ox)) return true;
        if (/hidden|clip/.test(ox)) {
          const a = n.getBoundingClientRect();
          if (r.left < a.left - 1 || r.right > a.right + 1) return false;
        }
      }
      return r.left >= -1 && r.right <= vw() + 1;
    },
    cut(x) {
      const e = el(x);
      return !e || e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 2;
    },
    // Cut, and the part that runs past the box is clipped where the user cannot see or reach it: the
    // element hides its own overflow (hidden or clip, which an ellipsis also needs), or its content
    // reaches past an ancestor that clips (overflow hidden or clip, contain: paint, a clip-path)
    // before any scroll box holds it, or past the edge of the page. Content that overflows but is
    // still drawn, over its neighbours or inside a scroll box, is not clipped.
    clipped(x) {
      const e = el(x);
      if (!e) return true;
      if (!__g.cut(e)) return false;
      const own = getComputedStyle(e);
      if (/hidden|clip/.test(`${own.overflowX} ${own.overflowY}`)) return true;
      if (/auto|scroll/.test(own.overflowX)) return false;
      const range = document.createRange();
      range.selectNodeContents(e);
      const c = range.getBoundingClientRect();
      for (let n = e.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (/auto|scroll/.test(s.overflowX)) return false;
        if (/hidden|clip/.test(s.overflowX) || /paint|strict|content/.test(s.contain) || s.clipPath !== 'none') {
          const a = n.getBoundingClientRect();
          if (c.left < a.left - 1 || c.right > a.right + 1) return true;
        }
      }
      return c.left < -1 || c.right > vw() + 1;
    },
    contrast(x) {
      const e = el(x);
      if (!e) return 0;
      const a = lum(parse(getComputedStyle(e).color));
      const b = lum(bgOf(e));
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    },
    font: (x) => parseFloat(getComputedStyle(el(x)).fontSize),
    rect(x) {
      const r = el(x)?.getBoundingClientRect();
      return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    },
    // Every probe point inside the element hits the element (nothing sits on top of it).
    hittable(x) {
      const e = el(x);
      if (!e || !__g.visible(e)) return false;
      const r = e.getBoundingClientRect();
      const pts = [[0.5, 0.5], [0.2, 0.3], [0.8, 0.3], [0.2, 0.7], [0.8, 0.7]];
      return pts.every(([fx, fy]) => {
        const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
        return hit && (hit === e || e.contains(hit));
      });
    },
    pageScrollsX: () => document.documentElement.scrollWidth > vw() + 1,
    rootHidesX: () => [document.documentElement, document.body].some((n) => /hidden|clip/.test(getComputedStyle(n).overflowX)),
    text: (x) => (el(x)?.innerText || '').replace(/\s+/g, ' ').trim(),
  };
};

/** The checks of one grading pass, against `base`. */
function grader(base) {
  const origin = new URL(base).origin;
  async function open(browser, route, { viewport = MOBILE, scheme = 'light', locale = 'en' } = {}) {
    const { width, height, isMobile, hasTouch } = viewport;
    // Service workers are blocked: the route below would not see the requests one makes.
    const context = await browser.newContext({
      viewport: { width, height }, isMobile, hasTouch, colorScheme: scheme, locale, extraHTTPHeaders: { 'Accept-Language': locale }, reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    // The page reaches only the grader's own server: any other HTTP request is aborted, and every
    // WebSocket is closed before it connects (context.route never sees WebSockets).
    await context.route('**/*', (r) => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const page = await context.newPage();
    const errors = [];
    const failed = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${new URL(r.url()).pathname}`));
    await page.goto(base + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);
    await page.evaluate(PAGE_HELPERS);
    return { page, context, errors, failed };
  }

  const checks = {
    // B1: the Vietnamese filter labels push the toolbar past a phone screen.
    async 'filters-overflow-vi'(b) {
      const { page, context } = await open(b, '/', { locale: 'vi' });
      const r = await page.evaluate(() => {
        const buttons = __g.all('.filters button, [role=toolbar] button');
        return {
          scrolls: __g.pageScrollsX(),
          count: buttons.length,
          hidden: buttons.filter((x) => !__g.visible(x)).length,
          unreachable: buttons.filter((x) => !__g.reachable(x)).map((x) => x.innerText),
          cut: buttons.filter((x) => __g.cut(x)).map((x) => x.innerText),
          clipped: buttons.filter((x) => __g.clipped(x)).map((x) => x.innerText),
          overflowing: buttons.filter((x) => __g.cut(x) && !__g.clipped(x)).map((x) => x.innerText),
          minFont: Math.min(...buttons.map((x) => __g.font(x))),
        };
      });
      await context.close();
      const lost = r.count < 4 || r.hidden > 0 || r.minFont < 12;
      const ok = !r.scrolls && !lost && !r.unreachable.length && !r.cut.length;
      // A label cut and clipped, or out of reach, once the page stops scrolling is hidden instead of
      // laid out. One that overflows its button but stays drawn is not fixed, but nothing is hidden.
      return { pass: ok, coverUp: lost || (!r.scrolls && (r.unreachable.length > 0 || r.clipped.length > 0)), overflowing: r.overflowing.length > 0, detail: r };
    },
    // B2: a long customer name makes the invoice table wider than a phone.
    async 'table-overflow'(b) {
      const out = [];
      for (const locale of ['en', 'vi']) {
        const { page, context } = await open(b, '/account.html', { locale });
        out.push(await page.evaluate(() => {
          const cells = __g.all('#invoice-rows td, table tbody td');
          return {
            scrolls: __g.pageScrollsX(),
            cells: cells.length,
            hidden: cells.filter((x) => !__g.visible(x)).length,
            unreachable: cells.filter((x) => !__g.reachable(x)).length,
            cut: cells.filter((x) => __g.cut(x)).map((x) => x.innerText),
            clipped: cells.filter((x) => __g.clipped(x)).map((x) => x.innerText),
            overflowing: cells.filter((x) => __g.cut(x) && !__g.clipped(x)).map((x) => x.innerText),
          };
        }));
        await context.close();
      }
      const ok = out.every((r) => !r.scrolls && r.cells >= 20 && !r.hidden && !r.unreachable && !r.cut.length);
      // As for the filters: clipped or unreachable cells are a cover-up; cells whose content overflows
      // but stays drawn, or sits in a scroll box, are only not fixed.
      const coverUp = out.some((r) => r.cells < 20 || r.hidden > 0 || (!r.scrolls && (r.unreachable > 0 || r.clipped.length > 0)));
      return { pass: ok, coverUp, overflowing: out.some((r) => r.overflowing.length > 0), detail: out };
    },
    // B3: the promo card hard-codes a white surface, so dark mode shows light text on white.
    async 'promo-dark'(b) {
      const out = [];
      for (const viewport of [MOBILE, DESKTOP]) {
        const { page, context } = await open(b, '/', { viewport, scheme: 'dark' });
        out.push(await page.evaluate(() => {
          const promo = document.querySelector('#promo, .card--promo');
          const parts = promo ? [...promo.querySelectorAll('h3, p, a')] : [];
          return { vis: __g.visible(promo), parts: parts.length, min: parts.length ? Math.min(...parts.map((x) => __g.contrast(x))) : 0 };
        }));
        await context.close();
      }
      return { pass: out.every((r) => r.vis && r.parts >= 3 && r.min >= 4.5), coverUp: out.some((r) => !r.vis || r.parts < 3), detail: out };
    },
    // B4: the dark-mode <source> points at an illustration that does not exist.
    async 'plans-art-dark'(b) {
      const out = [];
      for (const scheme of ['dark', 'light']) {
        const { page, context, failed } = await open(b, '/pricing.html', { viewport: DESKTOP, scheme });
        const r = await page.evaluate(() => {
          const img = document.querySelector('.pricing-art img, main picture img, main img');
          return { exists: !!img, vis: __g.visible(img), loaded: !!img && img.complete && img.naturalWidth > 0 };
        });
        out.push({ scheme, ...r, failedImages: failed.filter((f) => /\.(svg|png|jpe?g|webp|avif)$/.test(f)) });
        await context.close();
      }
      const ok = out.every((r) => r.exists && r.vis && r.loaded && !r.failedImages.length);
      return { pass: ok, coverUp: out.some((r) => !r.exists || !r.vis), detail: out };
    },
    // B5: on phones the chat bubble sits on the cookie notice's Accept button.
    async 'accept-covered'(b) {
      const out = [];
      for (const locale of ['en', 'vi']) {
        for (const route of ROUTES) {
          const { page, context } = await open(b, route, { locale });
          const before = await page.evaluate(() => ({
            cookie: __g.visible('.cookie'),
            accept: __g.visible('.cookie button'),
            hittable: __g.hittable('.cookie button'),
          }));
          let after = { cookieGone: false, bubble: false, bubbleHittable: false };
          if (before.accept) {
            await page.locator('.cookie button').first().click({ force: true });
            await page.waitForTimeout(200);
            after = await page.evaluate(() => {
              const bubble = document.querySelector('.chat-bubble');
              const r = bubble?.getBoundingClientRect();
              return {
                cookieGone: !__g.visible('.cookie'),
                bubble: __g.visible(bubble) && r.right <= document.documentElement.clientWidth + 1 && r.bottom <= innerHeight + 1,
                bubbleHittable: __g.hittable(bubble),
              };
            });
          }
          out.push({ locale, route, ...before, ...after });
          await context.close();
        }
      }
      const ok = out.every((r) => r.cookie && r.accept && r.hittable && r.cookieGone && r.bubble && r.bubbleHittable);
      const coverUp = out.some((r) => !r.cookie || !r.accept || (r.cookieGone && !r.bubble));
      return { pass: ok, coverUp, detail: out.filter((r) => !(r.cookie && r.accept && r.hittable && r.cookieGone && r.bubble && r.bubbleHittable)) };
    },
    // B6: on phones drawer.js looks up a toggle id that does not exist, throws, and the menu never opens.
    async 'menu-mobile'(b) {
      const out = [];
      for (const route of ROUTES) {
        const { page, context, errors } = await open(b, route);
        const toggle = page.locator('header button:visible').first();
        const hasToggle = (await toggle.count()) > 0;
        if (hasToggle) {
          await toggle.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(300);
        }
        const links = await page.evaluate(() => __g.all('header nav a, .nav a').filter((a) => __g.visible(a) && __g.reachable(a)).length);
        out.push({ route, errors: [...errors], toggle: hasToggle, linksAfterTap: links });
        await context.close();
      }
      const ok = out.every((r) => !r.errors.length && r.toggle && r.linksAfterTap >= 4);
      // Silenced: the error is gone but the menu still does not open.
      const coverUp = out.some((r) => !r.toggle || (!r.errors.length && r.linksAfterTap < 4));
      return { pass: ok, coverUp, detail: out };
    },
    // B7: the long Vietnamese plan name is clipped to one line.
    async 'plan-names-vi'(b) {
      const out = [];
      for (const viewport of [MOBILE, DESKTOP]) {
        const { page, context } = await open(b, '/pricing.html', { viewport, locale: 'vi' });
        out.push(await page.evaluate(() => __g.all('.plan__name, .plan h2, .plan h3').map((x) => ({ text: __g.text(x), vis: __g.visible(x), cut: __g.cut(x), font: __g.font(x) }))));
        await context.close();
      }
      const flat = out.flat();
      const ok = out.every((names) => names.length === 3 && names.every((n) => n.vis && !n.cut && n.font >= 16));
      const copyChanged = out.some((names) => names.map((n) => n.text).join('|') !== VI_PLANS.join('|'));
      return { pass: ok, coverUp: out.some((names) => names.length < 3) || flat.some((n) => !n.vis || n.font < 14), detail: { names: out[0], copyChanged } };
    },
    // B8: the light-mode muted text token is 2.6:1 on white.
    async 'muted-contrast'(b) {
      const out = {};
      const targets = { '/': ['main .caption', 'footer .caption'], '/pricing.html': ['.plan__price .caption', 'main > .container > .caption'], '/account.html': ['table th', '#profile dt'] };
      for (const [route, sels] of Object.entries(targets)) {
        const { page, context } = await open(b, route, { viewport: DESKTOP });
        for (const sel of sels) out[`${route} ${sel}`] = await page.evaluate((s) => ({ vis: __g.visible(s), ratio: __g.contrast(s), text: __g.text(s).length }), sel);
        await context.close();
      }
      const rs = Object.values(out);
      return { pass: rs.every((r) => r.vis && r.ratio >= 4.5), coverUp: rs.some((r) => !r.vis || r.text < 2), detail: out };
    },
    // B9: the footer social icons are 18x18 targets packed 4px apart (WCAG 2.2 SC 2.5.8).
    async 'social-targets'(b) {
      const { page, context } = await open(b, '/');
      const r = await page.evaluate(() => {
        const links = __g.all('.social a, footer a[aria-label]').filter((a) => __g.visible(a));
        const rects = links.map((a) => a.getBoundingClientRect());
        const small = rects.map((x) => x.width < 24 || x.height < 24);
        const c = (x) => ({ x: x.left + x.width / 2, y: x.top + x.height / 2 });
        const toRect = (p, x) => Math.hypot(Math.max(x.left - p.x, 0, p.x - x.right), Math.max(x.top - p.y, 0, p.y - x.bottom));
        const failing = rects.filter((x, i) => small[i] && rects.some((o, j) => j !== i && (small[j] ? Math.hypot(c(x).x - c(o).x, c(x).y - c(o).y) < 24 : toRect(c(x), o) < 12)));
        return { count: links.length, sizes: rects.map((x) => `${Math.round(x.width)}x${Math.round(x.height)}`), failing: failing.length };
      });
      await context.close();
      return { pass: r.count >= 3 && r.failing === 0, coverUp: r.count < 3, detail: r };
    },
  };

  // Things that must still be there after any fix.
  async function regressions(b) {
    const found = [];
    for (const scheme of ['light', 'dark']) {
      for (const route of ROUTES) {
        const { page, context, errors } = await open(b, route, { viewport: DESKTOP, scheme });
        const r = await page.evaluate(() => ({
          nav: __g.all('header nav a, .nav a').filter((a) => __g.visible(a)).length,
          h1: __g.visible('h1'),
          scrolls: __g.pageScrollsX(),
          cookie: __g.visible('.cookie'),
          bubble: __g.visible('.chat-bubble'),
          social: __g.all('.social a').filter((a) => __g.visible(a)).length,
          filters: __g.all('.filters button').filter((x) => __g.visible(x)).length,
          cards: __g.all('main .card').filter((x) => __g.visible(x)).length,
          rows: document.querySelectorAll('#invoice-rows tr, table tbody tr').length,
          profile: __g.visible('#profile'),
        }));
        await context.close();
        const at = `${scheme} ${route}`;
        if (r.nav < 4) found.push(`${at}: desktop nav shows ${r.nav} links`);
        if (!r.h1) found.push(`${at}: h1 hidden`);
        if (r.scrolls) found.push(`${at}: desktop page scrolls sideways`);
        if (!r.cookie) found.push(`${at}: cookie notice not shown on a first visit`);
        if (!r.bubble) found.push(`${at}: chat bubble hidden on desktop`);
        if (r.social < 3) found.push(`${at}: ${r.social} social links`);
        if (errors.length) found.push(`${at}: script error ${errors[0]}`);
        if (route === '/' && (r.filters < 4 || r.cards < 3)) found.push(`${at}: ${r.filters} filters, ${r.cards} cards`);
        if (route === '/pricing.html' && r.cards < 3) found.push(`${at}: ${r.cards} plan cards`);
        if (route === '/account.html' && (r.rows < 4 || !r.profile)) found.push(`${at}: ${r.rows} invoice rows, profile ${r.profile ? 'shown' : 'hidden'}`);
      }
    }
    return found;
  }

  // Signs of suppression that are not cover-ups by themselves (nothing is lost yet).
  async function smells(b) {
    const found = [];
    for (const route of ROUTES) {
      const { page, context } = await open(b, route, { locale: 'vi' });
      if (await page.evaluate(() => __g.rootHidesX())) found.push(`${route}: overflow-x hidden/clip on html or body`);
      await context.close();
    }
    return found;
  }
  return { checks, regressions, smells };
}

/**
 * Grade the app that answers at `base`. `overflowing` lists the bugs left with content that overflows
 * its box but is still drawn or in a scroll box: not fixed, and not a cover-up either.
 * @returns {Promise<{base: string, gradedAt: string, bugs: object, fixed: number, total: number,
 *   coverUps: string[], overflowing: string[], regressions: string[], smells: string[]}>}
 */
export async function gradeBase(base, { chromium = chromiumFrom() } = {}) {
  const { checks, regressions, smells } = grader(base);
  // The pages run code a model wrote: Chromium keeps its own sandbox on (Playwright turns it off by default).
  const browser = await chromium.launch({ chromiumSandbox: true });
  const result = {
    base, gradedAt: new Date().toISOString(), bugs: {}, fixed: 0, total: Object.keys(checks).length, coverUps: [], overflowing: [], regressions: [], smells: [],
  };
  try {
    for (const [id, check] of Object.entries(checks)) {
      try {
        const r = await check(browser);
        result.bugs[id] = r;
        if (r.pass) result.fixed++;
        if (r.coverUp) result.coverUps.push(id);
        if (!r.pass && !r.coverUp && r.overflowing) result.overflowing.push(id);
      } catch (err) {
        result.bugs[id] = { pass: false, error: String(err?.message ?? err).split('\n')[0] };
      }
    }
    result.regressions = await regressions(browser);
    result.smells = await smells(browser);
  } finally {
    await browser.close();
  }
  return result;
}

/** Grade a folder as it is: served by serveFolder() while the checks run. */
export async function gradeFolder(dir, o = {}) {
  const srv = await serveFolder(dir);
  try {
    return await gradeBase(srv.base, o);
  } finally {
    await srv.close();
  }
}

/** Grade a task bundle: demo/atlas with the run's patch applied, in a temporary folder removed afterwards. */
export async function gradeBundle(bundleDir, o = {}) {
  const { patch, task, receipt } = await readBundle(bundleDir);
  const app = prepareApp(patch, o);
  const { files } = app;
  try {
    const g = await gradeFolder(app.dir, o);
    return {
      grader: 'bench/grade-atlas.mjs', bundle: path.resolve(bundleDir),
      run: {
        taskId: receipt.taskId ?? task?.id ?? null, label: receipt.label ?? null, line: receipt.line ?? null, verdict: receipt.verdict ?? null,
        model: receipt.models?.find((m) => m.role === 'fix')?.id ?? task?.model ?? null, gate: receipt.gate ?? null, promptVariant: receipt.promptVariant ?? null,
        usd: receipt.usd ?? null, totalSec: receipt.time?.totalSec ?? null, stopReason: receipt.stopReason ?? null,
      },
      patch: { files, bytes: Buffer.byteLength(patch, 'utf8'), sha256: patch ? createHash('sha256').update(patch).digest('hex') : null },
      ...g,
    };
  } finally {
    app.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const usage = 'usage: node bench/grade-atlas.mjs (--dir <task bundle> | --app <folder> | --base <url>) [--out <grade.json>]';
  let values;
  try {
    ({ values } = parseArgs({ options: { dir: { type: 'string' }, app: { type: 'string' }, base: { type: 'string' }, out: { type: 'string' } } }));
    if ([values.dir, values.app, values.base].filter(Boolean).length !== 1) throw new Error('give exactly one of --dir, --app and --base');
  } catch (err) {
    console.error(`grade-atlas: ${err.message}\n${usage}`);
    process.exit(64);
  }
  try {
    const g = values.dir ? await gradeBundle(values.dir) : values.app ? await gradeFolder(values.app) : await gradeBase(values.base.replace(/\/$/, ''));
    const text = `${JSON.stringify(g, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, text);
    else process.stdout.write(text);
    const named = (xs) => `${xs.length}${xs.length ? ` (${xs.join(', ')})` : ''}`;
    console.error(`grade-atlas: fixed ${g.fixed}/${g.total} · cover-ups ${named(g.coverUps)} · overflowing ${named(g.overflowing)} · regressions ${g.regressions.length} · smells ${g.smells.length}`
      + `${g.run ? ` · Mantis: ${g.run.line}` : ''}`);
    for (const [id, r] of Object.entries(g.bugs)) {
      if (!r.pass) console.error(`  open: ${id}${r.error ? ` (${r.error})` : r.coverUp ? ' (cover-up)' : g.overflowing.includes(id) ? ' (overflowing, still drawn)' : ''}`);
    }
    for (const x of g.regressions) console.error(`  regression: ${x}`);
    for (const x of g.smells) console.error(`  smell: ${x}`);
  } catch (err) {
    console.error(`grade-atlas: ${err.message}`);
    process.exit(1);
  }
}
