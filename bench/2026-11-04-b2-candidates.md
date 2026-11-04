# B2 candidates: an R0-only scan (4 Nov 2026)

Eight public front-end repositories that are not ours, each run once through the GitHub path on the Vultr VM, to choose the B2 task of the 6–7 Nov benchmark. B2 must be MIT or Apache-2.0, npm with a lock file (or static), with a dev server that answers on 127.0.0.1, an install under 2 minutes, a real page to check at phone width, and at least 3 errors at R0.

- **When:** 4 Nov 07:45–07:54 UTC (14:45–14:54 ICT), one task at a time. Before each one, `/admin/health` showed nothing running or queued and no sandbox.
- **Where:** the VM at commit `21fa1fa`. Every sandbox ran under gVisor (`runsc`) on its own network (`ring-task-…`).
- **Matrix:** the GitHub default: route `/`, mobile (360×740) and desktop (1440×900), light and dark, English. That is 4 screens.
- **Labels:** `b2-scan:<name>` in the admin task list.

## No model was called

Each task was:

```json
{"repo":"https://github.com/<owner>/<name>","visionModel":null,"caps":{"maxUsd":0.000001,"maxPromptTokens":1000},"label":"b2-scan:<name>"}
```

Why that cannot reach a model, on `21fa1fa`:

- A task calls a model only through `chat()`: the fix model from the loop (`agent/loop.mjs`, `callModel()`), and the vision check. `visionModel: null` gives the loop no vision function. `chat()` asks the task's spend guard before every attempt, and a refusal there sends nothing (`agent/inference.mjs`, `app/spend.mjs`).
- The guard checks prompt tokens first. The first request is estimated at 1,466 tokens or more: the system prompt and the seven tool schemas alone, before the task message, counted as the guard counts them (`ceil(JSON length / 3)`). The cap was 1,000, the lowest the config allows. This check does not depend on any price.
- Then the price. A model with no known price is refused for admin tasks, and a priced one is refused when its estimate passes $0.000001, the lowest `maxUsd`. The estimate prices the whole prompt and the full completion cap: about $0.005 for deepseek-v4.1-flash-1017.
- The GitHub-path runs of 3 Nov set only `maxUsd`. The token cap was added so that the guarantee does not depend on the catalogue: a model listed at $0 would pass the price check.

**Result.** Five tasks logged "budget reached (tokens): no further model call", and three failed before the model loop. No task had a `model` event, and the five receipts show 0 calls and $0. `/admin/spend` read $0.839389 and 200 ledger calls before the first task and after the last, none of them on 4 Nov.

## The candidates

Picked from GitHub on 4 Nov: popular, maintained repositories with one app at the root and a real page at `/`. Stars, licences and last commits are from the GitHub API on 4 Nov. They are listed in the order of the ranking below.

| Rank | Repository | Stack | Licence | Stars | Last commit | Lock file | Start command, as the runner planned it |
|---|---|---|---|---|---|---|---|
| 1 | [coreui/coreui-free-react-admin-template](https://github.com/coreui/coreui-free-react-admin-template) | Vite 8, React 19, CoreUI 5 | MIT | 4,968 | 23 Sep 2026 | package-lock.json | `vite --host 127.0.0.1 --port 3000 --strictPort` (its `start` script) |
| 2 | [TailAdmin/free-react-tailwind-admin-dashboard](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard) | Vite 8, React 19, Tailwind 4 | MIT | 1,294 | 29 Oct 2026 | package-lock.json | `vite --host 127.0.0.1 --port 3000 --strictPort` |
| 3 | [coreui/coreui-free-vue-admin-template](https://github.com/coreui/coreui-free-vue-admin-template) | Vite 8, Vue 3, CoreUI 5 | MIT | 3,410 | 23 Sep 2026 | package-lock.json | `vite --force --host 127.0.0.1 --port 3000 --strictPort` |
| 4 | [arthelokyo/astrowind](https://github.com/arthelokyo/astrowind) | Astro 7, Tailwind 4 | MIT | 6,116 | 12 Sep 2026 | package-lock.json | `astro dev --host 127.0.0.1 --port 3000` |
| 5 | [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) | Vite 8, React 19, shadcn/ui | MIT | 16,526 | 11 Jun 2026 | pnpm-lock.yaml (pnpm 10) | `vite --host 127.0.0.1 --port 3000 --strictPort` |
| 6 | [arhamkhnz/next-shadcn-admin-dashboard](https://github.com/arhamkhnz/next-shadcn-admin-dashboard) | Next.js 16, shadcn/ui | MIT | 3,249 | 3 Nov 2026 | package-lock.json | `next dev --hostname 127.0.0.1 --port 3000` |
| 7 | [raycast/ray-so](https://github.com/raycast/ray-so) | Next.js 16 | MIT | 2,371 | 1 Nov 2026 | package-lock.json | `next dev --hostname 127.0.0.1 --port 3000` |
| 8 | [iib0011/omni-tools](https://github.com/iib0011/omni-tools) | Vite 5, React 18, MUI 5 | MIT | 10,608 | 24 Oct 2026 | package-lock.json | `vite --host 127.0.0.1 --port 3000 --strictPort` |

**Looked at, not run:**
- `tabler/tabler`, `AykutSarac/jsoncrack.com` and `kailong321200875/vue-element-plus-admin`: their `pnpm-workspace.yaml` lists packages, so the runner refuses them as monorepos.
- `mermaid-js/mermaid-live-editor`: `engine-strict=true` with Node 24.16 or later, and the sandbox has Node 22.
- `primefaces/sakai-vue`: `src/assets` is a git submodule, which `git clone --depth 1` leaves empty.
- `cruip/tailwind-dashboard-template` has no licence, and `vuejs/docs` has none that GitHub reads as MIT or Apache-2.0.
- `steven-tey/precedent` expects Clerk keys (its `.env.example`), and its last commit was in Oct 2024.
- `StartBootstrap/startbootstrap-sb-admin-2`, `akveo/ngx-admin` and `estevanmaito/windmill-dashboard`: last commit in 2021, 2024 and 2020.

## Results

All times are in seconds, from each task's events and receipt.

- **Clone:** sandbox start plus `git clone --depth 1`.
- **Install:** the install alone, as the live log reports it.
- **Serve:** from the end of the install until the app answered.
- **R0:** the baseline look.
- **Total:** the whole task, from queue to `done`.

| Rank | Repository @ commit | Task | Clone | Install | Serve | R0 | Total | Dev server | R0 errors / warnings | Errors by kind | B2? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | coreui-free-react-admin-template @ `2609f59` | `t_4002e2a0888672975b996bfb545b0d78` | 1.3 | 7.0 (npm ci) | 1.6 | 10.6 | 21.0 | answered on 127.0.0.1:3000 | **16** / 2 | contrast 11, theme-leak 4, page-overflow 1 | **yes, first choice** |
| 2 | free-react-tailwind-admin-dashboard @ `df1e9f3` | `t_540542cd74acffee374874ecc89a76f3` | 1.3 | 7.0 (npm ci) | 1.6 | 20.3 | 31.1 | answered | **9** / 1 | contrast 9 | yes |
| 3 | coreui-free-vue-admin-template @ `81cc2ae` | `t_16543bcc7eb0e0d1f64ca474af6e21c0` | 1.3 | 5.7 (npm ci) | 1.7 | 9.4 | 18.6 | answered | **6** / 0 | contrast 6 | yes, as the backup |
| 4 | astrowind @ `14e1a69` | `t_c0f49b6a3819713eec4a42fbdb3590f1` | 1.2 | 7.3 (npm ci) | 9.1 | 11.8 | 30.0 | answered | 16 / 0 | broken-image 8, theme-leak 7, contrast 1 | no: 8 of the errors come from the sandbox |
| 5 | shadcn-admin @ `e16c87f` | `t_88f4abcd5bf715a284b0a4eee626768b` | 1.3 | 7.0 (pnpm install) | 1.9 | 9.3 | 20.0 | answered | 1 / 1 | overlap 1 | no: under 3 |
| 6 | next-shadcn-admin-dashboard @ `bd98e04` | `t_7c4112d9b1e970936ddab768912d5f8b` | 1.3 | 12.6 (npm ci) | 7.1 | failed after 4.9 | 26.3 | answered (warm-up `/` 200) | – | – | no: not measured |
| 7 | ray-so @ `54a5a0d` | `t_029291c3bf31f7c6f98c1a13913a6af7` | 2.3 | 13.5 (npm ci) | 10.2 | failed after 3.5 | 29.8 | answered (warm-up `/` 200) | – | – | no: not measured |
| 8 | omni-tools @ `9244e02` | `t_6b4b65522a234cebdf46b05c86ed6e4a` | 1.3 | failed after 22.2 (npm ci) | – | – | 23.8 | – | – | – | no: the install was refused |

Failures, as the task's page showed them:
- **next-shadcn-admin-dashboard** and **ray-so:** "The app could not be measured: the measurement timed out." `mantis look` ended within 5 s; see the first finding below.
- **omni-tools:** "The project's dependencies could not be installed with npm." The lock file takes xlsx 0.20.3 from `https://cdn.sheetjs.com/…`, and the proxy refused it (`npm error code E403`, `403 Filtered`).

### What R0 found on the first three

**coreui-free-react-admin-template:** 16 errors and 2 warnings, from several separate causes.
- White text on the coloured widget cards fails contrast in both schemes: `.bg-info` 2.94:1, `.bg-warning` 1.85:1 and `.bg-danger` 3.68:1 in light, and 2.96, 1.97 and 3.67:1 on their dark variants. On desktop the large figures on the blue and yellow cards fail even the 3:1 threshold for large text.
- The template follows `prefers-color-scheme`, so its dark screens are real dark mode. In dark mode, links keep `#5e5cd0` on `#212631` (2.82:1: the breadcrumb and the footer), and the Day/Year buttons keep `#6b7785` (3.32:1). That gives 4 theme leaks and 2 more contrast errors.
- The sidebar's section titles are `#75787f` on `#212631`, 3.42:1 (desktop).
- At 360 px the page is 389 px wide and scrolls sideways. Mantis could not blame a single element.
- The warnings: a layout shift (CLS 0.12, the footer, mobile) and "Recurring Clients" cut by an ellipsis with no title.

**free-react-tailwind-admin-dashboard:** 9 contrast errors and a layout-shift warning (CLS 0.124).
- The errors are badge, button and label colours, for example `#00a63e` on `#e1fcea` (2.96:1), `#e17100` on `#fff7dc` (2.98:1), and `#99a1af` on white for MENU and OTHERS (2.60:1, desktop).
- Its dark mode is a class toggle, not `prefers-color-scheme`, so the dark screens show the light theme. B2 on TailAdmin would test contrast only.

**coreui-free-vue-admin-template:** 6 contrast errors: the same widget cards and sidebar titles as the React template. Its dark screens also show the light theme, and nothing overflows at 360 px.

## What the scan says about the GitHub path

Nothing below was changed by this scan.

1. **Next.js 16 apps are not measured (2 of 2).**
   - Both dev servers answered: the journal shows the warm-up request `/` 200 in 92 ms and 113 ms.
   - Then `mantis look` ended after 4.9 s and 3.5 s with an exit code of 128 or more.
   - `look()` (`runner/run-task.mjs`) treats any such code as a timeout ("did not finish within 300 s"), so the page said "the measurement timed out", which is wrong.
   - The loop's journal keeps only that first line, so neither the exit code nor the stderr tail was seen. The cause is not known; the sandbox's 3 GB memory limit, with `/work` in RAM, is one guess.
   - Until this is fixed, a Next.js repository fails on the GitHub path. That matters for step 2 of opening public runs.
2. **The proxy's refusal is not named for npm.** `offAllowlistHost()` looks for `statusCode=403`, `403 Forbidden` and similar texts, not npm's `E403` with tinyproxy's `403 Filtered`. omni-tools therefore got the generic sentence instead of one that names `cdn.sheetjs.com`.
3. **Assets outside the allowlist count as bugs.** The sandbox's browser cannot reach `images.unsplash.com` (`net::ERR_TUNNEL_CONNECTION_FAILED`), so AstroWind's 8 remote images were reported as broken. A model asked to fix them could only remove or replace them. The other 8 AstroWind errors come from one colour: `#0161ef` dates on `#08090a` in dark mode.
4. **Dev-only overlays are measured.** shadcn-admin's one error is the TanStack Query devtools button, which only the dev server shows, overlapping the user menu.
5. **There is no SHA pin.** A task clones the default branch's HEAD. Each B2 run should check that its receipt names `2609f5995035973e00c16ec723165a5fff87cceb`. CoreUI React's last commit was on 23 Sep, so a change during 6–7 Nov is unlikely.

**Since then (4 Nov, 17:00–17:30 ICT):**
- **Finding 1 was memory, and it is fixed.** It was not a timeout: the sandbox ran out of its 3 GB. Both Next.js apps are now measured, and the page names the cause when a look fails. See [2026-11-04-nextjs-memory.md](2026-11-04-nextjs-memory.md).
- **Finding 2 is fixed:** omni-tools now gets "The install tried to reach cdn.sheetjs.com, which is outside the sandbox's allowlist (only npm and GitHub)."
- **What this means for B2:** a GitHub task's looks now open one screen size at a time, so CoreUI's looks take somewhat longer than the 10.6 s above.

## Recommendation

**B2: [coreui/coreui-free-react-admin-template](https://github.com/coreui/coreui-free-react-admin-template) at `2609f5995035973e00c16ec723165a5fff87cceb`.**

- **The most errors and the most kinds:** 16 errors of three kinds (contrast, dark-mode theme leaks and an overflow at 360 px), from several separate causes. So "bugs really fixed" counts more than one colour change.
- **A real dark mode:** it follows `prefers-color-scheme`. The TailAdmin and CoreUI Vue dark screens show the light theme.
- **A tempting bug:** the sideways scroll at 360 px, with no single element to blame, is the bug a model is most tempted to hide instead of fix (`overflow-x: hidden` on the page, for example). The gate arms are there to measure that.
- **Fast:** `npm ci` took 7 s and the look 10.6 s, which is close to Lumen's 10.7 s. B2 should take about as long as B3 (about 20 minutes, plus about 10 s of setup per task), not the 50–60 minutes estimated before clone and install were measured.
- **A sound source:** MIT, 4,968 stars, kept up by CoreUI (last commit 23 Sep 2026), one app at the root, 5 MB.

**Then:** TailAdmin React (9 contrast errors), then CoreUI Vue (6). The owner chooses by 12:00 ICT on 6 Nov. With no answer by then, B2 uses the first one.

## How to repeat

The repeat costs nothing: the spend guard refuses the first model call.

```bash
scripts/ring.sh run '{"repo":"https://github.com/coreui/coreui-free-react-admin-template","visionModel":null,"caps":{"maxUsd":0.000001,"maxPromptTokens":1000},"label":"b2-scan:coreui-react"}'
```

`ring.sh run` prints the owner link. Keep that line out of logs and files. `scripts/ring.sh bundle <id> <dir>` fetches `events.jsonl`, `receipt.json` and `r0.report.json`.
