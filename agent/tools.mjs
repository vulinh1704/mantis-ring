// The tools Ring's model can call, and how each one runs inside the task's sandbox.
// Every tool touches only the copy of the project under /work/app, through `docker exec`. The
// model's values reach fixed scripts as separate arguments, never spliced into a shell string, so
// the model has no shell: it cannot run commands, reach the network or read outside the project.
// Paths are checked twice: here (safePath), and inside the sandbox after symlinks are resolved,
// because a repo can ship symlinks. Output is capped inside the sandbox before it reaches the host,
// and every tool resolves to a plain string; a refusal reads "error: <one sentence>".
// The schemas are the same in both gate arms (frozen), and parseToolCall checks arguments against them.
import path from 'node:path/posix';
import { APP_DIR, sh } from '../runner/run-task.mjs';

const MAX_OUTPUT = 12_000; // characters returned to the model per tool call
const MAX_PATH = 240; // characters in a path the model gives
const READ_MAX_BYTES = 2 * 2 ** 20; // read_file refuses bigger files
const EDIT_MAX_BYTES = 2 ** 20; // replace_in_file refuses bigger files
const MAX_WRITE_CHARS = 200_000; // write_file content, replace_in_file new_text
const READ_SPAN = 400; // lines read_file returns by default
const MAX_LINE = 2000; // read_file cuts longer lines (bytes, as awk counts them)
const READ_OUT_BYTES = 200_000; // read_file output cap inside the sandbox
const LIST_MAX = 400; // files list_files returns
const SEARCH_MAX = 80; // matches search_code returns
const SEARCH_LINE = 300; // characters per search_code match
const SKIP_DIRS = ['node_modules', '.git', '.mantis', 'dist', 'build', '.next'];
// The loop never reinstalls dependencies, so these files only matter to installs, the package
// manager and git; the model may read them but never change them.
const NO_WRITE = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'bun.lock', '.npmrc', '.yarnrc', '.yarnrc.yml', '.gitattributes', '.gitmodules', '.gitignore']);
const SECRET_NAME = /^\.env(\..*)?$/;
// Every script runs under `timeout` inside the sandbox; the host waits a little longer than that.
const IN_BOX_TIMEOUT = ['timeout', '-k', '2', '15'];
const EXEC_TIMEOUT_MS = 20_000;
const EXEC_MAX_BYTES = 2 ** 20; // host-side cap on what a script may print; the scripts print far less
const TOO_MANY = 'too many files changed in this task';
const CUT_NOTE = `… (cut at ${MAX_OUTPUT} characters)`;

/** Freeze an object and everything in it, so no caller can change a schema for one arm only. */
function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

export const TOOL_SCHEMAS = deepFreeze([
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the files of the project (or of one folder in it), with their sizes. Dependency and build folders are left out.',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string', description: 'Folder relative to the project root. Default: the root.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file of the project with line numbers. Long files can be read in parts.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root, e.g. "src/styles.css".' },
          from_line: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
          to_line: { type: 'integer', description: 'Last line to return. Default: 400 lines after from_line.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Find a text or regular expression (POSIX extended) in the project files. Returns file:line:text matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'What to look for, e.g. "#promo-banner" or "nav-links".' },
          file_glob: { type: 'string', description: 'Only search files whose name matches, e.g. "*.css". Default: all files.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Edit a file by replacing an exact piece of its text. old_text must appear exactly once in the file (include enough surrounding lines to make it unique). Whitespace must match.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          old_text: { type: 'string', description: 'The exact text to replace.' },
          new_text: { type: 'string', description: 'The text to put in its place.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file, or overwrite a small file completely. Prefer replace_in_file for changes to existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          content: { type: 'string', description: 'The whole new content of the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_ui',
      // The same text in both gate arms: it must not promise a revert that Gate OFF never makes.
      description: 'Measure the project again after your edits: every route, screen size, colour scheme and language in the task. Returns what is fixed, what is new and what is still open, compared with the starting point. Each call uses one of your limited checks.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'End the task. Give an honest summary for the human reviewer: what you fixed and how, what is still broken and why you left it.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'A few sentences, plain language.' } },
        required: ['summary'],
      },
    },
  },
]);

const SCHEMA_BY_NAME = new Map(TOOL_SCHEMAS.map((s) => [s.function.name, s.function.parameters]));
export const FILE_TOOL_NAMES = Object.freeze(['list_files', 'read_file', 'search_code', 'replace_in_file', 'write_file']);
export const WRITE_TOOL_NAMES = Object.freeze(['replace_in_file', 'write_file']);

/** A refusal the model should read: its message is one plain sentence, without a host path. */
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Check a path the model gave and return it as an absolute path under /work/app, or throw a
 * ToolError with one sentence the model can act on. This is the first of two checks: every tool
 * checks again inside the sandbox, after symlinks are resolved.
 * @param {unknown} p  relative to the project root, e.g. "src/styles.css"
 * @param {{allowRoot?: boolean, forWrite?: boolean}} [o]  allowRoot: an empty path or "." means the
 *   project root (list_files). forWrite: also refuse package-manager and git files (NO_WRITE).
 * @returns {string}
 */
export function safePath(p, { allowRoot = false, forWrite = false } = {}) {
  if (p === undefined || p === null || (typeof p === 'string' && p.trim() === '')) {
    if (allowRoot) return APP_DIR;
    throw new ToolError('path is required');
  }
  if (typeof p !== 'string') throw new ToolError('path must be a string');
  if (p.length > MAX_PATH) throw new ToolError(`the path is longer than ${MAX_PATH} characters`);
  if (/[\x00-\x1f\x7f\\]/.test(p)) throw new ToolError('the path contains a backslash or a control character; use forward slashes');
  const t = p.trim();
  if (t.startsWith('~')) throw new ToolError('paths are relative to the project root, so ~ cannot be used');
  if (t.startsWith('/')) throw new ToolError('paths are relative to the project root: write styles.css, not /styles.css');
  const rel = path.normalize(t).replace(/\/+$/, '');
  if (rel === '' || rel === '.') {
    if (allowRoot) return APP_DIR;
    throw new ToolError('that is the project folder; give the path of a file');
  }
  if (rel === '..' || rel.startsWith('../')) throw new ToolError('that path leaves the project');
  const parts = rel.split('/');
  if (parts.some((s) => SKIP_DIRS.includes(s))) throw new ToolError('that folder is off limits (dependencies, build output or version control)');
  const base = parts[parts.length - 1];
  if (SECRET_NAME.test(base)) throw new ToolError('files that may hold secrets (.env) are off limits');
  if (forWrite && NO_WRITE.has(base)) throw new ToolError(`${base} cannot be changed: dependencies are not reinstalled during the task`);
  return `${APP_DIR}/${rel}`;
}

/** The project-relative form of an absolute path from safePath(). */
const relOf = (abs) => (abs === APP_DIR ? '.' : abs.slice(APP_DIR.length + 1));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Check raw arguments against a tool's schema: string properties must be strings, integer ones
 * are coerced (a numeric string is accepted, the fraction dropped), required ones must be there.
 * Unknown properties are dropped. Returns {args} or {error}.
 */
function checkArgs(name, raw) {
  const schema = SCHEMA_BY_NAME.get(name);
  if (!schema) return { error: `unknown tool ${name}` };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'arguments must be a JSON object' };
  const args = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let v = raw[key];
    if (prop.type === 'integer' && typeof v === 'string' && v.trim() === '') v = undefined;
    if (v === undefined || v === null) {
      if (schema.required?.includes(key)) return { error: `${key} is required` };
      continue;
    }
    if (prop.type === 'string' && typeof v !== 'string') return { error: `${key} must be a string` };
    if (prop.type === 'integer') {
      const n = typeof v === 'string' ? Number(v.trim()) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { error: `${key} must be a whole number` };
      v = Math.trunc(n);
    }
    args[key] = v;
  }
  return { args };
}

/**
 * Read one tool call from an assistant message. `function.arguments` may be a JSON string or an
 * object; an empty string or JSON null means no arguments. Arguments are type-checked against
 * TOOL_SCHEMAS. A stray "functions." before the name (some open models write it) is dropped.
 * The `error` is one sentence without the "error: " prefix: the loop replies `error: ${error}`.
 * @param {{id?: string, function?: {name?: string, arguments?: string|object}}} call
 * @returns {{id: string, name: string, args: object} | {id: string, name: string, error: string}}
 */
export function parseToolCall(call) {
  const id = call?.id == null ? '' : String(call.id);
  const fn = call?.function;
  // A name is echoed back to the model, so keep it short and printable.
  const name = typeof fn?.name === 'string'
    ? fn.name.trim().replace(/^functions\./, '').replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 64)
    : '';
  if (!name) return { id, name, error: 'the tool call has no tool name' };
  if (!SCHEMA_BY_NAME.has(name)) return { id, name, error: `unknown tool ${name}` };
  let raw = fn.arguments;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    raw = {};
  } else if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
      // Some models encode the arguments twice: a JSON string that holds the JSON object.
      if (typeof raw === 'string') raw = JSON.parse(raw);
    } catch {
      return { id, name, error: 'arguments are not valid JSON' };
    }
    if (raw === null) raw = {};
  }
  const checked = checkArgs(name, raw);
  return checked.error ? { id, name, error: checked.error } : { id, name, args: checked.args };
}

// ---- Scripts that run inside the sandbox ----------------------------------------------------------
// Each one gets $1 = the project root and $2.. = the tool's values (positional, never spliced in).
// Exit codes: 3 leaves the project, 4 missing, 5 wrong kind of file, 6 too large, 7 off-limits folder,
// 8 secrets-looking name, 9 symlink, 10 hard link, 11 would create a file it may not, 12 binary,
// 13 could not create the folder, 14 the write itself failed, 20 search fell back to plain text.

const SKIP_CASE = SKIP_DIRS.map((d) => `*/${d}/*`).join('|');

// Resolve $2 with realpath -m (every symlink followed, missing parts allowed) and refuse what lands
// outside the project, in a skipped folder or on a secrets-looking name. `bad` drains stdin before
// exiting, so the host never writes file content into a closed pipe.
const RESOLVE = [
  'R=$1; f=$2',
  'bad() { cat > /dev/null; exit "$1"; }',
  'p=$(realpath -m -- "$f") || bad 3',
  'case "$p" in "$R"|"$R"/*) ;; *) bad 3 ;; esac',
  'case "$p" in *[[:cntrl:]]*) bad 3 ;; esac',
  'rest=${p#"$R"}',
  `case "$rest/" in ${SKIP_CASE}) bad 7 ;; esac`,
  'case "${p##*/}" in .env|.env.*) bad 8 ;; esac',
];

// list_files: $2 = folder. Prints "path<TAB>bytes" relative to the project root, sorted, at most
// LIST_MAX + 1 lines of at most 400 bytes (a deeper path is of no use: safePath() refuses it anyway).
const LIST_SCRIPT = [
  ...RESOLVE,
  '[ -e "$p" ] || exit 4',
  '[ -d "$p" ] || exit 5',
  'cd -- "$R" || exit 4',
  `find ".$rest" -type d \\( ${SKIP_DIRS.map((d) => `-name ${sh(d)}`).join(' -o ')} \\) -prune -o -type f ! -name .env ! -name '.env.*' -printf '%p\\t%s\\n' 2> /dev/null | sed 's|^\\./||' | cut -c1-400 | LC_ALL=C sort | head -n ${LIST_MAX + 1}`,
].join('\n');

// read_file: $2 = file, $3/$4 = first/last line. First line out: the file's line count; then the
// numbered lines, each cut at MAX_LINE, a trailing CR dropped, the whole capped at READ_OUT_BYTES.
const READ_SCRIPT = [
  ...RESOLVE,
  '[ -e "$p" ] || exit 4',
  '[ -f "$p" ] || exit 5',
  's=$(stat -c %s -- "$p") || exit 4',
  `[ "$s" -le ${READ_MAX_BYTES} ] || exit 6`,
  "n=$(head -c 8000 -- \"$p\" | tr -d -c '\\000' | wc -c)",
  '[ "$n" -eq 0 ] || exit 12',
  "awk 'END { print NR }' \"$p\" || exit 4",
  `awk -v a="$3" -v b="$4" 'NR > b + 0 { exit } NR >= a + 0 { sub(/\\r$/, ""); if (length($0) > ${MAX_LINE}) printf "%5d  %s ... [line cut at ${MAX_LINE} characters]\\n", NR, substr($0, 1, ${MAX_LINE}); else printf "%5d  %s\\n", NR, $0 }' "$p" | head -c ${READ_OUT_BYTES}`,
].join('\n');

// replace_in_file, before reading: $2 = file. Prints the real path (symlinked folders resolved) of a
// regular, non-symlink file of at most EDIT_MAX_BYTES. box.readFile() then reads that path.
const EDIT_TARGET_SCRIPT = [
  ...RESOLVE,
  '[ ! -L "$f" ] || exit 9',
  '[ -e "$p" ] || exit 4',
  '[ -f "$p" ] || exit 5',
  's=$(stat -c %s -- "$p") || exit 4',
  `[ "$s" -le ${EDIT_MAX_BYTES} ] || exit 6`,
  'printf \'%s\\n\' "${p#"$R"/}"',
].join('\n');

// Writes: $2 = file, $3 = 1 if the file may be created, content on stdin. The parent folder must
// resolve inside the project, the file must not be a symlink or a hard link. Just before writing it
// prints "new|old" and the real path: from then on the file may change, even if the write fails.
const WRITE_SCRIPT = [
  ...RESOLVE,
  '[ "$p" != "$R" ] || bad 5',
  'd=$(realpath -m -- "$(dirname -- "$f")") || bad 3',
  'case "$d" in "$R"|"$R"/*) ;; *) bad 3 ;; esac',
  '[ ! -L "$f" ] || bad 9',
  'if [ -e "$p" ]; then',
  '  [ -f "$p" ] || bad 5',
  '  [ "$(stat -c %h -- "$p")" -le 1 ] || bad 10',
  '  st=old',
  'else',
  '  [ "$3" = 1 ] || bad 11',
  '  st=new',
  'fi',
  '[ ! -e "$d" ] || [ -d "$d" ] || bad 5',
  'mkdir -p -- "$d" || bad 13',
  'printf \'%s\\n%s\\n\' "$st" "${p#"$R"/}"',
  'cat > "$p" || exit 14',
].join('\n');

// search_code: $2 = pattern, $3 = file-name glob or "". grep -r does not follow symlinks; skipped
// folders and .env files are left out. A pattern that is not a valid extended regular expression is
// searched as plain text, and the exit code 20 says so.
const SEARCH_EXCLUDES = [...SKIP_DIRS.map((d) => `--exclude-dir=${sh(d)}`), '--exclude=.env', `--exclude=${sh('.env.*')}`].join(' ');
const SEARCH_SCRIPT = [
  'R=$1; pat=$2; glob=$3',
  'cd -- "$R" || exit 4',
  'mode=-E',
  'printf \'\' | grep -E -e "$pat" > /dev/null 2>&1',
  '[ $? -ne 2 ] || mode=-F',
  'if [ -n "$glob" ]; then',
  `  grep -rnIs "$mode" ${SEARCH_EXCLUDES} --include="$glob" -e "$pat" | cut -c1-${SEARCH_LINE} | head -n ${SEARCH_MAX + 1}`,
  'else',
  `  grep -rnIs "$mode" ${SEARCH_EXCLUDES} -e "$pat" | cut -c1-${SEARCH_LINE} | head -n ${SEARCH_MAX + 1}`,
  'fi',
  '[ "$mode" = -E ] || exit 20',
].join('\n');

// What the exit codes mean to the model, unless a tool says it better.
const REFUSALS = {
  3: 'that path leaves the project',
  4: 'no such file or folder',
  5: 'that is not a regular file',
  6: 'the file is too large',
  7: 'that folder is off limits (dependencies, build output or version control)',
  8: 'files that may hold secrets (.env) are off limits',
  9: 'that path is a symbolic link; only regular files can be edited',
  10: 'that file is a hard link to another file, so it cannot be written',
  12: 'that is a binary file, not text',
  13: 'the folder for that file could not be created',
};

/**
 * Run one script inside the sandbox under `timeout`, with the project root as $1. Resolves with the
 * run result; throws a ToolError only when the sandbox could not be asked at all.
 */
async function execTool(box, script, args, opts = {}) {
  try {
    return await box.execArgs([...IN_BOX_TIMEOUT, 'sh', '-c', script, 'ring-tool', APP_DIR, ...args],
      { ...opts, timeoutMs: EXEC_TIMEOUT_MS, maxBytes: EXEC_MAX_BYTES });
  } catch {
    throw new ToolError('the sandbox could not run the tool');
  }
}

/** The ToolError for a failed script run: output flood, timeout, or the meaning of its exit code. */
function failure(r, messages = {}) {
  if (r.truncated) return new ToolError('the tool printed too much output');
  if (r.timedOut || r.code === 124 || r.code === 137) return new ToolError('the tool took too long and was stopped');
  return new ToolError(messages[r.code] ?? REFUSALS[r.code] ?? `the tool failed inside the sandbox (exit ${r.code})`);
}

/** Replace control characters (except tab and newline) so odd bytes in a file never reach the model raw. */
const printable = (s) => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�');

/**
 * Fit output into MAX_OUTPUT characters: cut at a line end and say so. `note` (when given) is the
 * last line. The result is never longer than MAX_OUTPUT.
 */
function clip(text, note = '') {
  const tail = note ? `\n${note}` : '';
  if (text.length + tail.length <= MAX_OUTPUT) return text + tail;
  const room = MAX_OUTPUT - tail.length - CUT_NOTE.length - 1;
  const end = text.lastIndexOf('\n', room);
  return `${text.slice(0, end > 0 ? end : room)}\n${CUT_NOTE}${tail}`;
}

/** How often `needle` occurs in `text` (without overlaps, counted up to 100) and where first. */
function occurrences(text, needle) {
  let count = 0;
  let first = -1;
  for (let i = text.indexOf(needle); i !== -1 && count < 100; i = text.indexOf(needle, i + needle.length)) {
    if (first === -1) first = i;
    count++;
  }
  return { count, first };
}

/** The reply for an error thrown inside a tool. Anything but a ToolError is a bug: name it, no details. */
const errorText = (err) => `error: ${err instanceof ToolError ? err.message : `the tool failed unexpectedly (${err?.name ?? 'Error'})`}`;

/**
 * The file tools of one task, bound to its sandbox. check_ui and finish are handled by the loop.
 * Each tool resolves to a string: the result, or "error: <one sentence>" for every refusal and
 * failure. Calls must be awaited one at a time (the loop runs them in order), because the per-task
 * file caps are counted here. After every write that may have changed a file, `onWrite` is called
 * with the file's real project-relative path (symlinked folders resolved), even when the write then
 * failed or timed out: the loop's touched set decides what the tamper guard scans and what goes into
 * the patch. A throwing onWrite rejects the tool's promise; it is a bug in the caller.
 * @param {{execArgs: Function, readFile: Function}} box  a runner/sandbox.mjs Sandbox
 * @param {{onWrite?: (rel: string, info: {created: boolean, bytes: number}) => void,
 *          limits?: {maxCreated?: number, maxTouched?: number}}} [o]  caps default to 20 created, 50 touched
 * @returns {Record<'list_files'|'read_file'|'search_code'|'replace_in_file'|'write_file', (args: object) => Promise<string>>}
 */
export function fileTools(box, { onWrite, limits } = {}) {
  if (!box || typeof box.execArgs !== 'function' || typeof box.readFile !== 'function') {
    throw new TypeError('fileTools needs a Sandbox with execArgs() and readFile() (runner/sandbox.mjs)');
  }
  if (onWrite !== undefined && typeof onWrite !== 'function') throw new TypeError('fileTools: onWrite must be a function');
  const maxCreated = limits?.maxCreated ?? 20;
  const maxTouched = limits?.maxTouched ?? 50;
  if (!Number.isSafeInteger(maxCreated) || maxCreated < 0 || !Number.isSafeInteger(maxTouched) || maxTouched < 0) {
    throw new TypeError('fileTools: limits.maxCreated and limits.maxTouched must be whole numbers ≥ 0');
  }
  const created = new Set(); // real paths of files the model created
  const touched = new Set(); // real paths of files the model wrote

  /** Wrap a read-only tool: check its arguments, turn every refusal into "error: …". */
  const tool = (name, fn) => async (raw) => {
    const checked = checkArgs(name, raw ?? {});
    if (checked.error) return `error: ${checked.error}`;
    try {
      return await fn(checked.args);
    } catch (err) {
      return errorText(err);
    }
  };

  /** Wrap a write tool. Its body returns {text, touch}; `touch` is the file that may have changed. */
  const writeTool = (name, fn) => async (raw) => {
    const checked = checkArgs(name, raw ?? {});
    if (checked.error) return `error: ${checked.error}`;
    let done;
    try {
      done = await fn(checked.args);
    } catch (err) {
      return errorText(err); // thrown only before anything was written
    }
    if (done.touch) {
      const { rel, created: isNew, bytes } = done.touch;
      touched.add(rel);
      if (isNew) created.add(rel);
      await onWrite?.(rel, { created: isNew, bytes });
    }
    return done.text;
  };

  /**
   * Write `bytes` to `abs` inside the sandbox. Resolves {touch, error?}: `touch` is set whenever the
   * file may have changed (the script announced the write, or the host lost track of it).
   */
  const writeInBox = async (abs, bytes, mayCreate, messages = {}) => {
    const r = await execTool(box, WRITE_SCRIPT, [abs, mayCreate ? '1' : '0'], { input: bytes });
    const [state, real] = String(r.stdout).split('\n');
    let touch = null;
    if ((state === 'new' || state === 'old') && real) touch = { rel: real, created: state === 'new', bytes: bytes.length };
    else if (r.code === 0 || r.timedOut) touch = { rel: relOf(abs), created: false, bytes: bytes.length };
    if (r.code === 0 && !r.truncated) return { touch };
    if (r.code === 14) return { touch, error: 'the file could not be written completely (the sandbox may be out of space); read it again before you edit it' };
    return { touch, error: failure(r, { 5: 'that path is a folder or a special file, or a part of it is a file', ...messages }).message };
  };

  return {
    list_files: tool('list_files', async ({ dir }) => {
      const abs = safePath(dir, { allowRoot: true });
      const r = await execTool(box, LIST_SCRIPT, [abs]);
      if (r.code !== 0 || r.truncated) throw failure(r, { 4: `no such folder: ${relOf(abs)}`, 5: 'that is a file, not a folder; use read_file to read it' });
      const lines = printable(String(r.stdout)).split('\n').filter(Boolean);
      if (lines.length === 0) return '(no files)';
      const note = lines.length > LIST_MAX ? `(only the first ${LIST_MAX} files are listed; pass dir to list one folder)` : '';
      return clip(lines.slice(0, LIST_MAX).join('\n'), note);
    }),

    read_file: tool('read_file', async ({ path: p, from_line: fromLine, to_line: toLine }) => {
      const abs = safePath(p);
      const from = Math.min(Math.max(1, fromLine ?? 1), 1e9);
      const to = Math.min(Math.max(from, toLine ?? from + READ_SPAN - 1), 1e9);
      const r = await execTool(box, READ_SCRIPT, [abs, String(from), String(to)]);
      if (r.code !== 0 || r.truncated) {
        throw failure(r, {
          4: `no such file: ${relOf(abs)}`,
          5: 'that is a folder or a special file, not a text file; use list_files to see the files',
          6: 'the file is larger than 2 MB; use search_code to find the part you need',
        });
      }
      const out = String(r.stdout);
      const nl = out.indexOf('\n');
      const total = nl > 0 ? Number(out.slice(0, nl)) : NaN;
      if (!Number.isSafeInteger(total) || total < 0) throw new ToolError('the sandbox gave an unexpected answer');
      if (total === 0) return '(the file is empty)';
      if (from > total) return `(the file has ${plural(total, 'line')}; from_line ${from} is past the end)`;
      let shown = printable(out.slice(nl + 1).replace(/\n$/, ''));
      let last = Math.min(to, total);
      let cut = false;
      const room = MAX_OUTPUT - 160; // leaves room for the footer
      if (shown.length > room) {
        const end = shown.lastIndexOf('\n', room);
        shown = shown.slice(0, end > 0 ? end : room);
        const m = /^\s*(\d+) {2}/.exec(shown.slice(shown.lastIndexOf('\n') + 1));
        last = m ? Number(m[1]) : from;
        cut = true;
      }
      let footer;
      if (cut) footer = `(lines ${from}-${last} of ${total}; the rest did not fit, read on with from_line=${last + 1})`;
      else if (from === 1 && last === total) footer = `(${plural(total, 'line')})`;
      else if (last < total) footer = `(lines ${from}-${last} of ${total}; read on with from_line=${last + 1})`;
      else footer = `(lines ${from}-${last} of ${total})`;
      return `${shown}\n${footer}`;
    }),

    search_code: tool('search_code', async ({ pattern, file_glob: glob = '' }) => {
      if (pattern === '') throw new ToolError('pattern is empty');
      if (pattern.length > 500) throw new ToolError('the pattern is longer than 500 characters');
      if (pattern.includes('\0')) throw new ToolError('the pattern contains a NUL character');
      if (glob.length > 200 || /[\x00-\x1f\x7f]/.test(glob)) throw new ToolError('file_glob must be a short file-name pattern such as *.css');
      if (glob.includes('/')) throw new ToolError('file_glob matches file names only, without folders: use *.css, not src/*.css');
      const r = await execTool(box, SEARCH_SCRIPT, [pattern, glob]);
      if ((r.code !== 0 && r.code !== 20) || r.truncated) throw failure(r, { 4: 'the project folder is missing' });
      const head = r.code === 20 ? '(the pattern is not a valid extended regular expression, so it was searched as plain text)\n' : '';
      const lines = printable(String(r.stdout)).split('\n').filter(Boolean);
      if (lines.length === 0) return `${head}no matches`;
      const note = lines.length > SEARCH_MAX ? `(only the first ${SEARCH_MAX} matches are shown; narrow the pattern or set file_glob)` : '';
      return clip(head + lines.slice(0, SEARCH_MAX).join('\n'), note);
    }),

    replace_in_file: writeTool('replace_in_file', async ({ path: p, old_text: oldText, new_text: newText }) => {
      const abs = safePath(p, { forWrite: true });
      if (oldText === '') throw new ToolError('old_text is empty; copy the exact text to replace from read_file');
      if (oldText === newText) throw new ToolError('new_text is the same as old_text, so nothing would change');
      if (newText.length > MAX_WRITE_CHARS) throw new ToolError(`new_text is longer than ${MAX_WRITE_CHARS} characters`);
      if (newText.includes('\0')) throw new ToolError('new_text contains a NUL character; only text can be written');

      const t = await execTool(box, EDIT_TARGET_SCRIPT, [abs]);
      if (t.code !== 0 || t.truncated) {
        throw failure(t, { 4: `no such file: ${relOf(abs)}; use write_file to create a file`, 6: 'the file is larger than 1 MB, too large to edit' });
      }
      const real = String(t.stdout).split('\n')[0];
      if (!real) throw new ToolError('the sandbox gave an unexpected answer');
      if (!touched.has(real) && touched.size >= maxTouched) throw new ToolError(TOO_MANY);

      let buf;
      try {
        buf = await box.readFile(`${APP_DIR}/${real}`, { maxBytes: EDIT_MAX_BYTES });
      } catch (err) {
        throw new ToolError(/^file too large/.test(err?.message ?? '') ? 'the file is larger than 1 MB, too large to edit' : 'the file could not be read');
      }
      if (buf.includes(0)) throw new ToolError('that is a binary file, not text');
      const text = buf.toString('utf8');
      // A file that is not valid UTF-8 would come back with U+FFFD in place of its bytes: never write that.
      if (!Buffer.from(text, 'utf8').equals(buf)) throw new ToolError('the file is not UTF-8 text, so it cannot be edited safely');

      let from = oldText;
      let to = newText;
      let hits = occurrences(text, from);
      // read_file shows CRLF files without the CR, so a multi-line old_text arrives with bare LFs.
      if (hits.count === 0 && from.includes('\n') && !from.includes('\r') && text.includes('\r\n')) {
        const crlf = occurrences(text, from.replace(/\n/g, '\r\n'));
        if (crlf.count > 0) {
          hits = crlf;
          from = from.replace(/\n/g, '\r\n');
          to = to.replace(/\r?\n/g, '\r\n');
        }
      }
      if (hits.count === 0) throw new ToolError('old_text was not found in the file; read the file again and copy the text exactly, spaces included');
      if (hits.count > 1) throw new ToolError(`old_text appears ${hits.count >= 100 ? '100 or more' : hits.count} times; include more of the surrounding text so it appears once`);

      const next = Buffer.from(text.slice(0, hits.first) + to + text.slice(hits.first + from.length), 'utf8');
      const w = await writeInBox(abs, next, false, { 11: 'the file was removed before it could be written; read it again' });
      if (w.error) return { text: `error: ${w.error}`, touch: w.touch };
      const line = text.slice(0, hits.first).split('\n').length;
      return { text: `edited ${w.touch.rel} at line ${line}`, touch: w.touch };
    }),

    write_file: writeTool('write_file', async ({ path: p, content }) => {
      const abs = safePath(p, { forWrite: true });
      if (content.length > MAX_WRITE_CHARS) throw new ToolError(`content is longer than ${MAX_WRITE_CHARS} characters; use replace_in_file for part of a file`);
      if (content.includes('\0')) throw new ToolError('content contains a NUL character; only text can be written');
      const rel = relOf(abs);
      if (!touched.has(rel) && touched.size >= maxTouched) throw new ToolError(TOO_MANY);
      const mayCreate = created.has(rel) || created.size < maxCreated;
      const w = await writeInBox(abs, Buffer.from(content, 'utf8'), mayCreate, { 11: TOO_MANY });
      if (w.error) return { text: `error: ${w.error}`, touch: w.touch };
      return { text: `${w.touch.created ? 'created' : 'wrote'} ${w.touch.rel} (${plural(content.length, 'character')})`, touch: w.touch };
    }),
  };
}

// ---- Reports, as the model reads them ---------------------------------------------------------------

/** The axes of a report's matrix as lists of names. */
function axesOf(report) {
  const m = report?.matrix ?? {};
  return {
    viewports: (m.viewports ?? []).map((v) => (typeof v === 'string' ? v : v?.name)).filter(Boolean),
    schemes: m.schemes ?? [],
    locales: m.locales ?? [],
  };
}

/** One line of text: whitespace collapsed, cut at `max` characters. */
const oneLine = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * The screens an issue was seen on (cells "viewport/scheme/locale" of one route), short: "all
 * screens"; a pattern such as "mobile/*\/vi" when they are every combination of some axis values
 * (* = every value of that axis); otherwise a list, cut after three.
 * @param {string[]} cells
 * @param {object} report  the Mantis report the cells come from (for its matrix)
 * @returns {string}
 */
export function formatCells(cells, report) {
  const list = [...new Set(Array.isArray(cells) ? cells : [])];
  if (list.length === 0) return 'no screens';
  const axes = axesOf(report);
  const parts = list.map((c) => String(c).split('/'));
  const known = parts.every((q) => q.length === 3 && axes.viewports.includes(q[0]) && axes.schemes.includes(q[1]) && axes.locales.includes(q[2]));
  if (known) {
    const pick = (i, all) => all.filter((x) => parts.some((q) => q[i] === x));
    const v = pick(0, axes.viewports);
    const s = pick(1, axes.schemes);
    const l = pick(2, axes.locales);
    // The cells are distinct and drawn from v × s × l, so equal counts mean every combination is there.
    if (v.length * s.length * l.length === list.length) {
      if (v.length === axes.viewports.length && s.length === axes.schemes.length && l.length === axes.locales.length) return 'all screens';
      const axis = (sel, all) => (sel.length === all.length && all.length > 1 ? '*' : sel.join(','));
      return `${axis(v, axes.viewports)}/${axis(s, axes.schemes)}/${axis(l, axes.locales)}`;
    }
  }
  return list.length > 4 ? `${list.slice(0, 3).join(', ')} +${list.length - 3} more` : list.join(', ');
}

/**
 * Issues as the model reads them, one line each: severity, type, route, selector, screens and
 * Mantis's message. Errors first, then by issue id; at most `limit` lines plus "… and N more".
 * @param {object} report  the Mantis report the issues come from
 * @param {object[]} issues
 * @param {{limit?: number}} [o]
 * @returns {string[]}
 */
export function issueLines(report, issues, { limit = 60 } = {}) {
  if (!Array.isArray(issues)) throw new TypeError('issueLines needs an array of Mantis issues');
  const sorted = issues.slice().sort((a, b) => ((a.severity === 'error') === (b.severity === 'error') ? (a.id ?? 0) - (b.id ?? 0) : a.severity === 'error' ? -1 : 1));
  const lines = sorted.slice(0, limit).map((i) =>
    `- ${i.severity} ${i.type} · ${i.route} · ${oneLine(i.selector ?? '-', 120)} · ${formatCells(i.cells, report)}: ${oneLine(i.message, 300)}`);
  if (sorted.length > limit) lines.push(`- … and ${sorted.length - limit} more`);
  return lines;
}

/**
 * A short, model-friendly view of a Mantis report: the counts, then one line per issue.
 * @param {object} report  a parsed report.json
 * @param {{limit?: number}} [o]
 * @returns {string}
 */
export function describeReport(report, { limit = 60 } = {}) {
  const s = report?.summary;
  if (!s || !Array.isArray(report.issues)) throw new TypeError('describeReport needs a Mantis report with summary and issues');
  return [`${s.errors} errors, ${s.warnings} warnings across ${s.cells} screens`, ...issueLines(report, report.issues, { limit })].join('\n');
}
