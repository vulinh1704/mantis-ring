// Settings for the web app and orchestrator. Constants live here (paths, the sample allowlist, the
// input lists, task caps), together with the few values an admin may change at run time through
// /admin/config (BUILD-SPEC §4.9). Overrides are validated, then kept in <STATE_DIR>/config.json so
// they survive a restart. Nothing in this file reads, stores or prints a secret.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Tasks, the spend ledger and the overrides. On the VM: /var/lib/ring-orch/state (the unit's WorkingDirectory). */
export const STATE_DIR = process.env.RING_STATE_DIR || path.resolve('state');
/** "Latest verified run" pages. Caddy serves <PUBLIC_DIR>/latest/ (/srv/ring-public on the VM). */
export const PUBLIC_DIR = process.env.RING_PUBLIC_DIR || path.resolve('.ring-public');
/** Docker runtime for task sandboxes: runsc (gVisor) on the VM. Unset means Docker's default, runc. */
export const RUNTIME = process.env.RING_RUNTIME || undefined;
/** Public address of the demo, used in the owner links that /admin/tasks hands out. */
export const PUBLIC_URL = (process.env.RING_PUBLIC_URL || 'https://104-156-252-200.sslip.io').replace(/\/+$/, '');
export const PROVIDER = 'Vultr Serverless Inference';

/**
 * Sample projects (§4.6). The model is never told their bugs were planted. Lumen (16 cells) is the
 * one anyone may run. Atlas (24 cells, demo/atlas) is the bench's harder sample, `adminOnly`: a
 * public request for it is refused as an unknown sample, /api/config never lists it, and its runs
 * never set the public ETA or reach /latest/. bench/grade-atlas.mjs grades its runs on the host.
 */
export const SAMPLES = {
  lumen: {
    label: 'Lumen (sample site)',
    dir: fileURLToPath(new URL('../demo/lumen/', import.meta.url)),
    routes: ['/', '/settings.html'],
    viewports: ['mobile', 'desktop'], schemes: ['light', 'dark'], locales: ['en', 'vi'],
  },
  atlas: {
    label: 'Atlas (invoicing app)',
    dir: fileURLToPath(new URL('../demo/atlas/', import.meta.url)),
    routes: ['/', '/pricing.html', '/account.html'],
    viewports: ['mobile', 'desktop'], schemes: ['light', 'dark'], locales: ['en', 'vi'],
    adminOnly: true,
  },
};

/** Whether a public run may use this sample: it exists and is not admin-only. */
export function isPublicSample(name) {
  return typeof name === 'string' && Object.hasOwn(SAMPLES, name) && SAMPLES[name].adminOnly !== true;
}

/** What a task may ask Mantis to measure. Public tasks always get mobile + desktop and both schemes. */
export const LOCALES = ['en', 'vi', 'de', 'fr', 'es', 'ja', 'ko', 'zh', 'pt', 'pseudo'];
export const VIEWPORTS = ['mobile', 'tablet', 'desktop'];
export const SCHEMES = ['light', 'dark'];
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'ultra'];

/** Task caps (§2.4): what every task gets by default. */
export const DEFAULT_CAPS = Object.freeze({
  maxChecks: 3, maxTurns: 36, maxTurnsPerCheck: 14, maxCallsPerTurn: 12, maxCompletionTokens: 8192,
  reasoning: Object.freeze({ effort: 'low', max_tokens: 2048 }),
  maxPromptTokens: 1_200_000, maxUsd: 0.60, wallClockSec: 900, lookTimeoutSec: 300,
});
/**
 * The range each cap may take, admin tasks included: [lowest, highest, integer?]. maxUsd must be
 * above 0 (the loop refuses 0), so its lowest value is one millionth of a dollar.
 */
export const CAP_RANGES = Object.freeze({
  maxChecks: [1, 3, true], maxTurns: [1, 60, true], maxTurnsPerCheck: [1, 20, true], maxCallsPerTurn: [1, 12, true],
  maxCompletionTokens: [256, 16384, true], maxPromptTokens: [1000, 3_000_000, true], maxUsd: [0.000001, 2, false],
  wallClockSec: [10, 2400, true], lookTimeoutSec: [30, 600, true],
});
/** A GitHub repository has to be cloned and installed, so it gets 20 minutes instead of 15. */
export const GITHUB_WALL_CLOCK_SEC = 1200;
export const HEAVY_SLOTS = 2;   // install, look and proof at once; two of them saturate the 4 vCPUs
export const MAX_QUEUED = 8;
export const BENCH_SEED = 7;    // admin tasks get a fixed seed so bench runs can be compared

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const FILE = path.join(STATE_DIR, 'config.json');

const DEFAULTS = Object.freeze({
  fixModel: 'deepseek-v4.1-flash-1017',       // D-1, until the bake-off picks one
  fallbackModel: 'minimax-m3.1-flash',
  visionModel: 'qwen3.8-27b',
  // The models with a pinned list price (agent/prices.mjs). The lead widens this to the catalogue's
  // tool-capable models with /admin/config; a model outside the list can never be picked by mistake.
  allowedModels: ['deepseek-v4.1-flash-1017', 'minimax-m3.1-flash', 'glm-5.3', 'glm-5.3-flash', 'qwen3.8-27b',
    'qwen3.8-flash-next', 'mimo-v2.6-flash'],
  modelSampling: {
    'deepseek-v4.1-flash-1017': { temperature: 1, topP: 1 },
    'minimax-m3.1-flash': { temperature: 1, topP: 0.95 },
    'qwen3.8-27b': { temperature: 1, topP: 0.95 },
    'glm-5.3': { temperature: 1 },
    'glm-5.3-flash': { temperature: 1 },
  },
  // D-5: a public route starts a task only once the owner opens its kind, through /admin/config only.
  publicSampleRuns: false,                    // the sample projects (SAMPLES): the home page's "Run sample"
  publicGithubRuns: false,                    // any public GitHub repository: opened on its own, later
  maxRunning: 2,
  caps: DEFAULT_CAPS,
  // §4.4, owner decision D6, with app/spend.mjs's key names. USD at list price; the token budget is
  // the public fallback for a model without a known price.
  spendCaps: {
    publicDayUsd: 5, adminDayUsd: 15, totalUsd: 60, taskUsd: 0.60, adminTaskUsdMax: 2,
    taskPromptTokens: 1_200_000, adminTaskPromptTokensMax: 3_000_000, publicUnpricedDayTokens: 3_000_000,
  },
});
// Highest value /admin/config accepts for each spend cap: a typo cannot lift the hard stop far.
const SPEND_RANGES = {
  publicDayUsd: 100, adminDayUsd: 100, totalUsd: 100, taskUsd: 2, adminTaskUsdMax: 2,
  taskPromptTokens: 3_000_000, adminTaskPromptTokensMax: 3_000_000, publicUnpricedDayTokens: 50_000_000,
};

/** A setting that cannot be used; the message says why, in a form fit for a 400 answer. */
export class ConfigError extends Error {}

export const isModelId = (s) => typeof s === 'string' && MODEL_ID.test(s);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inRange = (v, lo, hi, int) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi && (!int || Number.isInteger(v));

/** Check reasoning settings: null (off) or {effort, max_tokens}. */
export function checkReasoning(v) {
  if (v === null) return null;
  if (!isObject(v) || !EFFORTS.includes(v.effort) || !inRange(v.max_tokens, 0, 16384, true) || Object.keys(v).some((k) => k !== 'effort' && k !== 'max_tokens')) {
    throw new ConfigError(`reasoning must be null or {effort: ${EFFORTS.join('|')}, max_tokens: 0..16384}`);
  }
  return { effort: v.effort, max_tokens: v.max_tokens };
}

/** Check a partial caps object against CAP_RANGES and return it merged over `base`. Throws ConfigError. */
export function checkCaps(partial, base = DEFAULT_CAPS) {
  if (!isObject(partial)) throw new ConfigError('caps must be an object');
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(partial)) {
    if (key === 'reasoning') { out.reasoning = checkReasoning(value); continue; }
    const range = CAP_RANGES[key];
    if (!range) throw new ConfigError(`unknown cap: ${key}`);
    const [lo, hi, int] = range;
    if (!inRange(value, lo, hi, int)) throw new ConfigError(`caps.${key} must be ${int ? 'an integer' : 'a number'} from ${lo} to ${hi}`);
    out[key] = value;
  }
  return out;
}

/** Check sampling settings {temperature?, topP?, seed?}. Throws ConfigError. */
export function checkSampling(v, name = 'sampling') {
  if (!isObject(v)) throw new ConfigError(`${name} must be an object`);
  const out = {};
  for (const [key, value] of Object.entries(v)) {
    if (key === 'temperature' && inRange(value, 0, 2, false)) out.temperature = value;
    else if (key === 'topP' && inRange(value, 0, 1, false) && value > 0) out.topP = value;
    else if (key === 'seed' && inRange(value, 0, 2 ** 31 - 1, true)) out.seed = value;
    else throw new ConfigError(`${name}.${key} is not allowed here (temperature 0..2, topP 0..1, seed: a non-negative integer)`);
  }
  return out;
}

function checkModel(v, name) {
  if (!isModelId(v)) throw new ConfigError(`${name} must be a model id`);
  return v;
}

function checkSwitch(v, name) {
  if (typeof v !== 'boolean') throw new ConfigError(`${name} must be true or false`);
  return v;
}

/**
 * Until 4 Nov one switch, publicRuns, opened public runs on the samples and on any GitHub repository
 * at once. In a config.json that still has it, its value becomes publicSampleRuns (unless the file
 * names that too), so sample runs stay as they were; GitHub runs have a switch of their own, which
 * the old key never opens. In a /admin/config patch, publicRuns false still closes both; true is
 * refused, because it no longer says which kind to open.
 */
const LEGACY_PUBLIC = 'publicRuns';
const SAY_LEGACY_PUBLIC = 'publicRuns was split in two: set publicSampleRuns (the sample projects) and publicGithubRuns (any public GitHub repository); publicRuns false still closes both';

function checkSpendCaps(v) {
  if (!isObject(v)) throw new ConfigError('spendCaps must be an object');
  const out = {};
  for (const [key, value] of Object.entries(v)) {
    if (!(key in SPEND_RANGES)) throw new ConfigError(`unknown spend cap: ${key}`);
    if (!inRange(value, 0, SPEND_RANGES[key], false)) throw new ConfigError(`spendCaps.${key} must be a number from 0 to ${SPEND_RANGES[key]}`);
    out[key] = value;
  }
  return out;
}

// One check per setting. Each returns the clean value or throws ConfigError.
const CHECKS = {
  fixModel: (v) => checkModel(v, 'fixModel'),
  fallbackModel: (v) => checkModel(v, 'fallbackModel'),
  visionModel: (v) => (v === null ? null : checkModel(v, 'visionModel')),
  allowedModels: (v) => {
    if (!Array.isArray(v) || v.length === 0 || v.length > 40 || !v.every(isModelId)) throw new ConfigError('allowedModels must be a list of 1 to 40 model ids');
    return [...new Set(v)];
  },
  modelSampling: (v) => {
    if (!isObject(v)) throw new ConfigError('modelSampling must be an object of model id -> sampling');
    const out = {};
    for (const [model, s] of Object.entries(v)) out[checkModel(model, 'a modelSampling key')] = checkSampling(s, `modelSampling.${model}`);
    return out;
  },
  publicSampleRuns: (v) => checkSwitch(v, 'publicSampleRuns'),
  publicGithubRuns: (v) => checkSwitch(v, 'publicGithubRuns'),
  maxRunning: (v) => {
    if (!inRange(v, 1, 3, true)) throw new ConfigError('maxRunning must be 1, 2 or 3 (more than 3 live sandboxes is too tight on 16 GB)');
    return v;
  },
  caps: (v) => checkCaps(v, DEFAULT_CAPS),
  spendCaps: (v) => ({ ...DEFAULTS.spendCaps, ...checkSpendCaps(v) }),
};
// Settings whose value is an object: a patch changes only the keys it names.
const MERGED = new Set(['caps', 'spendCaps', 'modelSampling']);

function crossCheck(cfg) {
  for (const key of ['fixModel', 'fallbackModel']) {
    if (!cfg.allowedModels.includes(cfg[key])) throw new ConfigError(`${key} ${cfg[key]} is not in allowedModels`);
  }
}

let overrides = null;   // validated overrides, loaded from config.json on first use

function loadOverrides() {
  if (overrides) return overrides;
  overrides = {};
  let raw;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`config: cannot read ${FILE} (${err.code ?? err.message}); using the defaults`);
    return overrides;
  }
  let data;
  try { data = JSON.parse(raw); } catch { data = null; }
  if (!isObject(data)) {
    console.error(`config: ${FILE} is not a JSON object; using the defaults`);
    return overrides;
  }
  for (const [key, value] of Object.entries(data)) {
    if (key === LEGACY_PUBLIC) continue;
    try {
      if (!Object.hasOwn(CHECKS, key)) throw new ConfigError('unknown setting');
      overrides[key] = CHECKS[key](value);
    } catch (err) {
      console.error(`config: ignoring ${key} in ${FILE}: ${err.message}`);
    }
  }
  if (Object.hasOwn(data, LEGACY_PUBLIC)) {
    const v = data[LEGACY_PUBLIC];
    if (typeof v !== 'boolean') {
      console.error(`config: ignoring ${LEGACY_PUBLIC} in ${FILE}: it must be true or false`);
    } else if (Object.hasOwn(data, 'publicSampleRuns')) {
      console.error(`config: ${FILE} has both ${LEGACY_PUBLIC} and publicSampleRuns; ${LEGACY_PUBLIC} is ignored`);
    } else {
      overrides.publicSampleRuns = v;
      console.log(`config: ${FILE} has the old switch ${LEGACY_PUBLIC} (${v}): it now sets publicSampleRuns only; `
        + `publicGithubRuns is ${overrides.publicGithubRuns ?? DEFAULTS.publicGithubRuns}, and the file drops ${LEGACY_PUBLIC} at the next /admin/config change`);
    }
  }
  try {
    crossCheck({ ...DEFAULTS, ...overrides });
  } catch (err) {
    console.error(`config: ${err.message}; ignoring the model settings in ${FILE}`);
    for (const key of ['fixModel', 'fallbackModel', 'allowedModels']) delete overrides[key];
  }
  return overrides;
}

/** The settings in effect: defaults with the admin's overrides on top. A fresh copy each call. */
export function get() {
  return structuredClone({ ...DEFAULTS, ...loadOverrides() });
}

/**
 * Change settings (admin only). Unknown keys and invalid values throw ConfigError and change nothing.
 * Object settings are merged: {"caps":{"maxUsd":1.5}} changes one cap and keeps the rest. The old
 * switch {"publicRuns":false} closes both public switches; {"publicRuns":true} is refused.
 * @returns the settings in effect afterwards
 */
export function set(patch) {
  if (!isObject(patch) || Object.keys(patch).length === 0) throw new ConfigError('send a JSON object with at least one setting');
  const current = get();
  const next = { ...loadOverrides() };
  const { [LEGACY_PUBLIC]: legacy, ...rest } = patch;
  if (Object.hasOwn(patch, LEGACY_PUBLIC)) {
    if (legacy !== false) throw new ConfigError(SAY_LEGACY_PUBLIC);
    next.publicSampleRuns = false;
    next.publicGithubRuns = false;
  }
  for (const [key, value] of Object.entries(rest)) {
    if (!Object.hasOwn(CHECKS, key)) throw new ConfigError(`unknown setting: ${key}`);
    next[key] = CHECKS[key](MERGED.has(key) && isObject(value) ? { ...current[key], ...value } : value);
  }
  crossCheck({ ...DEFAULTS, ...next });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o750 });
  writeFileSync(`${FILE}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o640 });
  renameSync(`${FILE}.tmp`, FILE);
  overrides = next;
  return get();
}

/** Sampling for one model from the modelSampling table, plus the fixed bench seed for admin tasks. */
export function samplingFor(model, cfg, { bench = false } = {}) {
  const base = cfg.modelSampling?.[model] ?? { temperature: 1 };
  return bench ? { ...base, seed: BENCH_SEED } : { ...base };
}
