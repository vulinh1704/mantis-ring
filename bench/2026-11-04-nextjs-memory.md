# Next.js on the GitHub path: the sandbox ran out of memory (4 Nov 2026)

The B2 scan ([2026-11-04-b2-candidates.md](2026-11-04-b2-candidates.md)) found that both Next.js 16 repositories failed every time. The dev server answered, then `mantis look` ended within 5 s with an exit code of 128 or more. The page said "the measurement timed out", and the journal kept neither the exit code nor stderr. This note finds the cause on the VM and shows the fix.

- **When:** 4 Nov, 10:04–10:25 UTC (17:04–17:25 ICT), one task at a time, the VM idle before each.
- **Where:** the VM, every sandbox under gVisor (`runsc`), with the usual limits: 3 GB of memory with no swap (the tmpfs folders count too), 2 CPUs and 512 processes.
- **The tasks:** admin GitHub tasks with the default matrix (route `/`, mobile and desktop, light and dark, English: 4 screens), labelled `next-look:*` and `proxy-403:*`.

## No model was called

Each task was:

```json
{"repo":"https://github.com/<owner>/<name>","visionModel":null,"caps":{"maxUsd":0.000001,"maxPromptTokens":1000},"label":"<label>"}
```

Checked again on `b456153`:
- A task reaches a model only through `chat()` (`agent/inference.mjs`), and the app gives each task its own spend guard (`app/server.mjs`). `visionModel: null` gives the loop no vision function.
- `chat()` asks the guard before every attempt. The guard checks prompt tokens first (`app/spend.mjs`). The system prompt and the seven tool schemas alone come to 1,466 tokens, counted as the guard counts them, before the task message. The cap is 1,000, the lowest the config allows, so the first call is refused and nothing is sent.

**Result:** no task had a model call. The two receipts of tasks that reached the model loop show 0 calls and $0. ray-so logged "budget reached (tokens): no further model call". `/admin/spend` read $0.916647 before the first task and after the last.

## What the journal showed

The runner now records why a look failed. See "What changed" below.

| Task | Commit | Before the look | During the look | Look | What the host saw |
|---|---|---|---|---|---|
| `t_26714472b6ef9ef852d8321929f313be` next-shadcn-admin-dashboard | `b456153` | not recorded yet | at most 3.00 of 3.00 GB; processes at most 89 of 512 | exit 128 after 2.7 s | memory at the limit 1,563 times, 87 OOM events, 1 OOM kill |
| `t_edca015ec830cfdae0a40dec180b532f` next-shadcn-admin-dashboard | `1883914` | 1.98 of 3.00 GB, 62 processes | 1.98 → 3.00 GB; processes 67 → 93 | exit 128 after 5.8 s | at the limit 48 times, 2 OOM events, 1 OOM kill; Docker: OOM-killed |

In the second run, stderr ended with `waiting on PID 190 in sandbox "…": urpc method "containerManager.WaitPID" failed: EOF`. The sandbox kernel itself was gone, and the post-mortem `docker exec` failed at once with exit 128.

Before that look, the sandbox held:
- **Files in tmpfs (RAM): 0.98 GB.** That is `node_modules` 0.64 GB, npm's download cache 0.17 GB and `.next` 0.04 GB; the rest is the clone.
- **Processes: 8, with 82 threads.** Each process's resident memory, shared pages counted in each: the Next.js server (`next-server`) 0.72 GB, then five more `node` processes of 0.15–0.24 GB each. Those are the `next dev` parent and Turbopack's Node workers.

## The cause

**Memory.** It was not the time limit, not the process limit (at most 93 of 512), not the proxy, and not Chromium on its own.

1. A Next.js 16 dev server and the project's files held about 2 GB of the sandbox's 3 GB before the first look.
2. Mantis then opened four pages at once: two route × viewport groups (its default allows 3), each with its light and dark pages.
3. Within 3–6 s that passed 3 GB.
4. The host kernel's OOM killer then killed the sandbox's kernel (gVisor's Sentry), so the whole sandbox stopped. `docker exec` returned 128.

The old runner counted every exit code of 128 or more as a timeout.

## What changed

- **`b456153`, `1883914`: a failed look says why.**
  - Only the time limit is a timeout: exit 124, the host's own timer, or 137 once the limit has passed. Any other exit code of 128 or more names its signal and how long the look ran.
  - While each look runs, the runner watches the sandbox's host cgroup (`runner/cgroup.mjs`). It records the memory and processes at the start and at most, and what the kernel counted at their limits.
  - After a stopped look, it reads the sandbox at once: Docker's state, every process left, the tmpfs folders, the dev server and the end of its log.
  - All of this goes to the journal in short lines, with credentials redacted. The page names the memory limit, the process limit or a stopped sandbox when the host showed one; otherwise it says the checker stopped unexpectedly.
  - Before the first look of a GitHub task, the journal records what the sandbox holds.
- **`86c0e9d`: room in memory for the project.**
  - npm's and yarn's download caches are removed after a successful install.
  - The warm-up also asks for the scripts and stylesheets that the page names on its own origin.
  - The looks of a GitHub task open one route × viewport group at a time (`mantis look --concurrency 1`), that is, its light and dark pages together. The samples keep Mantis's default of 3.
- **`c4165da`: say so.**
  - When less than 1 GiB is free before the first look, the live log says that measuring may run out of memory, and names what is used of what.
  - When a later check or the verify look takes the sandbox down, the run ends with that reason ("The run stopped at check 2: the sandbox ran out of memory …"), not as an internal error during the rollback.

## After the fix

On `86c0e9d`:

| Task | Repository @ commit | Install | Warm-up | Before the look | Look | During the look | R0 | Result |
|---|---|---|---|---|---|---|---|---|
| `t_2d99fb20b6a4b8407fcf012c91633822` | next-shadcn-admin-dashboard @ `bd98e04` | 12.7 s (npm ci) | `/` 200 in 96 ms, 23/23 assets in 212 ms | 1.77 of 3.00 GB, 59 processes | 6.3 s | at most 2.35 GB, never at the limit; at most 84 processes | 0 errors, 0 warnings in 4 of 4 screens, HTTP 200 | done: no-issues, no model call |
| `t_0faa131192d713f003f114633667f91d` | ray-so @ `54a5a0d` | 13.7 s (npm ci) | `/` 200 in 80 ms, 29/29 assets in 357 ms | 2.28 of 3.00 GB, 67 processes | 8.4 s | at most 2.89 GB, never at the limit; at most 92 processes | 3 errors (contrast), 1 warning (tap target) in 4 of 4 screens | done: the guard refused the first model call; 0 calls, $0 |

- **next-shadcn-admin-dashboard.** The page loaded on every screen; its title was "Studio Admin: Open Source shadcn/ui Admin Dashboard". Its landing page is clean, and Mantis notes that its dark mode is a class toggle.
- **ray-so.** Its errors are grey text on its dark panels: 3.48:1, 3.81:1 in 4 elements, and 2.62:1.
- **Where the room came from.** The npm cache gave back 0.17 GB. With one group at a time, the look of next-shadcn-admin-dashboard took 0.57 GB on top of what the sandbox held, against more than 1 GB with four pages at once. The asset warm-up took a fraction of a second on both apps, so Turbopack had most of the browser's bundle ready already. It costs little and helps a dev server that builds on demand.

**The 403 sentence** (`86c0e9d`, task `t_f10ed2265382703606cd11279d6bfb87`, omni-tools @ `9244e02`). npm printed `npm error code E403` and `403 Filtered - GET https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. The page now says "The install tried to reach cdn.sheetjs.com, which is outside the sandbox's allowlist (only npm and GitHub)." Before, it said only that the dependencies could not be installed.

## What is left

- **ray-so came within 0.11 GB of the limit.** A larger Next.js app, or a check after edits that grow the dev server, can still run out of memory.
  - When that happens, the page says so, and the live log warns before the first look.
  - What remains is mostly the dev server (about 1 GB, with 4 or 5 Turbopack Node workers) and `node_modules` in RAM (0.63 GB). Neither is Ring's to shrink without changing the project or the sandbox.
- **4 GB per sandbox would give a margin.** The VM has 16 GB and runs at most 2 tasks. That changes a published limit (3 GB in the docs, the live log and the video), so it is the owner's call.
- **The samples are unchanged.** They keep Mantis's default concurrency and have no install, so B3 on Lumen runs as before. B2 (CoreUI React, a GitHub task) now opens one group at a time, so its looks take somewhat longer than the scan's 10.6 s.

## How to repeat

The repeat costs nothing: the spend guard refuses the first model call.

```bash
scripts/ring.sh run '{"repo":"https://github.com/raycast/ray-so","visionModel":null,"caps":{"maxUsd":0.000001,"maxPromptTokens":1000},"label":"next-look:ray-so"}'
scripts/ring.sh logs | grep '<task id>'
```

`ring.sh run` prints the owner link. Keep that line out of logs and files. The journal lines that start with `before the baseline look:` and `baseline look usage:` hold the memory figures.
