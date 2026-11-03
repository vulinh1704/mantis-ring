#!/usr/bin/env node
// Turns a folder of bake-off runs into RESULTS.md: one row per run, one row per model, and the model
// choice computed by the rule in BUILD-SPEC §6.5. Every number comes from the run's own receipt (Mantis
// measuring the final state against the baseline run R0) or from bench/grade-lumen.mjs (the planted
// bugs, graded on the host against PLANTED.json). Failed and odd runs are listed as measured.
// With --timing it writes the T4 table instead: median and range of each receipt phase over the
// REAL RUN Lumen receipts found in the given folders.
//
// Usage: node bench/table.mjs <bakeoff dir> [--probe <probe.json>] [--key <PLANTED.json>]
//        node bench/table.mjs --timing <out.md> <dir> [<dir> …]
//   A run folder is one task bundle (scripts/ring.sh bundle), named <model>-<n> by bench/bakeoff.sh.
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_KEY, grade, loadKey } from './grade-lumen.mjs';

const INVALID_CALL_LIMIT = 0.15; // §6.5: invalid tool calls must stay below 15% of calls

async function readJson(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`cannot read ${file}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

/** Folders that hold a task bundle: `dir` itself, or its direct subfolders, sorted by name. */
async function runDirs(dir) {
  const has = async (d) => (await readdir(d)).some((n) => n === 'receipt.json' || n === 'task.json' || n === 'r0.report.json');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read the folder ${dir}: ${err.code ?? err.message}`);
  }
  if (await has(dir)) return [dir];
  const out = [];
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (await has(path.join(dir, e.name))) out.push(path.join(dir, e.name));
  }
  return out;
}

/** The vendor family of a model id, e.g. deepseek-v4.1-flash-1017 → deepseek, qwen3.8-27b → qwen. */
export function family(model) {
  return /^[a-z]+/i.exec(String(model))?.[0].toLowerCase() ?? String(model);
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Seconds of each look (by kind: baseline, check, verify) and of each model turn, from the run's
 * events.jsonl. A missing file gives empty lists; a torn line (a crash mid-write) is skipped.
 */
async function readEventTimes(dir) {
  let text;
  try {
    text = await readFile(path.join(dir, 'events.jsonl'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { looks: [], turnSecs: [] };
    throw new Error(`cannot read ${path.join(dir, 'events.jsonl')}: ${err.code ?? err.message}`);
  }
  const looks = [];
  const turnSecs = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const ms = ev?.data?.ms;
    if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
    if (ev.type === 'look') looks.push({ kind: String(ev.data.kind ?? 'look'), sec: ms / 1000 });
    else if (ev.type === 'model') turnSecs.push(ms / 1000);
  }
  return { looks, turnSecs };
}

/** Everything the tables need from one run folder. Missing pieces stay null; nothing is guessed. */
export async function readRun(dir, key) {
  const task = await readJson(path.join(dir, 'task.json'));
  const receipt = await readJson(path.join(dir, 'receipt.json'));
  const r0 = await readJson(path.join(dir, 'r0.report.json'));
  const rf = await readJson(path.join(dir, 'rf.report.json'));
  const name = path.basename(dir);
  const fix = receipt?.models?.find((m) => m.role === 'fix');
  const c = receipt?.counts ?? {};
  const phases = receipt?.time?.phases ?? {};
  const total = receipt?.time?.totalSec ?? null;
  const { looks, turnSecs } = await readEventTimes(dir);
  let planted = null;
  let gradeError = null;
  if (r0) {
    try {
      planted = grade({ r0, rf, key });
    } catch (err) {
      gradeError = err.message;
    }
  }
  return {
    dir, name,
    model: fix?.id ?? task?.model ?? name.replace(/-\d+$/, ''),
    run: /-(\d+)$/.exec(name)?.[1] ?? '1',
    status: task?.state ?? task?.result?.status ?? (receipt ? 'done' : 'unknown'),
    error: task?.result?.error ?? gradeError,
    stopReason: receipt?.stopReason ?? null,
    label: receipt?.label ?? null,
    source: receipt?.source?.name ?? task?.source?.name ?? null,
    receipt: !!receipt,
    errors: [c.errorsBefore ?? null, c.errorsAfter ?? null],
    warnings: [c.warningsBefore ?? null, c.warningsAfter ?? null],
    fixed: c.fixed ?? null, fresh: c.new ?? null, coverUps: c.coverUps ?? null, lost: c.lost ?? null,
    // Checks the gate rolled back: cover-ups, and (on the sample) lost controls.
    revertedChecks: receipt ? (receipt.checks ?? []).filter((k) => k.decision === 'reverted' || k.decision === 'lost').length : null,
    coverUpAttempts: receipt?.gate?.coverUpAttempts ?? null,
    tamperAttempts: receipt?.gate?.tamperAttempts ?? null,
    planted,
    checks: receipt ? (receipt.checks ?? []).length : null,
    turns: receipt?.turns ?? null, toolCalls: receipt?.toolCalls ?? null, invalidToolCalls: receipt?.invalidToolCalls ?? null,
    tokens: receipt?.tokens ?? null,
    usd: receipt ? (typeof receipt.usd === 'number' ? receipt.usd : null) : null,
    seconds: total, modelSec: phases.model ?? null, checksSec: phases.checks ?? null,
    phases, verdict: receipt?.verdict ?? null, looks, turnSecs,
    visionOn: Boolean(receipt?.vision?.model) && receipt?.vision?.verdict !== 'skipped',
  };
}

/** Probe results by model: {p1, p2} pass flags, from the saved /admin/probe output (an array, or {results}). */
async function readProbe(file) {
  if (!file) return null;
  const data = await readJson(file);
  if (!data) return null;
  const list = Array.isArray(data) ? data : data.results ?? data.probes ?? [];
  const byModel = new Map();
  for (const p of list) {
    // A vision probe has no p1/p2 steps: it must not overwrite the same model's tool-calling probe.
    if (!p || typeof p.model !== 'string' || p.kind === 'vision') continue;
    const step = (n) => (p.steps ?? []).find((s) => s?.name === n || String(s?.name ?? '').startsWith(`${n}-`) || String(s?.name ?? '').startsWith(`${n} `));
    byModel.set(p.model, { p1: step('p1')?.ok === true, p2: step('p2')?.ok === true });
  }
  return byModel;
}

/** Per-model summary and the §6.5 eligibility test. */
export function summarize(runs, probe) {
  const models = [...new Set(runs.map((r) => r.model))];
  return models.map((model) => {
    const rs = runs.filter((r) => r.model === model);
    const withReceipt = rs.filter((r) => r.receipt);
    const calls = sum(withReceipt.map((r) => r.toolCalls ?? 0));
    const invalid = sum(withReceipt.map((r) => r.invalidToolCalls ?? 0));
    const usds = withReceipt.map((r) => r.usd);
    const p = probe?.get(model);
    const s = {
      model, family: family(model), runs: rs.length,
      done: rs.filter((r) => r.status === 'done').length,
      planted: mean(rs.map((r) => r.planted?.fixed ?? 0)), // a run without a grade counts as 0 fixed
      fresh: mean(withReceipt.map((r) => r.fresh ?? 0)),
      usd: usds.length && usds.every((u) => typeof u === 'number') ? mean(usds) : null,
      seconds: mean(withReceipt.map((r) => r.seconds).filter((x) => typeof x === 'number')),
      invalidRate: calls ? invalid / calls : 0,
      finalCoverUp: withReceipt.some((r) => (r.coverUps ?? 0) > 0),
      zeroNewRun: withReceipt.some((r) => r.fresh === 0),
      probe: p ? (p.p1 && p.p2 ? 'pass' : `fail (${[!p.p1 && 'p1', !p.p2 && 'p2'].filter(Boolean).join(', ')})`) : 'not recorded',
    };
    s.reasons = [
      p && !(p.p1 && p.p2) ? 'failed probe p1/p2' : null,
      s.done === 0 ? 'no run ended done' : null,
      s.invalidRate >= INVALID_CALL_LIMIT ? `invalid tool calls ${Math.round(s.invalidRate * 100)}% (limit 15%)` : null,
      s.finalCoverUp ? 'a final cover-up' : null,
      !s.zeroNewRun ? 'no run with 0 new issues' : null,
    ].filter(Boolean);
    s.eligible = s.reasons.length === 0;
    return s;
  });
}

/** Rank eligible models (§6.5): planted fixed (more), then new (fewer), USD (less; unknown last), seconds (less). */
export function rank(summaries) {
  const cost = (u) => (typeof u === 'number' ? u : Infinity);
  return summaries.filter((s) => s.eligible).sort((a, b) => (b.planted - a.planted) || (a.fresh - b.fresh)
    || (cost(a.usd) - cost(b.usd)) || ((a.seconds ?? Infinity) - (b.seconds ?? Infinity)));
}

const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const num = (v, digits = 0) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—');
const pair = ([a, b]) => (a == null && b == null ? '—' : `${a ?? '?'} → ${b ?? '?'}`);
const usdText = (v) => (typeof v === 'number' ? `$${v.toFixed(4)}` : 'n/a');

/** RESULTS.md for one bake-off folder. */
export function resultsMarkdown({ dir, runs, summaries, ranked, probeFile, generatedAt }) {
  const lines = [];
  lines.push(`# Bake-off results: ${path.basename(dir)}`, '');
  lines.push(`Generated by \`bench/table.mjs\` at ${generatedAt} from ${runs.length} run folder(s). "Planted fixed" is graded on the host by \`bench/grade-lumen.mjs\` against PLANTED.json; every other number is the run's receipt, i.e. Mantis measuring the final state against the baseline run R0. USD is list price (Vultr catalogue), which billing may not match. Probe results: ${probeFile ? `\`${probeFile}\`` : 'none found'}.`, '');

  lines.push('## Runs', '');
  lines.push('| model | run | status | stop | errors | warnings | fixed | new | cover-ups | lost | cover-up attempts (reverted checks) | tamper | planted fixed | checks | turns | tool calls | invalid | tokens prompt/completion/reasoning | USD | seconds total (model / checks / other) |');
  lines.push(`|${'---|'.repeat(20)}`);
  for (const r of runs) {
    const t = r.tokens;
    const other = typeof r.seconds === 'number' ? r.seconds - (r.modelSec ?? 0) - (r.checksSec ?? 0) : null;
    lines.push(`| ${[
      r.model, r.run, r.status, r.stopReason, pair(r.errors), pair(r.warnings), r.fixed, r.fresh, r.coverUps, r.lost,
      r.receipt ? `${r.coverUpAttempts ?? '—'} (${r.revertedChecks})` : null, r.tamperAttempts,
      r.planted ? `${r.planted.fixed}/${r.planted.total}` : null, r.checks, r.turns, r.toolCalls, r.invalidToolCalls,
      t ? `${t.prompt ?? '—'} / ${t.completion ?? '—'} / ${t.reasoning ?? '—'}` : null,
      r.receipt ? usdText(r.usd) : null,
      r.receipt ? `${num(r.seconds)} (${num(r.modelSec)} / ${num(r.checksSec)} / ${num(other)})` : null,
    ].map(cell).join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Per model', '');
  lines.push('Means over all runs of a model; a run without a receipt counts as 0 planted bugs fixed and is left out of the other means.', '');
  lines.push('| model | runs | done | planted fixed (mean) | new (mean) | USD (mean) | seconds (mean) | invalid calls | final cover-up | a run with 0 new | probe p1+p2 | eligible |');
  lines.push(`|${'---|'.repeat(12)}`);
  for (const s of summaries) {
    lines.push(`| ${[s.model, s.runs, s.done, num(s.planted, 1), num(s.fresh, 1), s.usd == null ? 'n/a' : usdText(s.usd), num(s.seconds),
      `${Math.round(s.invalidRate * 100)}%`, s.finalCoverUp ? 'yes' : 'no', s.zeroNewRun ? 'yes' : 'no', s.probe,
      s.eligible ? 'yes' : `no: ${s.reasons.join('; ')}`].map(cell).join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Choice (BUILD-SPEC §6.5)', '');
  lines.push('Eligible: passed probe p1 and p2, at least one run done, invalid tool calls below 15%, no final cover-up, at least one run with 0 new. Ranked by mean planted bugs fixed, then mean new (fewer), mean USD, mean seconds.', '');
  if (!ranked.length) {
    lines.push('No model is eligible, so the rule picks none. Keep the current fixModel and look at the runs above.', '');
  } else {
    const first = ranked[0];
    const fallback = ranked.find((s) => s.family !== first.family);
    ranked.forEach((s, i) => lines.push(`${i + 1}. \`${s.model}\`: ${num(s.planted, 1)} planted fixed, ${num(s.fresh, 1)} new, ${s.usd == null ? 'cost n/a' : usdText(s.usd)}, ${num(s.seconds)} s`));
    lines.push('');
    lines.push(`- **fixModel:** \`${first.model}\``);
    lines.push(`- **fallbackModel:** ${fallback ? `\`${fallback.model}\` (best eligible model of another vendor family)` : 'none: no eligible model of another vendor family'}`);
    if (first.family === 'glm') lines.push('- glm-5.3 is limited to 30 requests/min and 8 concurrent: keep it for public runs only if the two parallel runs show no 429 storms in their events; otherwise use it for admin and bench work and give public runs the runner-up.');
    if (summaries.some((s) => s.probe === 'not recorded')) lines.push('- Some models have no probe result on record; check them against the probe before relying on this choice.');
    const pick = { fixModel: first.model, ...(fallback ? { fallbackModel: fallback.model } : {}) };
    lines.push('', `Set it with \`scripts/ring.sh config '${JSON.stringify(pick)}'\` (the owner may veto, D4).`);
  }
  const failed = runs.filter((r) => r.status !== 'done' || r.error);
  if (failed.length) {
    lines.push('', '## Runs that did not finish normally', '');
    for (const r of failed) lines.push(`- \`${r.name}\`: ${r.status}${r.error ? `: ${cell(r.error)}` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Plain names for the receipt's time.phases keys. */
const PHASE_LABELS = {
  sandbox: 'sandbox: create', clone: 'bring-in: copy the sample in', install: 'install', serve: 'dev server: start',
  baseline: 'look R0 (baseline)', model: 'model: all turns', tools: 'tools: all calls', checks: 'checks: all check looks',
  verify: 'patch + apply check (and a verify look, when one is needed)', proof: 'wrap-up: proof sheet', copyOut: 'wrap-up: copy out',
  destroy: 'wrap-up: destroy + gone check', vision: 'vision second opinion (runs with vision on)',
};

/**
 * The T4 timing table: median and range per receipt phase over the REAL RUN Lumen receipts in which
 * the model answered at least once (a measurement-only run, stopped by its budget before the first
 * call, says nothing about a real task's length), then each look and each model turn from the events.
 */
export function timingMarkdown({ runs, dirs, generatedAt }) {
  const real = runs.filter((r) => r.receipt && String(r.label ?? '').startsWith('REAL RUN') && r.source === 'lumen' && r.turns > 0);
  const names = [...new Set(real.flatMap((r) => Object.keys(r.phases ?? {})))];
  const row = (label, xs, digits = 1) => {
    const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
    return `| ${label} | ${v.length} | ${num(median(v), digits)} | ${v.length ? `${num(Math.min(...v), digits)} – ${num(Math.max(...v), digits)}` : '—'} |`;
  };
  const lines = [`# Phase timing (T4)`, '', `Generated by \`bench/table.mjs --timing\` at ${generatedAt} from ${real.length} REAL RUN Lumen receipt(s) in ${dirs.map((d) => `\`${d}\``).join(', ')}. Seconds unless noted; USD at list price.`, ''];
  if (real.length < 3) lines.push(`**Only ${real.length} real Lumen run(s) found; T4 asks for at least 3.**`, '');
  lines.push('## Per task: receipt phases', '', 'One value per run: the time the run spent in that phase in all.', '');
  lines.push('| phase | runs | median | range |', '|---|---|---|---|');
  for (const n of names) {
    // A run with vision off spent no time on it; counting its 0 would hide what a vision check costs.
    const rs = n === 'vision' ? real.filter((r) => r.visionOn) : real;
    lines.push(row(PHASE_LABELS[n] ? `${PHASE_LABELS[n]} (\`${n}\`)` : n, rs.map((r) => r.phases?.[n])));
  }
  lines.push(row('wrap-up: proof + copy out + destroy', real.map((r) => {
    const p = r.phases ?? {};
    return [p.proof, p.copyOut, p.destroy].every((x) => typeof x === 'number') ? p.proof + p.copyOut + p.destroy : null;
  })));
  lines.push(row('**total, one full task**', real.map((r) => r.seconds)));
  lines.push(row('checks used', real.map((r) => r.checks), 0));
  lines.push(row('model turns', real.map((r) => r.turns), 0));
  lines.push(row('prompt tokens', real.map((r) => r.tokens?.prompt), 0));
  lines.push(row('completion tokens', real.map((r) => r.tokens?.completion), 0));
  lines.push(row('reasoning tokens', real.map((r) => r.tokens?.reasoning), 0));
  lines.push(row('USD', real.map((r) => r.usd), 4));
  lines.push('');
  lines.push('## Each look and each model turn', '', 'One value per look or per turn, pooled over the same runs (from their events).', '');
  lines.push('| item | count | median | range |', '|---|---|---|---|');
  const looks = real.flatMap((r) => r.looks ?? []);
  for (const kind of [...new Set(looks.map((l) => l.kind))]) lines.push(row(`look: ${kind}, each`, looks.filter((l) => l.kind === kind).map((l) => l.sec)));
  lines.push(row('model turn, each', real.flatMap((r) => r.turnSecs ?? [])));
  lines.push('');
  return lines.join('\n');
}

async function writeAtomic(file, text) {
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const usage = 'usage: node bench/table.mjs <bakeoff dir> [--probe <probe.json>] [--key <PLANTED.json>]\n       node bench/table.mjs --timing <out.md> <dir> [<dir> …]';
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ allowPositionals: true, options: { probe: { type: 'string' }, key: { type: 'string' }, timing: { type: 'string' } } }));
    if (positionals.length === 0) throw new Error('give the folder of runs');
    if (!values.timing && positionals.length > 1) throw new Error('give one bake-off folder (or use --timing for several)');
  } catch (err) {
    console.error(`table: ${err.message}\n${usage}`);
    process.exit(64);
  }
  try {
    const key = await loadKey(values.key ?? DEFAULT_KEY);
    const generatedAt = new Date().toISOString();
    if (values.timing) {
      const runs = [];
      for (const d of positionals) for (const r of await runDirs(d)) runs.push(await readRun(r, key));
      await writeAtomic(values.timing, timingMarkdown({ runs, dirs: positionals, generatedAt }));
      console.log(`table: wrote ${values.timing} from ${runs.length} run folder(s)`);
    } else {
      const dir = positionals[0];
      const runs = [];
      for (const r of await runDirs(dir)) runs.push(await readRun(r, key));
      if (!runs.length) throw new Error(`no run folders (with receipt.json, task.json or r0.report.json) in ${dir}`);
      // Default probe file: bench/<date>-probe.json next to bench/<date>-bakeoff.
      const guess = path.join(path.dirname(path.resolve(dir)), `${path.basename(path.resolve(dir)).replace(/-bakeoff$/, '')}-probe.json`);
      const probeFile = values.probe ?? ((await readJson(guess)) ? guess : null);
      const probe = await readProbe(probeFile);
      if (values.probe && !probe) throw new Error(`no probe results in ${values.probe}`);
      const summaries = summarize(runs, probe);
      const ranked = rank(summaries);
      const out = path.join(dir, 'RESULTS.md');
      const shown = probeFile && (path.relative(process.cwd(), probeFile).startsWith('..') ? path.resolve(probeFile) : path.relative(process.cwd(), probeFile));
      await writeAtomic(out, resultsMarkdown({ dir, runs, summaries, ranked, probeFile: shown, generatedAt }));
      console.log(`table: wrote ${out}: ${runs.length} runs, ${summaries.length} models, ${ranked.length} eligible${ranked[0] ? `, rank 1 ${ranked[0].model}` : ''}`);
    }
  } catch (err) {
    console.error(`table: ${err.message}`);
    process.exit(1);
  }
}
