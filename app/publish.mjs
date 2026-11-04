// Publishes one finished run as the static "Latest verified run" page that Caddy serves at /latest/
// (BUILD-SPEC §4.8). The run is built in a staging folder on the same filesystem (never /tmp: the unit
// has PrivateTmp), renamed into runs/<id>, and then the `latest` symlink is replaced with a rename, so
// /latest/ never shows a half-written run. Every string on the page is HTML-escaped, and the page has
// no script and a CSP of its own. Only a receipt that passes the bar is published: verdict pass, no
// lost control, every screen compared, a patch that applies, a sample project, a REAL RUN label and a
// sandbox confirmed destroyed. Nothing is ever published automatically (D-9); an approval of the
// published run only renders the same run again with its approval.
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NETWORK, esc, readSelftests, runtimeName, sizeText, usdText, utcText } from './status.mjs';

const TASK_ID = /^t_[0-9a-f]{32}$/;
const IMAGES = ['proof.png', 'contact-before.png', 'contact-after.png'];
const IMAGE_ALT = {
  'proof.png': 'Proof sheet made by Mantis: the starting point and the final run, side by side',
  'contact-before.png': 'Every screen at the starting point',
  'contact-after.png': 'Every screen after the fix',
};
const MAX_IMAGE_BYTES = 20 * 2 ** 20;
const MAX_PATCH_BYTES = 1024 * 1024;
const KEEP_RUNS = 5;
const DECISIONS = {
  accepted: 'accepted', kept: 'kept (gate off)', reverted: 'COVER-UP · rolled back', lost: 'LOST CONTROLS · rolled back',
  tamper: 'tamper · rolled back', failed: 'not measurable · rolled back',
};
// The page has no script, takes images and styles only from itself, and posts nowhere.
const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** A run that cannot be published; the message says why (the server answers 409 with it). */
export class PublishError extends Error {}

/** Why a run may not be published, as one phrase, or null when it may (§3.3 publishable, §4.8). */
export function notPublishable(task, receipt) {
  if (!receipt || typeof receipt !== 'object') return 'the run has no receipt';
  const why = [];
  const c = receipt.counts ?? {};
  if (receipt.verdict !== 'pass') why.push(`its verdict is ${receipt.verdict ?? 'missing'} (it must be pass)`);
  if (Number(c.lost) > 0) why.push(`Mantis reports ${c.lost} lost control${Number(c.lost) === 1 ? '' : 's'}`);
  if (Number.isFinite(c.cellsExpected) && !(Number(c.cellsCompared) >= c.cellsExpected)) {
    why.push(`Mantis compared ${Number(c.cellsCompared) || 0} of the ${c.cellsExpected} screens it measured at the start`);
  }
  if (receipt.diff?.applies === false) why.push('its patch does not apply to the original files');
  if (receipt.diff?.truncated) why.push('its patch was cut at 1 MB');
  if (!String(receipt.label ?? '').startsWith('REAL RUN')) why.push(`its label is "${String(receipt.label ?? '').slice(0, 80)}" (only a REAL RUN is published)`);
  if (task?.source?.kind !== 'sample' || (receipt.source && receipt.source.kind !== 'sample')) why.push('only sample-project runs are published');
  if (receipt.containment?.destroyed !== true) why.push('its sandbox was not confirmed destroyed');
  if (receipt.publishable !== true && why.length === 0) why.push('the receipt says it is not publishable');
  return why.length ? why.join('; ') : null;
}

/**
 * What the published page may say about the approval, and nothing more than the server enforced:
 * with the owner's approval passphrase (set on the server, never seen by the operator), a person
 * approved; with the owner link alone, only whoever held the link did.
 */
export function approvalText(task) {
  if (!task?.approvedAt) return 'Not approved (patch shown for review only; nothing was applied anywhere).';
  if (task.approvedWith === 'passphrase') return `Approved by a human at ${utcText(task.approvedAt)}, with the owner's approval passphrase.`;
  return `Approved with the owner link at ${utcText(task.approvedAt)}.`;
}

/**
 * Publish a run to <publicDir>/runs/<id> and point <publicDir>/latest at it.
 * @param {{task:object, receipt:object, files:Record<string,string>, publicDir:string}} o
 *   task: the public task record (with approvedAt); files: proof.png, contact-before.png,
 *   contact-after.png and patch.diff, mapped to absolute paths in the task folder
 * @returns {Promise<{dir:string, url:'/latest/'}>}
 */
export async function publishLatest({ task, receipt, files = {}, publicDir }) {
  const id = task?.id;
  if (!TASK_ID.test(String(id))) throw new PublishError('not a task id');
  if (!publicDir) throw new PublishError('no public folder is configured');
  const why = notPublishable(task, receipt);
  if (why) throw new PublishError(`not publishable: ${why}`);

  const runs = path.join(publicDir, 'runs');
  mkdirSync(runs, { recursive: true, mode: 0o755 });
  const staging = path.join(publicDir, `.staging-${id}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { mode: 0o755 });
  try {
    const images = [];
    for (const name of IMAGES) {
      if (!files[name]) continue;
      copyRegular(files[name], path.join(staging, name), MAX_IMAGE_BYTES);
      images.push(name);
    }
    const patch = files['patch.diff'] ? readRegular(files['patch.diff'], MAX_PATCH_BYTES) : '';
    const selftests = readSelftests();
    writePublic(staging, 'patch.txt', patch || '(the patch is empty)\n');
    writePublic(staging, 'receipt.json', `${JSON.stringify(receipt, null, 2)}\n`);
    writePublic(staging, 'containment.txt', containmentText(receipt, selftests));
    writePublic(staging, 'index.html', runPageHtml({ task, receipt, images, selftests }));
    chmodSync(staging, 0o755);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  // Into place. A run published before (for example again after its approval) is set aside first.
  const dir = path.join(runs, id);
  const old = lstatOrNull(dir) ? path.join(publicDir, `.old-${id}-${Date.now()}`) : null;
  if (old) renameSync(dir, old);
  renameSync(staging, dir);

  // latest -> runs/<id>: a new symlink renamed over the old one is atomic. The first time, `latest` is
  // still the real folder holding the placeholder page; it is moved aside (a gap of microseconds).
  const latest = path.join(publicDir, 'latest');
  const tmp = path.join(publicDir, 'latest.tmp');
  rmSync(tmp, { force: true });
  symlinkSync(`runs/${id}`, tmp);
  const st = lstatOrNull(latest);
  if (st && !st.isSymbolicLink()) renameSync(latest, path.join(publicDir, `latest.placeholder-${Date.now()}`));
  renameSync(tmp, latest);

  if (old) rmSync(old, { recursive: true, force: true });
  pruneRuns(runs, id);
  return { dir, url: '/latest/' };
}

function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

/** Copy a regular file (never a symlink) of at most `max` bytes, as 0644. */
function copyRegular(src, dest, max) {
  const st = lstatOrNull(src);
  if (!st?.isFile()) throw new PublishError(`${path.basename(src)} is not a regular file`);
  if (st.size > max) throw new PublishError(`${path.basename(src)} is larger than ${max} bytes`);
  copyFileSync(src, dest, constants.COPYFILE_EXCL);
  chmodSync(dest, 0o644);
}

function readRegular(src, max) {
  const st = lstatOrNull(src);
  if (!st?.isFile()) throw new PublishError(`${path.basename(src)} is not a regular file`);
  if (st.size > max) throw new PublishError(`${path.basename(src)} is larger than ${max} bytes`);
  return readFileSync(src, 'utf8');
}

function writePublic(dir, name, text) {
  const file = path.join(dir, name);
  writeFileSync(file, text, { flag: 'wx', mode: 0o644 });
  chmodSync(file, 0o644);   // the umask may have taken bits away
}

/** Keep the newest KEEP_RUNS published runs (always the current one); remove older ones. */
function pruneRuns(runs, current) {
  let entries;
  try {
    entries = readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory() && TASK_ID.test(d.name));
  } catch {
    return;
  }
  const byAge = entries
    .map((d) => ({ name: d.name, mtime: lstatOrNull(path.join(runs, d.name))?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtime - a.mtime);
  let kept = 0;
  for (const e of byAge) {
    if (e.name === current || kept < KEEP_RUNS - 1) {
      if (e.name !== current) kept += 1;
      continue;
    }
    rmSync(path.join(runs, e.name), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Text and HTML
// ---------------------------------------------------------------------------------------------
const int = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : 'n/a');
const secText = (s) => (Number.isFinite(s) ? (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s * 10) / 10} s`) : 'n/a');

function selftestLine(name, s) {
  if (!s) return `${name}: no self-test result on record`;
  return `${name}: ${s.passed}/${s.total} passed${s.runtime ? ` under ${s.runtime}` : ''}${s.at ? ` at ${utcText(s.at)}` : ''}${s.commit ? ` on commit ${s.commit}` : ''}`;
}

/** containment.txt: what held the run, and the last self-test results on this server. */
export function containmentText(receipt, selftests = {}) {
  const c = receipt?.containment ?? {};
  const l = c.limits ?? {};
  return [
    `Mantis Ring · containment of run ${receipt?.taskId ?? ''}`,
    `runtime: ${c.runtime ?? 'unknown'}`,
    `sandbox: ${c.sandbox ?? 'unknown'}`,
    `limits: memory ${l.memory ?? '?'}, cpus ${l.cpus ?? '?'}, pids ${l.pids ?? '?'}`,
    `network: ${c.network ?? NETWORK}`,
    c.destroyed ? `destroyed · ${c.goneCheck ?? 'docker ps -a: gone'}` : 'destroyed: not confirmed',
    '',
    'Last self-tests on this server:',
    selftestLine('containment', selftests.containment),
    selftestLine('scenes', selftests.scenes),
    selftestLine('agent-loop', selftests.agentLoop),
    '',
  ].join('\n');
}

function visionText(v) {
  if (!v || v.verdict === 'skipped' || !v.model) return 'Not run for this run.';
  const rows = Array.isArray(v.pairs) ? v.pairs : [];
  const pick = v.verdict === 'fail' ? rows.find((r) => r.vision === 'cover_up' || r.vision === 'regressed') : rows.find((r) => r.evidence) ?? rows[0];
  const evidence = String(pick?.evidence ?? v.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300).replace(/[.\s]+$/, '');
  return `Second opinion · ${v.model} on ${v.provider ?? 'Vultr Serverless Inference'}: ${String(v.verdict).toUpperCase()}${evidence ? ` — ${evidence}` : ''}. Mantis's measurement decides.`;
}

/** The self-contained index.html of a published run: inline CSS, relative links, no script. */
export function runPageHtml({ task, receipt: r, images = [], selftests = {} }) {
  const k = r.counts ?? {};
  const g = r.gate ?? {};
  const c = r.containment ?? {};
  const approval = approvalText(task);
  const taskId = TASK_ID.test(String(r.taskId ?? task?.id ?? '')) ? String(r.taskId ?? task?.id) : null;
  const countRows = [
    ['Errors', `${int(k.errorsBefore)} → ${int(k.errorsAfter)}`],
    ['Warnings', `${int(k.warningsBefore)} → ${int(k.warningsAfter)}`],
    ['Fixed', int(k.fixed)], ['New', int(k.new)], ['Cover-ups (final)', int(k.coverUps)], ['Lost controls', int(k.lost)],
    ['Screens compared', Number.isFinite(k.cellsExpected) ? `${int(k.cellsCompared)} of ${int(k.cellsExpected)}` : int(k.cellsCompared ?? r.matrix?.cells)],
  ].map(([a, b]) => `<tr><th scope="row">${esc(a)}</th><td>${esc(b)}</td></tr>`).join('');
  const checkRows = (r.checks ?? []).map((ch) => `<tr class="${['reverted', 'lost', 'tamper', 'failed'].includes(ch.decision) ? 'warn' : ''}"><td>${esc(ch.check)}</td><td>${esc(DECISIONS[ch.decision] ?? ch.decision)}${ch.forced ? ' (forced)' : ''}${ch.reason ? `<br><span class="muted">${esc(ch.reason)}</span>` : ''}</td><td><code>${esc(ch.line ?? '')}</code></td><td>${esc(secText((ch.ms ?? NaN) / 1000))}</td></tr>`).join('')
    || '<tr><td colspan="4">No check was needed.</td></tr>';
  const modelRows = (r.models ?? []).map((m) => `<tr><td>${esc(m.role)}</td><td><code>${esc(m.id)}</code></td><td>${esc(m.provider ?? 'Vultr Serverless Inference')}</td><td>${esc(int(m.calls))}</td><td>${esc(`${int(m.promptTokens)} / ${int(m.completionTokens)} / ${int(m.reasoningTokens)}`)}</td><td>${esc(m.usd === null || m.usd === undefined ? 'cost n/a' : usdText(m.usd))}</td></tr>`).join('');
  const phases = Object.entries(r.time?.phases ?? {}).filter(([, s]) => Number.isFinite(s) && s > 0)
    .map(([name, s]) => `${esc(name)} ${esc(secText(s))}`).join(' · ');
  const imgs = images.map((name) => `<figure><a href="${esc(name)}"><img src="${esc(name)}" alt="${esc(IMAGE_ALT[name] ?? name)}" loading="lazy"></a><figcaption>${esc(IMAGE_ALT[name] ?? name)}</figcaption></figure>`).join('');
  const st = selftests;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Latest verified run · Mantis Ring</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f4;--card:#fff;--line:#e2e3dd;--text:#1b1f1d;--muted:#5b625e;--accent:#17734a;--soft:#e5f2ea;--warn:#9a5b00;--warnbg:#fbf0dc}
@media (prefers-color-scheme:dark){:root{--bg:#0f1211;--card:#161a18;--line:#2a302d;--text:#e6e9e7;--muted:#a2aaa5;--accent:#3ccf8e;--soft:#14281e;--warn:#f2b45a;--warnbg:#2c2213}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:28px 16px 56px}a{color:var(--accent)}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
.eyebrow{margin:0 0 18px;color:var(--muted);font-size:.92rem}.label{display:inline-block;margin:0;padding:3px 10px;border:1px solid var(--accent);border-radius:999px;color:var(--accent);font-size:.82rem;font-weight:600;letter-spacing:.02em}
h1{margin:10px 0 4px;font-size:1.9rem;line-height:1.2}h2{margin:34px 0 10px;font-size:1.1rem}
.line{margin:14px 0 6px;font:600 clamp(1.2rem,3.6vw,1.6rem)/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.note,.muted{color:var(--muted)}.approval{margin:14px 0 0;padding:10px 14px;border-radius:10px;background:var(--soft)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 16px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.95rem}th,td{padding:8px 10px 8px 0;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}tr:last-child th,tr:last-child td{border-bottom:0}
th{font-weight:600}tr.warn td{color:var(--warn);background:var(--warnbg)}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}figure{margin:0}figure img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}figcaption{margin-top:6px;color:var(--muted);font-size:.88rem}
pre{margin:0;padding:12px 0;white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
footer{margin-top:40px;color:var(--muted);font-size:.9rem}
</style>
</head>
<body>
<main>
<p class="eyebrow"><a href="/">Mantis Ring</a> · Latest verified run</p>
<p class="label">${esc(r.label)}</p>
<h1>${esc(task?.source?.label ?? r.source?.name ?? 'Sample project')}</h1>
<p class="line">${esc(r.line)}</p>
<p class="note">${esc(r.trust === 'repo-sandbox' ? r.trustNote : 'verified = re-measured by Mantis (no LLM) against the original baseline')}</p>
<p class="note">fixed = issues of the starting point that are gone · new = issues that were not there before · cover-ups = issues that only went away because their element was hidden, removed, shrunk or cut · lost = controls or headings that were visible at the start and are gone</p>
<p class="approval">${esc(approval)}</p>
${taskId ? `<p class="muted">The full step-by-step log of this run, every model call, tool call and check: <a href="/t/${esc(taskId)}">/t/${esc(taskId)}</a></p>` : ''}

<h2>Counts (final run against the starting point)</h2>
<div class="card"><table>${countRows}</table></div>

${imgs ? `<h2>Before and after</h2><div class="figs">${imgs}</div>` : ''}

<h2>Checks</h2>
<div class="card"><table><thead><tr><th>#</th><th>Decision</th><th>Mantis line</th><th>Time</th></tr></thead><tbody>${checkRows}</tbody></table></div>
<p class="muted">Cover-up gate ${g.enabled === false ? 'off (control run)' : 'on'} · cover-up attempts ${esc(int(g.coverUpAttempts ?? 0))} · tamper attempts ${esc(int(g.tamperAttempts ?? 0))} · rollbacks ${esc(int(g.reverts ?? 0))}</p>

<h2>Models</h2>
<div class="card"><table><thead><tr><th>Role</th><th>Model</th><th>Provider</th><th>Calls</th><th>Tokens in / out / reasoning</th><th>Cost (list price)</th></tr></thead><tbody>${modelRows || '<tr><td colspan="6">No model call.</td></tr>'}</tbody></table></div>
<p class="muted">Total: ${esc(int(r.tokens?.prompt))} prompt, ${esc(int(r.tokens?.completion))} completion and ${esc(int(r.tokens?.reasoning))} reasoning tokens · ${esc(r.usd === null || r.usd === undefined ? 'cost n/a' : usdText(r.usd))} at list price (Vultr catalogue); billing may differ.</p>

<h2>Second opinion</h2>
<p>${esc(visionText(r.vision))}</p>

<h2>The model's summary</h2>
<p class="muted">In its own words, not measured:</p>
<div class="card"><pre>${esc(r.summary?.text || '(no summary)')}</pre></div>

<h2>Time</h2>
<p>${esc(secText(r.time?.totalSec))} in total${phases ? ` · ${phases}` : ''}</p>

<h2>Containment</h2>
<div class="card"><table>
<tr><th scope="row">Runtime</th><td><code>${esc(c.runtime ?? 'unknown')}</code> (${esc(runtimeName(c.runtime))})</td></tr>
<tr><th scope="row">Sandbox</th><td><code>${esc(c.sandbox ?? 'unknown')}</code></td></tr>
<tr><th scope="row">Limits</th><td>${esc(`${sizeText(c.limits?.memory ?? '?')} memory · ${c.limits?.cpus ?? '?'} CPUs · ${c.limits?.pids ?? '?'} processes`)}</td></tr>
<tr><th scope="row">Network</th><td>${esc(c.network ?? NETWORK)}</td></tr>
<tr><th scope="row">After the run</th><td>${esc(c.destroyed ? `destroyed · ${c.goneCheck ?? 'docker ps -a: gone'}` : 'not confirmed')}</td></tr>
<tr><th scope="row">Self-tests</th><td>${esc([selftestLine('containment', st.containment), selftestLine('scenes', st.scenes), selftestLine('agent-loop', st.agentLoop)].join(' · '))}</td></tr>
</table></div>

<h2>Files</h2>
<p><a href="patch.txt">patch.txt</a> · <a href="receipt.json">receipt.json</a> · <a href="containment.txt">containment.txt</a></p>

<footer>Run ${esc(r.taskId ?? task?.id ?? '')} · started ${esc(utcText(r.startedAt))} · Mantis ${esc(r.mantis?.version ?? '')} compared it with ${esc(r.mantis?.comparedWith ?? 'the baseline run')} · prompts ${esc(r.promptVersion ?? '')}${r.promptVariant && r.promptVariant !== 'neutral' ? ` with the ${esc(r.promptVariant)} task message (a bench arm)` : ''}</footer>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// The page /latest/ shows before any run is published
// ---------------------------------------------------------------------------------------------

/** A styled stand-in for /latest/ while nothing is published: it says so and links to the demo and /status. */
export function placeholderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Latest verified run · Mantis Ring</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f4;--card:#fff;--line:#e2e3dd;--text:#1b1f1d;--muted:#5b625e;--accent:#17734a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1211;--card:#161a18;--line:#2a302d;--text:#e6e9e7;--muted:#a2aaa5;--accent:#3ccf8e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 56px}a{color:var(--accent)}h1{margin:8px 0 12px;font-size:1.7rem;line-height:1.25}
.eyebrow{margin:0;color:var(--muted);font-size:.92rem}.card{margin-top:20px;padding:16px 18px;background:var(--card);border:1px solid var(--line);border-radius:12px}
p{margin:0 0 10px}
</style>
</head>
<body>
<main>
<p class="eyebrow"><a href="/">Mantis Ring</a> · Latest verified run</p>
<h1>No verified run is published yet</h1>
<p>A run is published here only when Mantis measured it as a pass on the sample project, in a gVisor sandbox on Vultr, with the real model service, and the sandbox was confirmed destroyed afterwards.</p>
<div class="card">
<p><a href="/status">Status</a> shows the server live: the sandbox runtime, the model service, the last self-test results and today&#39;s spend.</p>
<p><a href="/">The home page</a> explains how a run works.</p>
</div>
</main>
</body>
</html>
`;
}

/**
 * At startup: while <publicDir>/latest is still the placeholder folder (not yet the symlink to a
 * published run), replace its bare page with placeholderHtml(). A published run is never touched.
 * @returns {'written'|'unchanged'|'published'|'missing'}
 */
export function refreshPlaceholder(publicDir) {
  const latest = path.join(publicDir, 'latest');
  const st = lstatOrNull(latest);
  if (!st) return 'missing';
  if (st.isSymbolicLink() || !st.isDirectory()) return 'published';
  const file = path.join(latest, 'index.html');
  const cur = lstatOrNull(file);
  if (cur && !cur.isFile()) return 'unchanged';
  const html = placeholderHtml();
  if (cur && cur.size === Buffer.byteLength(html) && readFileSync(file, 'utf8') === html) return 'unchanged';
  const tmp = path.join(latest, `.index.html.tmp-${process.pid}`);
  writeFileSync(tmp, html, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, file);
  return 'written';
}
