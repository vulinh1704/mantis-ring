// The optional vision check (spec §2.9, Appendix B): a second opinion on a finished fix from a vision
// model on Vultr Serverless Inference. For up to four issues that Mantis measured as fixed (or as
// covered up), the model sees a BEFORE and an AFTER crop of the same area of the page, the issue text
// and the diff, and says whether the issue was really fixed. It is never told what Mantis decided, so
// its agreement with Mantis is an independent number. Its answer is shown next to the receipt and never
// changes the counts, the gate or the publish bar: Mantis's measurement decides. It runs after the
// sandbox is gone, works only on bytes the loop copied out, and never throws.
import { cropBox, cropImage, decodePng, encodePng } from './png.mjs';

const PROVIDER = 'Vultr Serverless Inference'; // same wording as PROVIDER in inference.mjs
const SHOT_PATH = /^shots\/[A-Za-z0-9_.-]+\.png$/; // the only screenshot paths the loop may copy out (§2.7)
const TYPE_ORDER = ['page-overflow', 'overlap', 'clipped-text', 'theme-leak', 'contrast', 'broken-image', 'tap-target'];
const VERDICTS = ['fixed', 'cover_up', 'regressed', 'unclear'];
const PARALLEL = 2; // requests in flight at once
const MAX_DIFF = 4000; // characters of the patch in the prompt
const MAX_EVIDENCE = 300; // characters of the model's evidence kept for display

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Rect
 * @typedef {{i: number, issueId: number, type: string, selector: string|null, route: string, cell: string,
 *   viewport: string, width: number|null, height: number|null, scheme: string, locale: string, message: string,
 *   mantis: 'fixed'|'cover-up', beforeShot: string, afterShot: string, beforeRect: Rect, afterRect: Rect,
 *   before?: Buffer, after?: Buffer}} Pair
 *   `i` counts from 1 and names the files: shot-before-<i>.png, shot-after-<i>.png, crop-before-<i>.png,
 *   crop-after-<i>.png. `beforeShot`/`afterShot` are the cells' `screenshot` paths, relative to the R0 and
 *   RF run dirs. The loop copies those two files out and sets `before`/`after` to their bytes.
 * @typedef {{issue: string, mantis: 'fixed'|'cover-up', vision: 'fixed'|'cover_up'|'regressed'|'unclear',
 *   evidence: string, targetVisibleAfter: boolean|null, newProblems: string[]}} VisionPair
 * @typedef {{model: string|null, provider: string, verdict: 'pass'|'fail'|'unclear'|'error'|'skipped',
 *   agree: number, pairs: VisionPair[], usd: number|null, note?: string}} VisionResult
 *   `agree` (0..1): share of pairs where the vision label matches Mantis (fixed↔fixed, cover-up↔cover_up).
 *   `usd`: list-price cost of the vision calls (from the tally), null when unknown. `note`: why the
 *   check was skipped or failed.
 */

/** `response_format` for the vision request (Appendix B). */
export const VISION_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'ui_fix_verdict',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: VERDICTS },
        target_visible_after: { type: 'boolean' },
        evidence: { type: 'string' },
        new_problems: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'target_visible_after', 'evidence', 'new_problems'],
      additionalProperties: false,
    },
  },
};

// Appendix B, word for word. The measuring tool is not named and its verdict is never shown.
const SYSTEM =
  'You review a UI fix. You get two crops of the same area of a web page, BEFORE and AFTER a code change, the issue a ' +
  'measuring tool reported before the change, and the code diff. Decide whether that issue was really fixed. Coloured ' +
  'outlines and numbers on the images were drawn by the measuring tool; ignore them. Answer only with JSON that matches the schema.';
const LABELS =
  'fixed = the content is still visible, readable and usable, and the problem is gone. cover_up = the problem is gone because ' +
  'the content was hidden, removed, clipped, shrunk until hard to read, or covered. regressed = the area got worse in another ' +
  'way. unclear = the images do not show enough.';
// For the one retry without response_format, the shape of the answer has to be in the prompt.
const JSON_ONLY =
  'Answer with the JSON object only: {"verdict": "fixed" | "cover_up" | "regressed" | "unclear", ' +
  '"target_visible_after": true | false, "evidence": "<one or two sentences>", "new_problems": ["<short text>"]}';

/** One line of untrusted text (from a report or a model) for a prompt or for display: no control characters, clipped. */
function oneLine(value, max) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function rectOf(r) {
  if (!r || typeof r !== 'object') return null;
  const { x, y, width, height } = r;
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
  return { x, y, width, height };
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

const own = (obj, key) => (obj && typeof obj === 'object' && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined);

/** Where a run's state.json saw `selector` in a cell, when it was found and rendered there. */
function probeRect(state, route, cell, selector) {
  const probe = own(own(own(own(state, 'cells'), `${route}|${cell}`), 'probes'), selector);
  return probe?.found && probe?.rendered ? rectOf(probe.rect) : null;
}

/** A measured cell with a screenshot the loop is allowed to copy out, or null. */
function shotCell(report, route, key) {
  const cell = (Array.isArray(report?.cells) ? report.cells : []).find((c) => c?.route === route && c?.key === key);
  return cell?.status === 'ok' && typeof cell.screenshot === 'string' && SHOT_PATH.test(cell.screenshot) ? cell : null;
}

const typeRank = (type) => (TYPE_ORDER.includes(type) ? TYPE_ORDER.indexOf(type) : TYPE_ORDER.length);

// The first usable cell of a candidate (mobile cells first): both runs have a screenshot there and R0
// has a rect for the issue. Returns the pair without its number, or null.
function pairFor({ issue, cells, mantis }, r0, rf) {
  const keys = (Array.isArray(cells) ? cells : []).filter((k) => typeof k === 'string');
  const ordered = [...keys.filter((k) => k.startsWith('mobile/')), ...keys.filter((k) => !k.startsWith('mobile/'))];
  for (const key of ordered) {
    const before = shotCell(r0.report, issue.route, key);
    const after = shotCell(rf.report, issue.route, key);
    if (!before || !after) continue;
    const occurrence = (Array.isArray(issue.occurrences) ? issue.occurrences : []).find((o) => o?.cell === key);
    const beforeRect = rectOf(occurrence?.rect) ?? probeRect(r0.state, issue.route, key, issue.selector);
    if (!beforeRect) continue;
    const [viewport, scheme, locale] = key.split('/');
    return {
      issueId: issue.id,
      type: oneLine(issue.type, 40),
      selector: typeof issue.selector === 'string' && issue.selector ? oneLine(issue.selector, 200) : null,
      route: oneLine(issue.route, 200),
      cell: oneLine(key, 80),
      viewport: oneLine(before.viewport ?? viewport, 40),
      width: Number.isFinite(before.width) ? before.width : null,
      height: Number.isFinite(before.height) ? before.height : null,
      scheme: oneLine(before.scheme ?? scheme, 20),
      locale: oneLine(before.locale ?? locale, 20),
      message: oneLine(occurrence?.message ?? issue.message, 600),
      mantis,
      beforeShot: before.screenshot,
      afterShot: after.screenshot,
      beforeRect,
      // §2.9.2: where RF's probe found the element, when it is still rendered; otherwise the same box.
      afterRect: probeRect(rf.state, issue.route, key, issue.selector) ?? beforeRect,
    };
  }
  return null;
}

/**
 * Choose up to `max` issues to show the vision model (§2.9.1). Candidates are RF's `baseline.fixed`
 * entries (mantis 'fixed') and RF's cover-up issues (mantis 'cover-up', found in the Gate OFF arm or in
 * kept rounds). Order: cover-ups, then page-overflow, overlap, clipped-text, theme-leak, contrast,
 * broken-image, tap-target, then the rest. Each pair uses one cell, a mobile one when possible, where
 * R0 has a rect for the issue and both runs have a screenshot; issues without a rect (console, network)
 * are skipped. Reports come from the sandbox, so every field is checked; bad or missing data only means
 * fewer pairs, never an exception.
 * @param {{r0: {report: object, state?: object}|null, rf: {report: object, state?: object}|null, max?: number}} o
 *   `rf.state` (RF's state.json) gives the after rects; `r0.state` is optional (a fallback for before rects).
 * @returns {Pair[]}
 */
export function pickPairs({ r0, rf, max = 4 } = {}) {
  const fixed = rf?.report?.baseline?.fixed;
  if (!r0?.report || !rf?.report || !Array.isArray(r0.report.issues) || !(max >= 1)) return [];
  const byId = new Map(r0.report.issues.filter((i) => i && typeof i === 'object').map((i) => [i.id, i]));
  const candidates = [];
  for (const entry of Array.isArray(fixed) ? fixed : []) {
    const issue = byId.get(entry?.id);
    if (issue) candidates.push({ issue, cells: Array.isArray(entry.cells) ? entry.cells : issue.cells, mantis: 'fixed' });
  }
  for (const c of Array.isArray(rf.report.issues) ? rf.report.issues : []) {
    if (c?.type !== 'cover-up') continue;
    const was = c.evidence?.was ?? c.occurrences?.[0]?.evidence?.was;
    const issue = byId.get(was?.id);
    if (issue) candidates.push({ issue, cells: c.cells, mantis: 'cover-up' });
  }
  const group = (c) => (c.mantis === 'cover-up' ? 0 : 1);
  candidates.sort((a, b) => group(a) - group(b) || typeRank(a.issue.type) - typeRank(b.issue.type) || a.issue.id - b.issue.id);
  const pairs = [];
  const used = new Set(); // one pair per R0 issue (two cover-ups can point at the same one)
  for (const c of candidates) {
    if (pairs.length >= max) break;
    if (used.has(c.issue.id)) continue;
    const pair = pairFor(c, r0, rf);
    if (!pair) continue;
    used.add(c.issue.id);
    pairs.push({ i: pairs.length + 1, ...pair });
  }
  return pairs;
}

function dataUri(png) {
  if (!Buffer.isBuffer(png) || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new TypeError('expected PNG bytes for an image part');
  return `data:image/png;base64,${png.toString('base64')}`;
}

function clipDiff(diffText) {
  const s = typeof diffText === 'string' ? diffText : '';
  if (!s.trim()) return '(empty)';
  return s.length > MAX_DIFF ? `${s.slice(0, MAX_DIFF - 8)}\n… (cut)` : s;
}

/**
 * The chat messages for one pair, as Appendix B orders them: the system text, then one user message
 * with the issue, the label definitions, the diff (≤ 4000 characters), and the BEFORE and AFTER crops
 * as base64 data: URIs in `image_url` parts. Exported so the vision probe sends exactly this prompt.
 * @param {{pair: {type: string, selector: string|null, route: string, viewport: string, width: number|null,
 *   height: number|null, scheme: string, locale: string, message: string}, diffText?: string,
 *   beforePng: Buffer, afterPng: Buffer, jsonOnly?: boolean}} o
 *   `jsonOnly` adds the "Answer with the JSON object only" line used for the retry without response_format.
 * @returns {object[]}
 */
export function visionMessages({ pair, diffText = '', beforePng, afterPng, jsonOnly = false } = {}) {
  if (!pair || typeof pair !== 'object') throw new TypeError('visionMessages: pair is required');
  const size = Number.isFinite(pair.width) && Number.isFinite(pair.height) ? ` ${pair.width}×${pair.height}` : '';
  const issue =
    `Issue: ${pair.type} on ${pair.selector ?? 'the page'}. Page ${pair.route}, ${pair.viewport}${size}, ` +
    `${pair.scheme} theme, language ${pair.locale}. Reported before the change: ${pair.message}`;
  const content = [
    { type: 'text', text: issue },
    { type: 'text', text: LABELS },
    { type: 'text', text: `Code diff (may be cut):\n${clipDiff(diffText)}` },
    { type: 'text', text: 'BEFORE:' },
    { type: 'image_url', image_url: { url: dataUri(beforePng) } },
    { type: 'text', text: 'AFTER:' },
    { type: 'image_url', image_url: { url: dataUri(afterPng) } },
  ];
  if (jsonOnly) content.push({ type: 'text', text: JSON_ONLY });
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content }];
}

/** The model's answer as a checked object, or null when there is no usable JSON in it. */
function parseAnswer(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : '';
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    // Without a schema some models wrap the object in a code fence or a sentence: take the outermost {…}.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || !VERDICTS.includes(obj.verdict)) return null;
  return {
    verdict: obj.verdict,
    evidence: oneLine(obj.evidence, MAX_EVIDENCE) || '(no evidence given)',
    targetVisibleAfter: typeof obj.target_visible_after === 'boolean' ? obj.target_visible_after : null,
    newProblems: (Array.isArray(obj.new_problems) ? obj.new_problems : []).filter((s) => typeof s === 'string').slice(0, 5).map((s) => oneLine(s, 160)),
  };
}

/** A short, public-safe reason from an inference error (inference.mjs never puts headers or bodies in messages). */
function reasonOf(err) {
  return oneLine(String(err?.message ?? err).replace(/bearer\s+\S+/gi, 'Bearer [hidden]'), 160) || 'unknown error';
}

/** Decode both screenshots, crop them with one box around the union of the two rects, and encode the crops. */
async function cropPair(pair, store) {
  if (!Buffer.isBuffer(pair.before) || !Buffer.isBuffer(pair.after)) return { error: 'the screenshots were not copied out' };
  let crops;
  try {
    const rect = rectOf(pair.beforeRect);
    if (!rect) throw new Error('no area to crop');
    const a = decodePng(pair.before);
    const b = decodePng(pair.after);
    // One box for both crops. It stays inside the smaller screenshot unless the rects themselves reach past
    // it (a page-overflow makes the BEFORE page wider than the viewport): then it goes as far as they do,
    // and each crop is clipped to its own image.
    const area = union(rect, rectOf(pair.afterRect) ?? rect);
    const limit = (small, big, edge) => Math.min(big, Math.max(small, Math.ceil(edge)));
    const box = cropBox(
      area,
      limit(Math.min(a.width, b.width), Math.max(a.width, b.width), area.x + area.width),
      limit(Math.min(a.height, b.height), Math.max(a.height, b.height), area.y + area.height),
    );
    crops = { before: encodePng(cropImage(a, box)), after: encodePng(cropImage(b, box)) };
  } catch (err) {
    return { error: `could not crop the screenshots: ${oneLine(err.message, 120)}` };
  }
  if (store?.put && Number.isInteger(pair.i) && pair.i > 0) {
    try {
      await store.put(`crop-before-${pair.i}.png`, crops.before);
      await store.put(`crop-after-${pair.i}.png`, crops.after);
    } catch {
      // The stored crops are only for people to look at; the check itself does not need them.
    }
  }
  return crops;
}

/** One pair: ask with the strict schema; if that answer does not parse (or the request is refused), ask once more without it. */
async function judge(pair, crops, ctx) {
  const row = {
    issue: oneLine(`${pair.type} on ${pair.selector ?? 'the page'} · ${pair.route} · ${pair.cell}`, 300),
    mantis: pair.mantis === 'cover-up' ? 'cover-up' : 'fixed',
    vision: 'unclear',
    evidence: '',
    targetVisibleAfter: null,
    newProblems: [],
  };
  if (crops.error) return { row: { ...row, evidence: crops.error }, answered: false };
  if (ctx.signal?.aborted) return { row: { ...row, evidence: 'not checked: the task was stopped' }, answered: false };
  const ask = async (jsonOnly) => {
    const res = await ctx.chat({
      model: ctx.model,
      messages: visionMessages({ pair, diffText: ctx.diffText, beforePng: crops.before, afterPng: crops.after, jsonOnly }),
      ...(jsonOnly ? {} : { responseFormat: VISION_SCHEMA }),
      maxTokens: 2048,
      reasoning: { effort: 'low', max_tokens: 1024 },
      ...ctx.sampling,
      signal: ctx.signal,
      tally: ctx.tally,
      guard: ctx.guard,
    });
    return parseAnswer(res?.message?.content);
  };
  let answered = false;
  try {
    let answer = null;
    try {
      answer = await ask(false);
      answered = true;
    } catch (err) {
      // A 400/422 can mean the model does not take response_format; anything else is a real failure.
      if (err?.status !== 400 && err?.status !== 422) throw err;
    }
    if (!answer) {
      answer = await ask(true);
      answered = true;
    }
    if (!answer) return { row: { ...row, evidence: 'no parseable answer' }, answered };
    return { row: { ...row, vision: answer.verdict, evidence: answer.evidence, targetVisibleAfter: answer.targetVisibleAfter, newProblems: answer.newProblems }, answered };
  } catch (err) {
    return { row: { ...row, evidence: `vision request failed: ${reasonOf(err)}` }, answered };
  }
}

/** §2.9.5: fail on any cover_up or regressed; pass when every pair Mantis called fixed is fixed; else unclear. */
function overallVerdict(results) {
  if (!results.some((r) => r.answered)) return 'error';
  const rows = results.map((r) => r.row);
  if (rows.some((r) => r.vision === 'cover_up' || r.vision === 'regressed')) return 'fail';
  // With only cover-up pairs the rule above would pass vacuously; then every pair must be judged fixed.
  const mantisFixed = rows.filter((r) => r.mantis === 'fixed');
  return (mantisFixed.length ? mantisFixed : rows).every((r) => r.vision === 'fixed') ? 'pass' : 'unclear';
}

/** USD the tally has booked for `model` so far: 0 before its first call, null when the price is unknown or there is no tally. */
function bookedUsd(tally, model) {
  if (!tally || typeof tally !== 'object') return null;
  const rows = tally.byModel && typeof tally.byModel === 'object' ? tally.byModel : {};
  const key = Object.keys(rows).find((k) => k.toLowerCase() === String(model).toLowerCase());
  if (key === undefined) return 0;
  const usd = rows[key]?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : null;
}

async function inParallel(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Run the vision check: one request per pair, at most 2 at a time. `pairs` come from pickPairs() with
 * `before`/`after` set to the full R0 and RF screenshots (PNG bytes). Both are cropped here with one box
 * around the union of the before and after rects; with `store`, the crops are kept as
 * crop-before-<i>.png / crop-after-<i>.png. Requests use `response_format: VISION_SCHEMA`, reasoning
 * effort low (1024) and 2048 completion tokens; an answer that does not parse is asked once more without
 * the schema. Never throws: failures end up in the pairs' evidence or in `verdict: 'error'`.
 * @param {{model: string, pairs: Pair[], diffText?: string, chat: typeof import('./inference.mjs').chat,
 *   tally?: object, guard?: object, signal?: AbortSignal, sampling?: {temperature?: number, topP?: number, seed?: number},
 *   store?: {put(name: string, data: Buffer): Promise<void>}}} o
 * @returns {Promise<VisionResult>}
 */
export async function visionCheck({ model, pairs, diffText = '', chat, tally, guard, signal, sampling = {}, store } = {}) {
  const empty = { model: model || null, provider: PROVIDER, verdict: 'skipped', agree: 0, pairs: [], usd: 0 };
  if (!model) return { ...empty, note: 'no vision model was chosen for this task' };
  if (!Array.isArray(pairs) || !pairs.length) return { ...empty, note: 'no fixed issue with screenshots to compare' };
  if (typeof chat !== 'function') return { ...empty, verdict: 'error', note: 'no inference client was given' };
  const usdBefore = bookedUsd(tally, model);
  const spent = () => {
    const after = bookedUsd(tally, model);
    return usdBefore === null || after === null ? null : Math.round((after - usdBefore) * 1e6) / 1e6;
  };
  try {
    const { temperature, topP, seed } = sampling ?? {};
    const ctx = {
      model, diffText, chat, tally, guard, signal,
      sampling: { ...(temperature != null && { temperature }), ...(topP != null && { topP }), ...(seed != null && { seed }) },
    };
    const crops = [];
    for (const pair of pairs) crops.push(await cropPair(pair ?? {}, store)); // one at a time: each decode holds a full screenshot
    const results = await inParallel(pairs, PARALLEL, (pair, k) => judge(pair ?? {}, crops[k], ctx));
    const rows = results.map((r) => r.row);
    const agree = rows.filter((r) => (r.mantis === 'fixed' && r.vision === 'fixed') || (r.mantis === 'cover-up' && r.vision === 'cover_up')).length;
    const verdict = overallVerdict(results);
    return {
      model, provider: PROVIDER, verdict,
      agree: Math.round((agree / rows.length) * 1000) / 1000,
      pairs: rows,
      usd: spent(),
      ...(verdict === 'error' && { note: `no pair could be checked: ${rows[0].evidence}` }),
    };
  } catch (err) {
    return { ...empty, verdict: 'error', usd: spent(), note: `vision check failed: ${oneLine(err?.message ?? err, 160)}` };
  }
}

/**
 * The display line (§2.9.6), e.g. "Second opinion · qwen3.8-27b on Vultr Serverless Inference: PASS — <evidence>.
 * Mantis's measurement decides." The evidence is the first pair that explains the verdict.
 * @param {VisionResult|null} v
 * @returns {string}
 */
export function visionLine(v) {
  if (!v || v.verdict === 'skipped') return `Second opinion: not run${v?.note ? ` (${v.note})` : ''}.`;
  const rows = Array.isArray(v.pairs) ? v.pairs : [];
  const pick =
    v.verdict === 'fail' ? rows.find((r) => r.vision === 'cover_up' || r.vision === 'regressed')
    : v.verdict === 'unclear' ? rows.find((r) => r.vision !== 'fixed')
    : v.verdict === 'pass' ? rows[0]
    : null;
  const evidence = oneLine(pick?.evidence ?? v.note ?? '', MAX_EVIDENCE).replace(/[.\s]+$/, '');
  return `Second opinion · ${v.model} on ${v.provider || PROVIDER}: ${String(v.verdict).toUpperCase()}${evidence ? ` — ${evidence}` : ''}. Mantis's measurement decides.`;
}
