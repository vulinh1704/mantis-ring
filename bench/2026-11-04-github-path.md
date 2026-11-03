# The GitHub path, before and after (4 Nov 2026)

Four small, popular public front-end repositories, each run once through the GitHub path on the Vultr VM before the fix and once after it. Every sandbox ran under gVisor (`runsc`).

- **Before:** commit `2e01f41`, 3 Nov 22:09–22:12 UTC (05:09–05:12 ICT on 4 Nov).
- **After:** commit `468c5f6`, 3 Nov 22:43–22:45 UTC. The fix is in `806b89f` (runner and loop), `df0115a` (app) and `468c5f6` (tests).

**No model was called.** Each task was an admin task with `caps.maxUsd` 0.000001 and `visionModel` null, so the spend guard refused the first model call before it was sent. All 11 runs (4 before, 4 after, 3 edge cases) made 0 model calls, and the spend ledger stayed at $0.839389. A task whose baseline finds no issue ends before any model call anyway ("no-issues").

**Matrix:** the GitHub default: route `/`, mobile and desktop, light and dark, English. That is 4 screens.

**The labels:** the runs are `gh-before:*`, `gh-after:*` and `gh-edge:*` in the admin task list.

## The repositories

Stars and licences are from the GitHub API on 4 Nov.

| Repository | Kind | Licence | Stars | Lock file | `dev` script |
|---|---|---|---|---|---|
| [TailAdmin/free-react-tailwind-admin-dashboard](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard) | Vite 8 + React 19 + Tailwind 4 | MIT | 1,294 | package-lock.json | `vite` |
| [antfu-collective/vitesse-lite](https://github.com/antfu-collective/vitesse-lite) | Vite + Vue 3 + UnoCSS | MIT | 1,252 | pnpm-lock.yaml, with `packageManager: pnpm@12.3.4` and `catalog:` versions | `vite --port 3333 --open` |
| [satnaing/astro-paper](https://github.com/satnaing/astro-paper) | Astro 7 blog | MIT | 5,177 | pnpm-lock.yaml only | `astro dev` |
| [codewithsadee/vcard-personal-portfolio](https://github.com/codewithsadee/vcard-personal-portfolio) | Plain HTML, CSS and JS | MIT | 8,160 | none (no package.json) | none |

## Before and after

- **Clone:** sandbox start plus `git clone --depth 1`.
- **Install:** the inspection plus the install, as the live log reports it.
- **Serve:** from the end of the install until the app answered, or until the runner gave up.
- **Look:** the baseline run R0.
- All times are in seconds.

| Repository | Run | Clone | Install | Command that starts the app | Answered? | Serve | Look | Screens | Mantis found | Result | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| TailAdmin | before | 2.1 | 7.7 (npm ci) | `PORT=3000 npm run dev -- --port 3000`, which runs `vite --port 3000` | no, 127.0.0.1:3000 never answered | 90.6 | – | – | – | failed: "The app did not start inside the sandbox (no answer on port 3000)." | 100.8 |
| TailAdmin | after | 2.3 | 8.5 (npm ci) | `vite --host 127.0.0.1 --port 3000 --strictPort` | yes, 127.0.0.1:3000 | 2.3 | 26.1 | 4 of 4 | 9 errors (contrast), 1 warning (layout shift, CLS 0.124) | done; stopped at the budget, as set | 40.2 |
| vitesse-lite | before | 1.4 | failed after 0.7 (npm install: `EUNSUPPORTEDPROTOCOL`, `catalog:`) | – | – | – | – | – | – | failed: "The project's dependencies could not be installed." | 2.4 |
| vitesse-lite | after | 1.3 | 14.6 (pnpm 12.3.4, installed with npm, then pnpm install) | `vite --open --host 127.0.0.1 --port 3000 --strictPort` (with `BROWSER=none`) | yes, 127.0.0.1:3000 | 3.0 | 4.4 | 4 of 4 | nothing | done: no-issues, no model call | 23.9 |
| astro-paper | before | 1.0 | 37.7 (npm install; pnpm-lock.yaml ignored) | `PORT=3000 npm run dev -- --port 3000`, which runs `astro dev --port 3000` | no, 127.0.0.1:3000 never answered | 90.3 | – | – | – | failed: "The app did not start inside the sandbox (no answer on port 3000)." | 129.4 |
| astro-paper | after | 2.4 | 10.7 (pnpm 10, picked for lockfile 9.0) | `astro dev --host 127.0.0.1 --port 3000` | yes, 127.0.0.1:3000 | 9.7 | 7.8 | 4 of 4 | nothing | done: no-issues, no model call | 31.2 |
| vcard | before | 0.8 | – (static) | `node /opt/ring/static-server.mjs /work/app 3000` | yes, 127.0.0.1:3000 | 0.2 | 3.7 | 4 of 4 | 2 warnings (text cut by line-clamp) | done; stopped at the budget, as set | 5.4 |
| vcard | after | 1.4 | – (static) | the same | yes, 127.0.0.1:3000 | 0.4 | 4.6 | 4 of 4 | the same 2 warnings | done; stopped at the budget, as set | 7.0 |

Before the fix, 1 of the 4 repositories reached a measurement. After it, all 4 did, every screen loaded with HTTP 200, and the whole setup took 7–40 s per repository.

- **Why the two dev servers never answered.** The old runner kept no dev-server log, so the cause is inferred, not seen. Vite and Astro listen on `localhost` unless told otherwise. Inside the sandbox, `localhost` can resolve to `::1` first, and the old probe asked only `127.0.0.1` (BUILD-SPEC risk R-k). The after runs pass `--host 127.0.0.1`, and both answered within 10 s.
- **vitesse-lite** pins pnpm 12.3.4 in its `packageManager` field and takes its versions from pnpm catalogs (`catalog:`), which npm cannot read. Its `pnpm-workspace.yaml` holds only catalogs, so it is not refused as a monorepo. Its own `--port 3333` was dropped from the command, so that a second `--port` would not follow it.
- **TailAdmin's look took 26 s** against 4–8 s for the other three. On the first page load, Vite compiles each module the browser asks for, and that is slow under gVisor. The warm-up request fetches only the HTML.

## Edge cases after the fix

These three also ran with no model call, on `468c5f6`.

| Repository | Why it was picked | What the person sees | Time |
|---|---|---|---|
| [vitejs/vite](https://github.com/vitejs/vite) | A popular monorepo: `pnpm-workspace.yaml` lists packages | "This repository is a monorepo with several packages; give a repository with one app at its root." | 1.6 s: cloned, refused at the inspection |
| `ring-no-such-owner-zz9/none` | A repository that does not exist | "The repository was not found on GitHub, or it is private." | 1.6 s |
| [torvalds/linux](https://github.com/torvalds/linux) | Far over the size limit | "The repository is larger than 300 MB, too big for the sandbox." | 13.9 s: the clone was stopped once the folder passed 307,200 KB |

## What changed

The runner's commit is `806b89f`; see `runner/run-task.mjs` and `docs/ARCHITECTURE.md`, "A GitHub repository".

- **Where the app is measured.**
  - Dev servers the runner knows start directly, bound to `127.0.0.1:3000` with `--strictPort` where the tool has it. The list: Vite, Astro, Next.js, Nuxt, react-scripts, Vue CLI, webpack, Angular, Gatsby, Docusaurus, VitePress, SvelteKit, React Router, Remix, Rsbuild, Vinxi and Parcel. The script's own `--port` and `--host` flags are replaced.
  - Anything else runs as `<package manager> run <script>`, with `PORT` and `HOST` set.
  - The probe then asks `127.0.0.1` and `::1`, on port 3000 and on any port the server printed. It stops waiting once the server's process has exited. It requests each route once before the first look.
- **The package manager** comes from the `packageManager` field, then from the lock file.
  - pnpm and yarn are installed with npm into the sandbox user's home, through the same proxy, at the version the project names.
  - Corepack is not used. By default it fetches Yarn 2 and later from repo.yarnpkg.com, which the allowlist refuses.
  - bun is not in the sandbox, so a `bun.lock` falls back to npm, and the live log says so.
  - A stale lock file (`npm ci` → `npm install`) and a peer-dependency conflict (`--legacy-peer-deps`) are each retried once, within the same 300 s.
- **What is refused before the install**, each with one sentence:
  - a monorepo (workspaces, a `pnpm-workspace.yaml` that lists packages, `lerna.json`, `rush.json`);
  - a broken `package.json`;
  - a project with no dev or start script and no `index.html`. One with an `index.html` in its root, `public/`, `src/`, `docs/`, `site/`, `www/`, `static/`, `dist/` or `build/` gets the static server.
- **Install failures are named.**
  - A host outside the allowlist is named in the sentence.
  - The other named failures: a package that is not on the public registry, no space, a Node version, the time limit and the memory limit.
  - The browser downloads of Puppeteer, Playwright, Cypress and Electron are skipped, and so are git hooks.
- **The clone** stops once the folder passes 300 MB, and a missing or private repository gets its own sentence.
- **Pasted addresses** (`df0115a`): spaces, `http://`, `www.`, no scheme, `.git`, `#readme` and `?tab=` are accepted. A link to a branch, file or pull request gets a sentence that asks for the repository's own address.

## Tests

| Suite | Where | Result |
|---|---|---|
| `test/agent-loop.mjs --unit` | locally and on the VM's Node 22.23.4 (deploy step 6) | 69/69. New: U12, 13 checks on the GitHub path's decisions |
| `test/app-api.mjs` | locally and on the VM's Node 22.23.4 | 50/50. New: the pasted-address check |
| containment, `468c5f6`, runsc | inside `deploy.sh --selftest` | 16/16, including the time limit on a hanging task through the new probe |
| scenes, `468c5f6`, runsc | inside `deploy.sh --selftest`, then `ring.sh selftest scenes` | 16/17, then 17/17 on the rerun. The failure was the known endless-spawn flake: gVisor stopped that sandbox at the process cap after 1 s. The scene and its sandbox code are unchanged |
| agent-loop, `468c5f6`, runsc | `ring.sh selftest agent-loop` | 104/104, with scenarios S1–S10 on the new start path |

## How to repeat

The repeat costs nothing: the spend guard refuses the first model call.

```bash
scripts/ring.sh run '{"repo":"https://github.com/satnaing/astro-paper","visionModel":null,"caps":{"maxUsd":0.000001},"label":"gh-after:astro-paper"}'
```

`ring.sh run` prints the owner link. Keep that line out of logs and files. Then `scripts/ring.sh bundle <id> <dir>` fetches `events.jsonl`, `receipt.json` and `r0.report.json`. The live log names the plan:

```
project: pnpm 10 (pnpm-lock.yaml) · start: astro dev --host 127.0.0.1 --port 3000
dependencies installed through the proxy in 10.7 s (pnpm install)
dev server up at http://127.0.0.1:3000 (its dev server)
```
