// Mantis Ring UI: the home page and the task page (/t/<id>), in plain browser JavaScript, no framework.
// Everything that comes from the server, a model or a repository is put on the page with textContent,
// never innerHTML. Live progress arrives over Server-Sent Events; when the stream fails (for example
// while the app restarts behind Caddy and answers 503), the page reconnects with backoff and polls the
// task every 5 s meanwhile. The owner token arrives once in the link (#owner=…), moves to
// sessionStorage and leaves the address bar.
(() => {
  'use strict';

  const PROVIDER = 'Vultr Serverless Inference';
  const STEPS = {
    queue: 'Queue', clone: 'Clone', install: 'Install (proxy)', look: 'Look', fix: 'Fix', gate: 'Gate',
    vision: 'Vision check', approve: 'Approve', cleanup: 'Cleanup',
  };
  const STATE_TEXT = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', timeout: 'Timed out', cancelled: 'Cancelled', interrupted: 'Interrupted' };
  const STATE_CLASS = { queued: 'is-info', running: 'is-info is-live', done: 'is-ok', failed: 'is-bad', timeout: 'is-warn', cancelled: '', interrupted: 'is-warn' };
  const DECISIONS = {
    accepted: 'Accepted', kept: 'Kept (gate off)', reverted: 'COVER-UP · rolled back', lost: 'LOST CONTROLS · rolled back',
    tamper: 'Tamper · rolled back', failed: 'Not measurable · rolled back',
  };
  const ROLLED_BACK = new Set(['reverted', 'lost', 'tamper', 'failed']);
  const VERDICTS = {
    pass: ['Pass', 'is-ok', 'Fixed, with nothing new, no cover-ups and no lost controls, on every screen measured at the start.'],
    partial: ['Partial', 'is-warn', 'Something was fixed, but something new broke, a control went missing, a cover-up remains or a screen was not compared.'],
    fail: ['No fix', 'is-bad', 'Nothing was fixed in the end.'],
    'no-issues': ['No issues', 'is-ok', 'Mantis found nothing to fix at the starting point.'],
  };
  const IMAGES = {
    'proof.png': 'Proof sheet made by Mantis: the starting point and the final run, side by side',
    'contact-before.png': 'Every screen at the starting point',
    'contact-after.png': 'Every screen after the fix',
  };
  const EVENT_TYPES = ['state', 'step', 'log', 'model', 'tool', 'look', 'gate', 'vision', 'receipt', 'done'];
  const FINISHED = new Set(['done', 'failed', 'timeout', 'cancelled', 'interrupted']);
  const MAX_LOG_LINES = 600;

  const $ = (id) => document.getElementById(id);
  /** A new element with an optional class and text. Text always goes in through textContent. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function link(href, text) {
    const a = el('a', null, text);
    a.href = href;
    return a;
  }

  const num = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : 'n/a');
  const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
  const usd = (n) => (typeof n === 'number' && Number.isFinite(n) ? (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`) : 'cost n/a');
  const secs = (s) => (!Number.isFinite(s) ? 'n/a' : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s * 10) / 10} s`);
  const msText = (ms) => secs(ms / 1000);
  const utc = (iso) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  };
  const etaText = (sec) => (sec === null || sec === undefined ? 'a few minutes' : `about ${Math.max(1, Math.round(sec / 60))} min`);
  const size = (s) => String(s ?? '?').replace(/^(\d+)g$/i, '$1 GB').replace(/^(\d+)m$/i, '$1 MB');

  const session = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* storage blocked: the token stays in memory */ } },
  };

  /** fetch + JSON. A non-2xx answer throws an Error with the server's own sentence and `status`. */
  async function getJson(url, options = {}) {
    const res = await fetch(url, { cache: 'no-store', ...options });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const err = new Error(body && typeof body.error === 'string' ? body.error : `The demo answered ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // ---------------------------------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------------------------------
  async function home() {
    let cfg;
    try {
      cfg = await getJson('/api/config');
    } catch {
      return; // the page reads fine without it; the button stays disabled
    }
    const models = [cfg.fixModel, cfg.visionModel].filter((m) => typeof m === 'string' && m);
    $('chip-models').textContent = models.length ? `${cfg.provider || PROVIDER} (${models.join(', ')})` : cfg.provider || PROVIDER;
    showLatest(cfg.latest);
    // Two switches on the server: runs of the sample, and runs on any public GitHub repository.
    const sample = Array.isArray(cfg.samples) ? cfg.samples[0] : null;
    const button = $('run-sample');
    if (cfg.publicSampleRuns === true && sample) {
      button.disabled = false;
      button.classList.add('primary');
      $('run-note').textContent = `${sample.label}. A run takes ${sample.etaText}, and you can follow every step live.`;
      button.addEventListener('click', () => startRun({ sample: sample.id }, button));
    } else {
      const note = cfg.publicGithubRuns === true ? 'Runs of the sample are not open right now.' : 'Live runs open soon.';
      $('run-note').textContent = note;
      button.title = note;
    }
    // The GitHub row is shown only while its switch is open. The server checks the address.
    if (cfg.publicGithubRuns === true) {
      const input = $('repo-url');
      const go = $('run-repo');
      $('repo-try').hidden = false;
      const start = () => { if (!go.disabled) startRun({ repo: input.value.trim() }, go); };
      go.addEventListener('click', start);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
    }
  }

  /** Step 1 of the judges' box: the published run's own line, or, before the first publish, where to look instead. */
  function showLatest(latest) {
    const note = $('latest-note');
    const go = $('latest-link');
    if (latest && typeof latest.line === 'string' && latest.line) {
      note.replaceChildren(el('span', null, 'Mantis measured: '), el('code', null, latest.line),
        document.createTextNode(`${latest.at ? ` · published ${utc(latest.at)}` : ''}. Its receipt, before-and-after screenshots, the models and their cost, and the patch.`));
      if (/^t_[0-9a-f]{32}$/.test(String(latest.taskId || ''))) note.append(document.createTextNode(' '), link(`/t/${latest.taskId}`, 'Step-by-step log.'));
      return;
    }
    note.textContent = 'No run is published yet: one appears here once Mantis measures a real run as a pass. Meanwhile, Status shows the server live.';
    go.textContent = 'Not published yet';
    go.removeAttribute('href');
    go.setAttribute('aria-disabled', 'true');
    go.classList.remove('primary');
  }

  /** Start a public run: `what` is {sample: <id>} or {repo: <address as typed>}. */
  async function startRun(what, button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Starting…';
    showRunError(null);
    try {
      const body = await getJson('/api/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(what),
      });
      if (!body || !/^t_[0-9a-f]{32}$/.test(body.id)) throw new Error('The demo did not return a run.');
      if (typeof body.ownerToken === 'string') session.set(`ring-owner:${body.id}`, body.ownerToken);
      location.assign(`/t/${body.id}`);
    } catch (err) {
      showRunError(err.message);
      button.disabled = false;
      button.textContent = label;
    }
  }

  function showRunError(text) {
    const box = $('run-error');
    box.replaceChildren();
    box.hidden = !text;
    if (text) box.append(el('span', null, `${text} `), link('/latest/', 'Open the latest verified run.'));
  }

  // ---------------------------------------------------------------------------------------------
  // Task page
  // ---------------------------------------------------------------------------------------------
  function taskPage(id) {
    $('home').hidden = true;
    $('task').hidden = false;
    const S = {
      id, task: null, owner: takeOwner(id), lastSeq: 0, lastEventAt: Date.now(), lastLog: '',
      es: null, connected: false, retry: 0, retryTimer: null, poll: null, finished: false,
      checks: new Map(), lines: new Map(),
    };
    $('t-log').append(el('li', 'empty', 'Nothing yet. Steps, model calls and measurements appear here as they happen.'));
    load(S);
    setInterval(() => renderNow(S), 5000);
  }

  /** The owner token: from #owner= once (then stored and removed from the address bar), else from sessionStorage. */
  function takeOwner(id) {
    const key = `ring-owner:${id}`;
    const m = /(?:^#|&)owner=([A-Za-z0-9_-]{20,200})(?:&|$)/.exec(location.hash);
    if (m) {
      session.set(key, m[1]);
      history.replaceState(null, '', location.pathname + location.search);
      return m[1];
    }
    return session.get(key);
  }

  async function load(S) {
    try {
      apply(S, await getJson(`/api/tasks/${S.id}`));
    } catch (err) {
      if (err.status === 404) { notFound(); return; }
      $('t-now').textContent = `This run could not be loaded (${err.message}) Trying again…`;
      setTimeout(() => load(S), 5000);
      return;
    }
    connect(S);
  }

  function notFound() {
    $('t-title').textContent = 'Run not found';
    $('t-state').hidden = true;
    $('t-steps').hidden = true;
    const now = $('t-now');
    now.replaceChildren(el('span', null, 'There is no run at this address. Runs are kept for 14 days. '), link('/latest/', 'Open the latest verified run.'));
  }

  /** Take a task record from the server and redraw what depends on it. */
  function apply(S, task) {
    S.task = { ...(S.task || {}), ...task };
    renderHead(S);
    if (!S.connected) stepsFromRecord(S);
    renderNow(S);
    renderActions(S);
    if (FINISHED.has(S.task.state) && 'receipt' in task) renderReceipt(S);
  }

  function renderHead(S) {
    const t = S.task;
    const label = t.source && t.source.label ? t.source.label : 'project';
    $('t-title').textContent = `Run · ${label}`;
    const parts = [`model ${t.model} on ${t.provider || PROVIDER}`, `cover-up gate ${t.gate ? 'on' : 'off'}`];
    // A bench run that gave the model another task message says so (public runs are always neutral).
    if (typeof t.promptVariant === 'string' && t.promptVariant !== 'neutral') parts.push(`${t.promptVariant} task message (bench arm)`);
    if (Number.isFinite(t.cells)) parts.push(`${t.cells} screens`);
    if (t.startedAt) parts.push(`started ${utc(t.startedAt)}`);
    else if (t.createdAt) parts.push(`submitted ${utc(t.createdAt)}`);
    $('t-sub').textContent = parts.join(' · ');
    const badge = $('t-state');
    badge.textContent = STATE_TEXT[t.state] || t.state || '';
    badge.className = `badge ${STATE_CLASS[t.state] || ''}`;
    document.title = `${STATE_TEXT[t.state] || 'Run'} · ${label} · Mantis Ring`;
  }

  function setStep(step, status) {
    const cls = { start: 'is-active', done: 'is-done', fail: 'is-fail', skip: 'is-skip' }[status];
    for (const li of document.querySelectorAll('#t-steps li')) {
      if (li.dataset.step !== step) continue;
      li.classList.remove('is-active', 'is-done', 'is-fail', 'is-skip');
      if (cls) li.classList.add(cls);
    }
  }

  /** Without the live stream, the step bar is rebuilt from the record: timed steps are done, the current one is active. */
  function stepsFromRecord(S) {
    const t = S.task;
    for (const step of Object.keys(t.stepTimes || {})) setStep(step, 'done');
    if (t.state === 'running' && t.step) setStep(t.step, 'start');
    if (t.state === 'done' && t.hasPatch) setStep('approve', t.approvedAt ? 'done' : 'start');
  }

  function renderNow(S) {
    const t = S.task;
    if (!t) return;
    let text;
    if (t.state === 'queued') {
      text = t.position ? `Waiting in line: position ${t.position}. Expected to finish in ${etaText(t.etaSec)}.` : 'Starting…';
    } else if (t.state === 'running') {
      text = `Now: ${STEPS[t.step] || 'working'}${S.lastLog ? ` — ${S.lastLog}` : ''}`;
    } else if (t.state === 'done') {
      text = doneText(t);
    } else {
      text = (t.result && t.result.error) || STATE_TEXT[t.state] || '';
    }
    if (!FINISHED.has(t.state)) {
      const quiet = Math.round((Date.now() - S.lastEventAt) / 1000);
      if (!S.connected) text += ' (Reconnecting to the live log; meanwhile this page checks the run every 5 s.)';
      else if (quiet > 30) text += ` (Still working: the last update came ${quiet} s ago. Installing, measuring and model calls can each take a while.)`;
    }
    $('t-now').textContent = text;
  }

  function doneText(t) {
    const r = t.receipt;
    const line = (t.result && t.result.line) || (r && r.line) || '';
    if (r && r.stopReason === 'inference' && !(r.counts && r.counts.fixed > 0)) return 'The model service did not answer, so the run stopped without changes.';
    if (t.approvedAt) return `Finished: ${line}. Approved at ${utc(t.approvedAt)}.`;
    if (t.hasPatch) return `Finished: ${line}. The patch is waiting for the owner's review.`;
    return line ? `Finished: ${line}.` : 'Finished.';
  }

  function button(text, primary) {
    const b = el('button', primary ? 'button primary' : 'button', text);
    b.type = 'button';
    return b;
  }

  function renderActions(S) {
    const t = S.task;
    const box = $('t-actions');
    box.replaceChildren();
    if (S.owner && (t.state === 'queued' || t.state === 'running')) {
      const b = button('Cancel run', false);
      b.addEventListener('click', () => cancelRun(S, b));
      box.append(b);
    }
    if (t.state !== 'done' || !t.hasPatch) return;
    if (t.approvedAt) {
      box.append(el('span', 'pill is-ok', `Approved · ${utc(t.approvedAt)}`));
      if (S.owner) {
        const d = button('Download patch', true);
        d.addEventListener('click', () => downloadPatch(S, d));
        box.append(d);
      }
    } else if (S.owner) {
      const a = button('Approve', true);
      let pass = null;
      if (t.approvalNeedsPassphrase) {
        // The owner link alone cannot prove a person approved: the server also asks for the owner's passphrase.
        pass = el('input', 'passphrase');
        pass.type = 'password';
        pass.autocomplete = 'off';
        pass.placeholder = 'Approval passphrase';
        pass.setAttribute('aria-label', 'Approval passphrase');
        pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') a.click(); });
        box.append(pass);
      }
      a.addEventListener('click', () => approve(S, a, pass));
      box.append(a, el('span', 'hint', 'Approving hands you the patch as a file. The demo never applies it anywhere.'));
    } else {
      box.append(el('span', 'hint', 'Waiting for the person who started this run to review and approve the patch.'));
    }
  }

  function actionError(text) {
    $('t-actions').append(el('p', 'notice is-bad hint', text));
  }

  async function approve(S, b, pass) {
    b.disabled = true;
    b.textContent = 'Approving…';
    try {
      const r = await getJson(`/api/tasks/${S.id}/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-ring-owner': S.owner },
        body: JSON.stringify(pass ? { passphrase: pass.value } : {}),
      });
      S.task.approvedAt = r.approvedAt;
      S.task.approvedWith = pass ? 'passphrase' : 'owner-link';
      setStep('approve', 'done');
      renderActions(S);
      renderNow(S);
      if (S.task.receipt) renderReceipt(S);
    } catch (err) {
      b.disabled = false;
      b.textContent = 'Approve';
      actionError(err.message);
    }
  }

  /** The patch comes through fetch (it needs the owner header), then a Blob URL the browser saves. */
  async function downloadPatch(S, b) {
    b.disabled = true;
    try {
      const res = await fetch(`/api/tasks/${S.id}/patch`, { headers: { 'x-ring-owner': S.owner }, cache: 'no-store' });
      if (!res.ok) {
        let text = `The demo answered ${res.status}.`;
        try { text = (await res.json()).error || text; } catch { /* keep the status text */ }
        throw new Error(text);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = link(url, 'patch');
      a.download = `${S.id}.patch`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      actionError(err.message);
    } finally {
      b.disabled = false;
    }
  }

  async function cancelRun(S, b) {
    if (!b.dataset.sure) {
      b.dataset.sure = '1';
      b.textContent = 'Click again to cancel the run';
      setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = 'Cancel run'; } }, 5000);
      return;
    }
    b.disabled = true;
    try {
      await getJson(`/api/tasks/${S.id}/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-ring-owner': S.owner }, body: '{}',
      });
      b.textContent = 'Cancelling…';
    } catch (err) {
      b.disabled = false;
      actionError(err.message);
    }
  }

  // --- live events -------------------------------------------------------------------------------
  function connect(S) {
    if (S.finished) return;
    const es = new EventSource(`/api/tasks/${S.id}/events${S.lastSeq ? `?after=${S.lastSeq}` : ''}`);
    S.es = es;
    es.addEventListener('open', () => {
      S.connected = true;
      S.retry = 0;
      stopPolling(S);
      renderNow(S);
    });
    es.addEventListener('hello', (e) => {
      const d = parse(e);
      if (d && d.task) apply(S, d.task);
    });
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        const seq = Number(e.lastEventId);
        if (seq > 0) {
          if (seq <= S.lastSeq) return; // already shown (a replay after a reconnect)
          S.lastSeq = seq;
        }
        S.lastEventAt = Date.now();
        const d = parse(e);
        if (d) onEvent(S, type, d);
      });
    }
    es.addEventListener('error', () => {
      S.connected = false;
      if (S.finished) { es.close(); return; }
      renderNow(S);
      startPolling(S);
      // CONNECTING: the browser retries by itself and sends Last-Event-ID. CLOSED (for example a 503
      // from Caddy while the app restarts): reconnect by hand, with backoff.
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        clearTimeout(S.retryTimer);
        const wait = Math.min(30, 2 ** S.retry) * 1000;
        S.retry += 1;
        S.retryTimer = setTimeout(() => connect(S), wait);
      }
    });
  }

  function parse(e) {
    try { return JSON.parse(e.data); } catch { return null; }
  }

  function startPolling(S) {
    if (S.poll) return;
    S.poll = setInterval(async () => {
      try {
        const task = await getJson(`/api/tasks/${S.id}`);
        apply(S, task);
        if (FINISHED.has(task.state)) stop(S);
      } catch { /* the next tick tries again */ }
    }, 5000);
  }

  function stopPolling(S) {
    clearInterval(S.poll);
    S.poll = null;
  }

  function stop(S) {
    S.finished = true;
    if (S.es) S.es.close();
    stopPolling(S);
    clearTimeout(S.retryTimer);
  }

  function onEvent(S, type, d) {
    const t = S.task;
    switch (type) {
      case 'state':
        t.state = d.state;
        if ('position' in d) t.position = d.position;
        if ('etaSec' in d) t.etaSec = d.etaSec;
        renderHead(S);
        renderNow(S);
        renderActions(S);
        break;
      case 'step':
        setStep(d.step, d.status);
        if (d.status === 'start' && d.step !== 'queue' && d.step !== 'cleanup') t.step = d.step;
        logLine('step', stepText(d), d.status === 'fail' ? 'k-bad' : '');
        renderNow(S);
        break;
      case 'log':
        S.lastLog = String(d.text ?? '');
        logLine('log', S.lastLog);
        renderNow(S);
        break;
      case 'model':
        logLine('model', modelText(d));
        break;
      case 'tool':
        logLine('tool', toolText(d), d.ok === false ? 'k-warn' : '');
        break;
      case 'look':
        if (d.kind === 'check' && d.compare && Number.isFinite(d.check)) S.lines.set(d.check, d.compare.line);
        logLine('look', lookText(d));
        break;
      case 'gate':
        addCheck(S, d);
        logLine('gate', gateText(d), d.decision === 'accepted' || d.decision === 'kept' ? '' : 'k-warn');
        break;
      case 'vision':
        logLine('vision', visionText(d));
        break;
      case 'receipt':
        logLine('receipt', `Receipt: ${d.line}${'usd' in d ? ` · ${usd(d.usd)}` : ''}`);
        break;
      case 'done':
        logLine('done', d.status === 'done' ? 'Run finished.' : `Run ended: ${d.error || STATE_TEXT[d.status] || d.status}`);
        finish(S);
        break;
      default:
        break;
    }
  }

  /** The run ended: stop listening and load the final record (state, receipt, patch). */
  async function finish(S) {
    stop(S);
    try {
      apply(S, await getJson(`/api/tasks/${S.id}`));
    } catch {
      renderHead(S);
      renderNow(S);
    }
  }

  function logLine(kind, text, extra = '') {
    const list = $('t-log');
    const empty = list.querySelector('.empty');
    if (empty) empty.remove();
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const li = el('li', `k-${kind} ${extra}`.trim());
    li.append(el('span', 'kind', kind), el('span', 'text', text));
    list.append(li);
    while (list.children.length > MAX_LOG_LINES) list.firstElementChild.remove();
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  function stepText(d) {
    const name = STEPS[d.step] || d.step;
    if (d.status === 'start' && d.note) return `${name}: ${d.note}`;
    const what = { start: 'started', done: 'done', fail: 'failed', skip: 'skipped' }[d.status] || d.status;
    return `${name} ${what}${Number.isFinite(d.ms) ? ` (${msText(d.ms)})` : ''}${d.note ? `: ${d.note}` : ''}`;
  }

  function modelText(d) {
    const calls = Array.isArray(d.calls) && d.calls.length ? ` · ${d.calls.join(', ')}` : '';
    const ending = d.finishReason && d.finishReason !== 'tool_calls' && d.finishReason !== 'stop' ? ` · ended: ${d.finishReason}` : '';
    return `Turn ${d.turn ?? '?'} · ${d.model} on ${d.provider || PROVIDER} · ${msText(d.ms)} · ${num(d.promptTokens)} in / ${num(d.completionTokens)} out tokens · ${usd(d.usd)}${calls}${ending}`;
  }

  function toolText(d) {
    return `${d.name}${d.target ? ` ${d.target}` : ''} · ${d.ok === false ? 'error' : 'ok'}${d.note ? ` · ${d.note}` : ''}`;
  }

  function lookText(d) {
    const what = d.kind === 'baseline' ? 'Starting point' : d.kind === 'verify' ? 'Verify run' : `Check ${d.check}`;
    const line = d.compare && d.compare.line ? `${d.compare.line} · ` : '';
    return `${what}: ${line}${num(d.errors)} errors, ${num(d.warnings)} warnings on ${num(d.cells)} screens${Number.isFinite(d.ms) ? ` (${msText(d.ms)})` : ''}`;
  }

  function gateText(d) {
    const covers = Array.isArray(d.coverUps) && d.coverUps.length ? ` · ${d.coverUps.map((c) => `${c.type} on ${c.selector}`).join('; ')}` : '';
    const lost = Array.isArray(d.lost) && d.lost.length ? ` · gone: ${d.lost.map((l) => l.control || l.selector || 'a control').join('; ')}` : '';
    const hits = Array.isArray(d.tamperHits) && d.tamperHits.length ? ` · ${d.tamperHits.join(', ')}` : '';
    return `Check ${d.check}: ${DECISIONS[d.decision] || d.decision}${d.restoredTo ? `; files back to ${d.restoredTo}` : ''}${d.reason ? ` (${d.reason})` : ''}${covers}${lost}${hits}`;
  }

  function visionText(v) {
    if (!v || !v.model || v.verdict === 'skipped') return 'Second opinion: not run for this run.';
    const pairs = Array.isArray(v.pairs) ? v.pairs : [];
    const pick = v.verdict === 'fail' ? pairs.find((p) => p.vision === 'cover_up' || p.vision === 'regressed') : pairs.find((p) => p.evidence);
    const evidence = pick && pick.evidence ? ` — ${String(pick.evidence).slice(0, 300).replace(/[.\s]+$/, '')}` : '';
    return `Second opinion · ${v.model} on ${v.provider || PROVIDER}: ${String(v.verdict).toUpperCase()}${evidence}. Mantis's measurement decides.`;
  }

  /** One check row: its number, the gate's decision (a rollback stands out) and Mantis's line. */
  function checkItem(d, line) {
    const li = el('li', ROLLED_BACK.has(d.decision) ? 'check is-coverup' : 'check');
    li.append(
      el('span', 'check-n', `Check ${d.check}`),
      el('span', 'decision', `${DECISIONS[d.decision] || d.decision}${d.forced ? ' (forced)' : ''}`),
      el('code', 'check-line', line || d.reason || ''),
    );
    return li;
  }

  /** Live checks. Once the receipt is shown, the checks are listed inside it instead. */
  function addCheck(S, d) {
    if (!Number.isFinite(d.check)) return;
    const item = checkItem(d, d.line || S.lines.get(d.check));
    const old = S.checks.get(d.check);
    if (old) old.replaceWith(item);
    else $('t-check-rows').append(item);
    S.checks.set(d.check, item);
    if (!(S.task && S.task.receipt)) $('t-checks').hidden = false;
  }

  // --- receipt -----------------------------------------------------------------------------------
  function table(head, rows) {
    const wrap = el('div', 'table-wrap');
    const t = el('table');
    const tr = el('tr');
    for (const h of head) tr.append(el('th', null, h));
    const thead = el('thead');
    thead.append(tr);
    const tbody = el('tbody');
    for (const r of rows) {
      const row = el('tr');
      for (const cell of r) row.append(el('td', null, cell));
      tbody.append(row);
    }
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }

  function diffClass(line) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
    if (line.startsWith('@@')) return 'hunk';
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    return '';
  }

  function renderReceipt(S) {
    const t = S.task;
    const r = t.receipt;
    const box = $('t-receipt');
    box.replaceChildren();
    box.hidden = !r;
    if (!r) return;

    const head = el('div', 'receipt-head');
    const label = String(r.label || '');
    head.append(el('h2', null, 'Receipt'), el('span', `pill ${label.startsWith('REAL RUN') ? 'is-ok' : 'is-info'}`, label || 'no label'));
    box.append(head, el('p', 'receipt-line', r.line));
    const v = VERDICTS[r.verdict];
    if (v) {
      const p = el('p');
      p.append(el('span', `pill ${v[1]}`, v[0]), document.createTextNode(` ${v[2]}`));
      box.append(p);
    }
    // A GitHub repo's own code ran next to the checker, so its receipt says so instead of "verified" (§7 #8).
    box.append(r.trust === 'repo-sandbox'
      ? el('p', 'notice is-warn', r.trustNote || "Measured inside the repo's own sandbox: the repo's code ran next to the checker, so this result is not independently verified.")
      : el('p', 'verified', 'Verified = re-measured by Mantis (no LLM) against the original baseline.'));
    const k = r.counts || {};
    if (r.stopReason === 'inference') {
      box.append(el('p', 'notice is-warn', k.fixed > 0
        ? 'The model service stopped answering, so the run ended early. The changes measured before that are kept.'
        : 'The model service did not answer, so the run stopped without changes.'));
    }

    const facts = el('div', 'facts');
    const tokens = r.tokens ? (r.tokens.prompt || 0) + (r.tokens.completion || 0) : NaN;
    for (const [name, value] of [
      ['Errors', `${num(k.errorsBefore)} → ${num(k.errorsAfter)}`],
      ['Warnings', `${num(k.warningsBefore)} → ${num(k.warningsAfter)}`],
      ['Screens compared', Number.isFinite(k.cellsExpected) ? `${num(k.cellsCompared)} of ${num(k.cellsExpected)}` : num(k.cellsCompared ?? (r.matrix && r.matrix.cells))],
      ['Time', secs(r.time && r.time.totalSec)],
      ['Tokens', num(tokens)],
      ['Model cost', usd(r.usd)],
    ]) {
      const f = el('div', 'fact');
      f.append(el('span', 'label', name), el('span', 'value', value));
      facts.append(f);
    }
    box.append(facts);

    const g = r.gate || {};
    box.append(el('h3', null, 'Checks'));
    if (Array.isArray(r.checks) && r.checks.length) {
      const list = el('ol', 'checks');
      for (const ch of r.checks) list.append(checkItem(ch, ch.line));
      box.append(list);
    }
    box.append(el('p', 'muted', `Cover-up gate ${g.enabled === false ? 'off (control run)' : 'on'} · ${plural(g.coverUpAttempts || 0, 'cover-up attempt')}${g.lostAttempts ? ` · ${plural(g.lostAttempts, 'check')} with lost controls` : ''} · ${plural(g.tamperAttempts || 0, 'tamper attempt')} · ${plural(g.reverts || 0, 'rollback')}.`));
    $('t-checks').hidden = true;

    if (Array.isArray(r.models) && r.models.length) {
      box.append(el('h3', null, 'Models'));
      box.append(table(['Role', 'Model', 'Provider', 'Calls', 'Tokens in / out / reasoning', 'Cost (list price)'], r.models.map((m) => [
        m.role, m.id, m.provider || PROVIDER, num(m.calls), `${num(m.promptTokens)} / ${num(m.completionTokens)} / ${num(m.reasoningTokens)}`, usd(m.usd),
      ])));
      box.append(el('p', 'muted', 'Costs are list prices from the Vultr catalogue; billing may differ.'));
    }

    if (r.vision && r.vision.model && r.vision.verdict !== 'skipped') {
      box.append(el('h3', null, 'Second opinion'), el('p', null, visionText(r.vision)));
    }

    if (r.summary && r.summary.text) {
      box.append(el('h3', null, "The model's summary"), el('p', 'muted', 'In its own words, not measured:'), el('blockquote', 'quote', r.summary.text));
    }

    const images = Object.keys(IMAGES).filter((name) => Array.isArray(t.files) && t.files.includes(name));
    if (images.length) {
      box.append(el('h3', null, 'Before and after'));
      const figs = el('div', 'figs');
      for (const name of images) {
        const src = `/api/tasks/${S.id}/files/${name}`;
        const fig = el('figure');
        const a = link(src, '');
        const img = el('img');
        img.src = src;
        img.alt = IMAGES[name];
        img.loading = 'lazy';
        a.append(img);
        fig.append(a, el('figcaption', null, IMAGES[name]));
        figs.append(fig);
      }
      box.append(figs);
    }

    if (t.diff && typeof t.diff.text === 'string') {
      box.append(el('h3', null, 'The patch'));
      box.append(el('p', 'muted', t.approvedAt
        ? `${t.approvedWith === 'passphrase' ? "Approved by the owner, with the owner's approval passphrase." : 'Approved with the owner link.'} Nothing was applied anywhere by the demo.`
        : 'Shown for review. The owner gets it as a file only after approving; nothing is applied anywhere.'));
      const pre = el('pre', 'diff');
      for (const line of t.diff.text.replace(/\n$/, '').split('\n')) pre.append(el('span', diffClass(line), line || ' '));
      if (t.diff.truncated) pre.append(el('span', 'meta', `… cut here; the full patch has ${num(t.diff.bytes)} bytes.`));
      box.append(pre);
    }

    const c = r.containment;
    if (c) {
      box.append(el('h3', null, 'Containment'));
      const dl = el('dl', 'kv-list');
      const l = c.limits || {};
      for (const [name, value] of [
        ['Runtime', c.runtime === 'runsc' ? 'gVisor (runsc)' : c.runtime || 'unknown'],
        ['Sandbox', c.sandbox || 'unknown'],
        ['Limits', `${size(l.memory)} memory · ${l.cpus ?? '?'} CPUs · ${l.pids ?? '?'} processes`],
        ['Network', c.network || 'unknown'],
        ['After the run', c.destroyed ? `destroyed · ${c.goneCheck || 'docker ps -a: gone'}` : 'not confirmed'],
      ]) dl.append(el('dt', null, name), el('dd', null, value));
      box.append(dl);
    }
  }

  // ---------------------------------------------------------------------------------------------
  const route = /^\/t\/(t_[0-9a-f]{32})\/?$/.exec(location.pathname);
  if (route) taskPage(route[1]);
  else home();
})();
