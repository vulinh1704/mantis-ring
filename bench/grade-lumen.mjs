#!/usr/bin/env node
// Grades one finished Lumen run against Mantis's answer key, PLANTED.json: the 13 bugs planted in the
// buggy-app fixture that demo/lumen was built from. It runs on the host only; the key never enters a
// sandbox and the model never sees it. Mantis's own counts say what changed; this says whether the
// planted bugs, the ones a human knows are real, were fixed.
//
// A planted bug is present in a report when an issue has one of its expected types on its route
// (PLANTED's /settings is served as /settings.html) and either the expected selector, a selector
// inside it (expectations marked `descendants`), or, without a selector, a message the expected
// regex matches. It is really fixed when it is present in R0, absent in the final run (RF), RF
// measured every screen where R0 showed it (status 'ok'), and no RF cover-up issue was about it
// (evidence.was.selector). Without an RF the final state is R0.
//
// Usage: node bench/grade-lumen.mjs --dir <task bundle> [--key <PLANTED.json>] [--out <grade.json>]
//   The bundle is what `scripts/ring.sh bundle <id> <dir>` extracts: r0.report.json, rf.report.json,
//   receipt.json, … Prints {bugs:[{id, before, after, fixed, coverUp}], fixed, total, …} as JSON.
//   The key is fixtures/buggy-app/PLANTED.json in the mantis repository, next to this one (../mantis,
//   as in scripts/make-demo-lumen.sh), unless --key names another file.
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_KEY = fileURLToPath(new URL('../../mantis/fixtures/buggy-app/PLANTED.json', import.meta.url));
/** PLANTED.json routes that the static server serves under another path. */
const ROUTE_MAP = { '/settings': '/settings.html' };

/** The route a planted bug has in Ring's reports. */
export function mapRoute(route) {
  return ROUTE_MAP[route] ?? route;
}

/** Read a JSON file; a missing file gives null when `optional`, anything else throws a plain sentence. */
async function readJson(file, { optional = false } = {}) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (optional && err.code === 'ENOENT') return null;
    throw new Error(`cannot read ${file}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

/** Load and check the answer key: {bugs: [{id, route, expect: [{type, selector?, descendants?, message?}]}]}. */
export async function loadKey(file = DEFAULT_KEY) {
  let key;
  try {
    key = await readJson(file);
  } catch (err) {
    if (path.resolve(file) !== DEFAULT_KEY) throw err;
    throw new Error(`${err.message}. The default answer key is Mantis's fixtures/buggy-app/PLANTED.json, looked for in the mantis repository next to this one (../mantis); pass --key <PLANTED.json> for another`);
  }
  const ok = Array.isArray(key?.bugs) && key.bugs.length > 0 && key.bugs.every((b) => typeof b?.id === 'string' && typeof b.route === 'string'
    && Array.isArray(b.expect) && b.expect.length > 0 && b.expect.every((e) => typeof e?.type === 'string' && (typeof e.selector === 'string' || typeof e.message === 'string')));
  if (!ok) throw new Error(`${file} is not a PLANTED.json answer key (bugs with id, route and expect[type + selector or message])`);
  return key;
}

function checkReport(report, name) {
  if (!report || !Array.isArray(report.issues)) throw new Error(`${name} is not a Mantis report (no issues list)`);
  return report;
}

/** Does `sel` name the expected element, or (with `descendants`) an element inside it? */
function selectorMatches(sel, exp) {
  return typeof sel === 'string' && (sel === exp.selector || (exp.descendants === true && sel.startsWith(`${exp.selector} `)));
}

/** Does one report issue match one expectation of a planted bug on `route`? */
export function issueMatches(issue, exp, route) {
  if (issue?.type !== exp.type || issue.route !== route) return false;
  if (typeof exp.selector === 'string') return selectorMatches(issue.selector, exp);
  const re = new RegExp(exp.message);
  return [issue.message, ...(issue.occurrences ?? []).map((o) => o?.message)].some((m) => typeof m === 'string' && re.test(m));
}

/** Is the planted bug visible in the report (any of its expectations matched by any issue)? */
export function isPresent(report, bug) {
  const route = mapRoute(bug.route);
  return report.issues.some((issue) => bug.expect.some((exp) => issueMatches(issue, exp, route)));
}

/** Did the report flag a cover-up of this bug: a cover-up issue whose evidence.was.selector is one of its elements? */
export function isCoveredUp(report, bug) {
  const route = mapRoute(bug.route);
  const was = report.issues
    .filter((i) => i?.type === 'cover-up' && i.route === route)
    .flatMap((i) => [i.evidence?.was?.selector, ...(i.occurrences ?? []).map((o) => o?.evidence?.was?.selector)]);
  return bug.expect.some((exp) => typeof exp.selector === 'string' && was.some((sel) => selectorMatches(sel, exp)));
}

/** The screens (`<route>|<viewport>/<scheme>/<locale>`) where R0 showed the bug: the cells of every issue that matched it. */
export function cellsOf(report, bug) {
  const route = mapRoute(bug.route);
  const hits = report.issues.filter((issue) => bug.expect.some((exp) => issueMatches(issue, exp, route)));
  return [...new Set(hits.flatMap((i) => (Array.isArray(i.cells) ? i.cells : []).map((c) => `${route}|${c}`)))];
}

/** The screens Mantis really measured in a report (status 'ok'); null when the report lists no cells. */
function measuredCells(report) {
  if (!Array.isArray(report?.cells)) return null;
  return new Set(report.cells.filter((c) => c?.status === 'ok').map((c) => `${c.route}|${c.key}`));
}

/**
 * Grade one run. `rf` null means there was no final run, so the final state is the starting point.
 * A bug only counts as fixed when RF measured every screen where R0 showed it: a page that stopped
 * loading (HTTP 404/500, a hang, a crash) leaves its bugs out of RF without fixing them.
 * @returns {{bugs: {id:string, before:boolean, after:boolean, fixed:boolean, coverUp:boolean, unmeasured:boolean}[],
 *   fixed:number, total:number, presentInR0:number, unmeasured:number}}
 */
export function grade({ r0, rf, key }) {
  checkReport(r0, 'r0.report.json');
  if (rf) checkReport(rf, 'rf.report.json');
  const final = rf ?? r0;
  const measured = rf ? measuredCells(rf) : null;
  const bugs = key.bugs.map((bug) => {
    const before = isPresent(r0, bug);
    const after = isPresent(final, bug);
    const coverUp = rf ? isCoveredUp(rf, bug) : false;
    const unmeasured = Boolean(rf && before && measured && cellsOf(r0, bug).some((k) => !measured.has(k)));
    return { id: bug.id, before, after, fixed: before && !after && !coverUp && !unmeasured, coverUp, unmeasured };
  });
  return {
    bugs, fixed: bugs.filter((b) => b.fixed).length, total: key.bugs.length, presentInR0: bugs.filter((b) => b.before).length,
    unmeasured: bugs.filter((b) => b.unmeasured).length,
  };
}

/**
 * Grade a task bundle folder: r0.report.json (required), rf.report.json (absent when the run kept no
 * measured change) and receipt.json (for the run ids and the status note).
 */
export async function gradeDir(dir, keyFile = DEFAULT_KEY) {
  const key = await loadKey(keyFile);
  const r0 = await readJson(path.join(dir, 'r0.report.json'), { optional: true });
  if (!r0) throw new Error(`no r0.report.json in ${dir}: the run never measured its starting point, so there is nothing to grade`);
  const rf = await readJson(path.join(dir, 'rf.report.json'), { optional: true });
  const receipt = await readJson(path.join(dir, 'receipt.json'), { optional: true });
  const result = grade({ r0, rf, key });
  const note = rf ? null
    : receipt ? 'no final run (no measured change was kept): graded the starting point against itself'
      : 'no receipt and no final run (the task did not finish): graded the starting point against itself';
  return { dir: path.resolve(dir), key: path.resolve(keyFile), r0RunId: r0.runId ?? null, rfRunId: rf?.runId ?? null, ...result, ...(note ? { note } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let values;
  try {
    ({ values } = parseArgs({ options: { dir: { type: 'string' }, key: { type: 'string' }, out: { type: 'string' } } }));
    if (!values.dir) throw new Error('--dir is required');
  } catch (err) {
    console.error(`grade-lumen: ${err.message}\nusage: node bench/grade-lumen.mjs --dir <task bundle> [--key <PLANTED.json>] [--out <grade.json>]`);
    process.exit(64);
  }
  try {
    const g = await gradeDir(values.dir, values.key ?? DEFAULT_KEY);
    const text = `${JSON.stringify(g, null, 2)}\n`;
    if (values.out) {
      await writeFile(`${values.out}.tmp`, text);
      await rename(`${values.out}.tmp`, values.out);
    }
    process.stdout.write(text);
    console.error(`grade-lumen: ${g.fixed}/${g.total} planted bugs really fixed (${g.presentInR0} present at the start${g.unmeasured ? `, ${g.unmeasured} on screens the final run could not measure` : ''})${g.note ? `; ${g.note}` : ''}`);
  } catch (err) {
    console.error(`grade-lumen: ${err.message}`);
    process.exit(1);
  }
}
