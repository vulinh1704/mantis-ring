// The tools Ring's model can call, and how each one runs inside the task's sandbox.
// Every tool touches only the copy of the project under /work/app, through `docker exec`.
// The model has no shell: it cannot run commands, reach the network or read anything outside
// the project. Paths are checked here, before anything reaches the sandbox.
import path from 'node:path/posix';
import { Readable } from 'node:stream';
import { APP_DIR, sh } from '../runner/run-task.mjs';

const MAX_OUTPUT = 12_000; // characters returned to the model per tool call
const SKIP_DIRS = ['node_modules', '.git', '.mantis', 'dist', 'build', '.next'];

export const TOOL_SCHEMAS = [
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
      description: 'Measure the app again with Mantis after your edits: every page, screen size, color scheme and language. Returns what got fixed, what is new, what is left, and whether any edit only hid a problem (a cover-up). A cover-up undoes every edit since the last check. You have a limited number of checks.',
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
];

/** Resolve a model-supplied path inside the project, or throw. */
export function safePath(p, { allowRoot = false } = {}) {
  if (typeof p !== 'string' || p.trim() === '') {
    if (allowRoot) return APP_DIR;
    throw new Error('path is required');
  }
  if (p.includes('\0')) throw new Error('invalid path');
  const rel = path.normalize(p.trim().replace(/^\.\/+/, ''));
  if (rel.startsWith('/') || rel === '..' || rel.startsWith('../')) throw new Error(`path must stay inside the project: ${p}`);
  const parts = rel.split('/');
  if (parts.some((s) => SKIP_DIRS.includes(s))) throw new Error(`that folder is off limits: ${p}`);
  return rel === '.' ? APP_DIR : `${APP_DIR}/${rel}`;
}

const clip = (s) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (cut at ${MAX_OUTPUT} characters)` : s);
const prune = SKIP_DIRS.map((d) => `-name ${sh(d)}`).join(' -o ');

/** Run the file tools against a sandbox. check_ui and finish are handled by the loop itself. */
export function fileTools(box) {
  const write = async (abs, content) => {
    const dir = path.dirname(abs);
    const r = await box.exec(`mkdir -p ${sh(dir)} && cat > ${sh(abs)}`, { input: Readable.from([Buffer.from(content, 'utf8')]) });
    if (r.code !== 0) throw new Error(`could not write the file: ${r.stderr.trim()}`);
  };
  const readRaw = async (abs) => {
    const r = await box.exec(`cat ${sh(abs)}`);
    if (r.code !== 0) throw new Error(`no such file: ${abs.slice(APP_DIR.length + 1)}`);
    return r.stdout;
  };

  return {
    async list_files({ dir } = {}) {
      const abs = safePath(dir, { allowRoot: true });
      const r = await box.exec(`cd ${sh(abs)} && find . \\( ${prune} \\) -prune -o -type f -printf '%P\\t%s\\n' | sort | head -n 400`);
      if (r.code !== 0) throw new Error(`no such folder: ${dir}`);
      return clip(r.stdout.trim() || '(empty)');
    },
    async read_file({ path: p, from_line, to_line }) {
      const abs = safePath(p);
      const from = Math.max(1, Number(from_line) || 1);
      const to = Math.max(from, Number(to_line) || from + 399);
      const r = await box.exec(`test -f ${sh(abs)} && awk -v a=${from} -v b=${to} 'NR>=a && NR<=b { printf "%5d  %s\\n", NR, $0 } END { print "(" NR " lines)" }' ${sh(abs)}`);
      if (r.code !== 0) throw new Error(`no such file: ${p}`);
      return clip(r.stdout);
    },
    async search_code({ pattern, file_glob }) {
      if (!pattern) throw new Error('pattern is required');
      const include = file_glob ? `--include=${sh(file_glob)}` : '';
      const excludes = SKIP_DIRS.map((d) => `--exclude-dir=${sh(d)}`).join(' ');
      const r = await box.exec(`cd ${APP_DIR} && grep -rnIE ${excludes} ${include} -e ${sh(pattern)} . | cut -c1-300 | head -n 80`);
      if (r.code > 1) throw new Error(`search failed: ${r.stderr.trim()}`);
      return clip(r.stdout.trim() || 'no matches');
    },
    async replace_in_file({ path: p, old_text, new_text }) {
      const abs = safePath(p);
      if (typeof old_text !== 'string' || old_text === '') throw new Error('old_text is required');
      if (typeof new_text !== 'string') throw new Error('new_text is required');
      const text = await readRaw(abs);
      const count = text.split(old_text).length - 1;
      if (count === 0) throw new Error('old_text was not found in the file; read the file again and copy the text exactly');
      if (count > 1) throw new Error(`old_text appears ${count} times; include more surrounding text so it is unique`);
      await write(abs, text.replace(old_text, () => new_text));
      return `edited ${p}`;
    },
    async write_file({ path: p, content }) {
      const abs = safePath(p);
      if (typeof content !== 'string') throw new Error('content is required');
      if (content.length > 200_000) throw new Error('file too large');
      await write(abs, content);
      return `wrote ${p} (${content.length} characters)`;
    },
  };
}

/** A short, model-friendly view of a Mantis report: counts and one line per issue. */
export function describeReport(report, { limit = 60 } = {}) {
  const s = report.summary;
  const short = (cells) => (cells.length > 4 ? `${cells.slice(0, 3).join(', ')} +${cells.length - 3} more` : cells.join(', '));
  const lines = (report.issues ?? [])
    .slice()
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
    .slice(0, limit)
    .map((i) => `#${i.id} ${i.severity} ${i.type} · route ${i.route} · ${short(i.cells ?? [])} · ${i.selector ?? '-'}\n   ${(i.message ?? '').slice(0, 400)}`);
  const more = (report.issues?.length ?? 0) > limit ? `\n… and ${report.issues.length - limit} more` : '';
  return `${s.errors} errors, ${s.warnings} warnings across ${s.cells} screens\n${lines.join('\n')}${more}`;
}
