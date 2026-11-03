# Mantis Ring: architecture

A coding agent fixes UI bugs in a web project it is handed. It can punch, but not outside the ropes:
- every action runs in a throwaway sandbox;
- the model never sees a secret;
- a fix that only hides a bug is refused;
- nothing is applied anywhere, and the owner can download the patch only after approving it.

```
Visitor ──HTTPS──► Vultr VM (VX1, Seattle)
                   ├─ Caddy: HTTPS · /latest/ as static files · everything else ─► the app
                   ├─ app: Node 22, user ring-orch, one listener on 127.0.0.1:8080
                   │    pages, API, live events (SSE), queue, spend ledger, publisher
                   │    └─ agent loop ── chat() ──► Vultr Serverless Inference (OpenAI-compatible)
                   │         │                       fix model and vision model; the key stays in this process
                   │         └─ file tools ── docker exec, positional arguments ──► the task's sandbox
                   ├─ Docker + gVisor (runsc): one sandbox per task, destroyed when the task ends
                   │    Node 22, git, Chromium headless shell, Mantis CLI 0.7.1
                   │    no host environment · read-only root · 3 GB RAM, 2 CPUs, 512 processes · uid 10001
                   │    its own network ring-task-<id> (no route out) ─► ring-proxy (allowlist) ─► npm, GitHub
                   └─ files: task records, receipts, spend ledger (private) · published runs (/latest/)
Operator (WSL) ──SSH as deploy──► curl http://127.0.0.1:8080/admin/…   (scripts/ring.sh)
```

## One task

1. **The request.** A task names the Lumen sample or a public GitHub repository, with routes and languages. Public tasks are closed for now (`publicRuns` is false), so tasks come from the admin channel, which may also choose screen sizes, colour schemes, the model, the vision model (or none), the gate and the caps.
2. **The sandbox.** `Sandbox.create()` (`runner/sandbox.mjs`) starts a fresh container from `mantis-ring/sandbox`:
   - `--read-only`, with tmpfs for `/work` (2 GB), `/tmp` (512 MB) and the home directory (1 GB);
   - `--memory 3g` with no swap, `--cpus 2`, `--pids-limit 512`, `--cap-drop ALL`, `no-new-privileges`;
   - an unprivileged user (uid 10001);
   - on an internal network of its own, `ring-task-<id>`, made for it and removed with it (see [The sandbox's network](#the-sandboxs-network)). No other sandbox is on it, so two tasks that run at once cannot reach each other. Its single exit is `ring-proxy`, which lets through `registry.npmjs.org`, `github.com`, `codeload.github.com` and `objects.githubusercontent.com` on port 443 and refuses every other host. The proxy's address on that network is written into the sandbox's `/etc/hosts` (`--add-host`), because under gVisor Docker's embedded DNS cannot be reached and the name would not resolve;
   - no environment from the host. The inference key stays in the app's process;
   - `--runtime runsc` on the VM. The loop reads the runtime back from Docker, logs it and puts it on the receipt.
3. **Bring in, install, serve** (`runner/run-task.mjs`). The sample is copied in as a tar stream of our own files. A GitHub repository is cloned inside the sandbox through the proxy (`git clone --depth 1`), from a URL rebuilt out of the checked owner and name, so the host never fetches a URL a user typed. Then `npm ci` or `npm install` (at most 5 minutes) and the project's dev server on port 3000. Lumen is static, so it gets a small static server.
4. **R0, the baseline.** `mantis look … --baseline none --json` measures every route × screen size × colour scheme × language. The screens R0 could measure are the ones every later check must measure again. If R0 finds no issue, the task ends with the verdict `no-issues` and no model call.
5. **The conversation** (`agent/loop.mjs`). The model gets Ring's system prompt (`agent/prompt.mjs`, version `ring-2`), a task message with R0's issues, and the seven tools below. It works until it calls `finish` or a cap stops it.
6. **Checks.** When the model calls `check_ui`, the orchestrator measures again, compares with R0 and decides what stays (see [Each check, against R0](#each-check-against-r0)).
7. **The final state.** Edits that were never measured get one last check if a check and the time are left; otherwise they are rolled back. No unmeasured edit reaches the patch. The final run (RF) is the last accepted check, or a fresh verify look when a rollback came after it (a verify look does not count as a check).
8. **The patch.** `git diff --binary` from the starting snapshot, limited to the files the model wrote, so files that the install or the dev server changed never pollute it. `git apply --check` then tests it on the original files, in a throwaway worktree, and the receipt records the answer. A patch over 1 MB is stored cut and flagged.
9. **Wrap-up, still inside the sandbox:** a proof sheet (`mantis proof`, R0 against RF), then the files are copied out one by one (see [Copying files out](#copying-files-out)). Then `destroy()`: `docker ps -a` must no longer list the container, and its network goes after it.
10. **Vision** runs after the sandbox is gone, on bytes already copied out (see [The vision second opinion](#the-vision-second-opinion)).
11. **The receipt** is written (see [The receipt](#the-receipt)). The owner may approve the run and then download the patch. The demo never applies a patch anywhere.

Every task has a wall clock: 15 minutes for the sample, 20 for a GitHub repository. A hard timer destroys the sandbox at the deadline, and no model call runs into the last 150 s. Every exit path, failures included, destroys the sandbox and its network. By default the app runs at most 2 tasks at a time, with 2 slots for the heavy steps (install, look, proof) and at most 8 tasks waiting.

## The sandbox's network

Before commit `08030d6`, every sandbox joined one shared network, `ring-internal`, so two tasks running at once could reach each other's dev servers. Now each sandbox has a network of its own (`runner/sandbox.mjs`):

1. `Sandbox.create()` makes `ring-task-<id>` with `--internal` (no route out), labelled `mantis-ring=task`, with the container's own labels and `mantis-ring.sandbox=<name>`.
2. The running `ring-proxy` joins it (`docker network connect`). The proxy's address on that network goes into the sandbox's `/etc/hosts`.
3. The container starts on that network only. A failure at any step removes whatever was made before the error is raised.
4. `destroy()` removes the container, then takes the proxy off the network, then removes the network, and resolves only when `docker network ls` no longer lists it. If the container will not go, the proxy still leaves, which cuts the container's only way out. The agent loop tries the clean-up once more, by name and by the task's label, whenever `destroy()` failed.

On the VM the proxy has an address on `ring-egress` (its way out) and one on each running task's network. It relays only to the four allowlisted hosts on port 443, so a request through it to another sandbox, by address or by name, gets 403.

**Nothing piles up.** Each network takes one of Docker's address pools (about 30 on a stock daemon), so none may leak. The app removes its own containers and networks at startup and shutdown. At startup and every hour it also removes any sandbox network, by label and name, that no sandbox runs on and that is older than 10 minutes; younger ones are left alone, because a sandbox may be starting on one. `containment.mjs` and the agent-loop scenarios sweep the same way before they start, and a self-test stopped by a signal destroys its sandboxes and their networks before it exits. `/admin/health` counts the app's networks. `scripts/setup.sh` no longer creates `ring-internal`; when it restarts the proxy, it removes `ring-internal` and every unused sandbox network. On the VM, `ring-internal` stays, with only the proxy on it, until `ring-setup` runs again.

## The tools

The model sees the project only through seven tools (`agent/tools.mjs`). Their schemas are frozen and the same in both gate arms.

| Tool | What it does | Limits |
|---|---|---|
| `list_files` | Lists the project's files with their sizes | 400 files; dependency, build, `.git` and `.mantis` folders left out |
| `read_file` | Reads a text file with line numbers, in parts | 400 lines by default, long lines cut at 2,000 bytes; refuses files over 2 MB and binary files |
| `search_code` | Finds a regular expression, or plain text, in the project | 80 matches of up to 300 characters |
| `replace_in_file` | Replaces one exact piece of text that appears once in a file | Files up to 1 MB of UTF-8 text |
| `write_file` | Creates a file, or overwrites a small one | 200,000 characters |
| `check_ui` | Asks for a check: Mantis measures every screen again | 3 per task |
| `finish` | Ends the task with a summary for the reviewer | The summary is kept as the model's own words, not as a measurement |

- **No shell.** The file tools run fixed scripts inside the sandbox through `docker exec`, with the model's values passed as separate arguments, never spliced into a shell string. The model has no shell and no network tool.
- **Paths are checked twice:** on the host (`safePath`), and inside the sandbox after `realpath`, because a repository can ship symlinks. Anything outside `/work/app`, dependency and build folders, `.git`, `.mantis` and `.env` files is refused. Package manifests, lock files and git config files can be read but not written, because dependencies are never reinstalled during a task. A write refuses symlinks and hard links.
- **Caps per task:** at most 20 new files and 50 changed files. Output is capped inside the sandbox, and each tool result is at most 12,000 characters. A refusal reads `error: <one sentence>`, never a stack trace or a host path.
- **How `check_ui` behaves.** It runs after the other calls of the same turn, so edits later in the batch are measured too. A check with no edit since the last one is not counted. After the last check, edits are locked and the model gets one more turn to call `finish`; the loop asks for it with a forced `tool_choice` and ends the task itself if the model ignores that. After 14 turns without a check, pending edits are checked anyway.
- **Turns:** at most 12 tool calls per turn and, by default, 36 turns per task. After each check, older `read_file`, `search_code` and `list_files` results in the conversation are replaced with a short note, so the prompt stops growing with every file read.

## Each check, against R0

Every check is Mantis measuring the whole matrix again with `--baseline <R0 dir>`, never `auto`: after a rollback, `auto` would compare with the rejected run. So the numbers the model reads, the decision and the receipt line always mean "compared with the starting point".

Before the look, the loop stages everything in git (files the model wrote are added even when the project's `.gitignore` ignores them), and the diff since the last accepted state goes to the tamper guard. If the dev server stopped answering, it is restarted first. Then the first matching row decides:

| Order | What was found | Decision | What happens |
|---|---|---|---|
| 1 | The diff adds a word aimed at the checker ([the tamper guard](#the-tamper-guard)) | `tamper` | Rolled back, with the gate on or off |
| 2 | The check could not measure every screen R0 measured: the look failed or timed out, the dev server would not start again, more screens crashed than in R0, or a screen dropped out | `failed` | Rolled back, with the gate on or off |
| 3 | Mantis reports a cover-up, gate on | `reverted` | Rolled back. The model is told which element and how it was hidden, and to fix the cause |
| 3 | Mantis reports a cover-up, gate off (the admin-only control arm) | `kept` | Kept. The cover-up and lost lines are left out of what the model reads |
| 4 | Mantis reports lost controls (a visible control or heading is gone), gate on, on the sample | `lost` | Rolled back like a cover-up. On a GitHub repository this is only reported, and the verdict cannot be better than `partial` |
| 5 | None of these | `accepted` | A git snapshot; later rollbacks return to it |

- **A rollback** is `git reset --hard` to the last accepted snapshot. Everything was staged first, so files the model created in that round are removed too. Then `git diff --quiet` against the snapshot must be clean, or the task stops.
- **A screen that drops out** counts as a failed check because Mantis compares only the screens it could measure. Without this row, an edit that breaks a whole page would read as "1 fixed · 0 new".
- **Public tasks** always have the gate on. Only an admin task can switch it off.
- The model then reads the result: the Mantis line, what is fixed, what is new, what is still open and the checks left, or on a rollback what was undone and why.

## The tamper guard

Mantis skips elements marked `data-mantis-ignore`, and anything inside `data-mantis-overlay`. An edit that adds the attribute would make an issue vanish while the element stays as broken as before, and Mantis would count it as fixed, with no cover-up. Code that behaves differently in a headless browser has the same effect.

So before each check, `tamperHits()` (`agent/workspace.mjs`) scans the lines the diff adds since the last accepted state, ignoring case, for:
- the checker's names: `data-mantis…`, `mantis-ignore`, `mantis-overlay`, `mantis`;
- headless-browser and automation checks: `navigator.webdriver`, `webdriver`, `HeadlessChrome`, `headless`, `userAgent`, `playwright`, `puppeteer`, `__nightmare`, `cypress`;
- the usual ways to hide such a word: `atob(`, `fromCharCode`, `fromCodePoint`, and `\xNN`, `\u00NN` and `\u{…}` escapes. String literals split with `+` or `,` (`'data-man' + 'tis-ignore'`) are joined before the scan.

The diff is taken with `git diff --text`, so a `.gitattributes` that marks a file as binary cannot hide its added lines. A hit rolls the check back with the gate on or off, and counts as a tamper attempt on the receipt. It is a list of words, so it raises the bar rather than closing the door (README, Known limits).

## Copying files out

Nothing made inside the sandbox is unpacked on the host. A project's own code runs as the same user as Mantis, so it could plant symlinks among Mantis's output. A host-side `tar -x` would recreate them, and anything that later read or served those files would follow the links, for example to a file that only the app's user may read.

So the loop copies each file on its own with `Sandbox.readFile()`:
- inside the sandbox, the path must be a regular file, not a symlink, and under the size limit; only then is it printed with `cat`;
- on the host, the bytes go into a name the host chooses: `proof.png`, `contact-before.png`, `contact-after.png`, `shot-before-1.png` and so on;
- a PNG must start with the PNG signature and be at most 20 MB, and JSON must parse and be at most 8 MB. Screenshot paths must match `shots/<name>.png`.

The reports come from `mantis look --json` on stdout, and the files Mantis wrote next to them are read the same way. The app writes each task's files itself, under fixed names (`[a-z0-9][a-z0-9_.-]*`), and an admin bundle is the host's own `tar` over those files, with the private part of `task.json` (the client's network and the owner token's hash) left out. The runner's older `copyOut()`, used only by `runTask()` (the runner's command line and the time-limit tests, never by the app), deletes everything but regular files and folders after it unpacks.

## The vision second opinion

A task has a vision model by default, `qwen3.8-27b`; an admin task can set `"visionModel": null`. Up to four issues that Mantis measured as fixed (or as covered up, in the control arm) are shown to it as a BEFORE and an AFTER crop of the same area, cut from the screenshots of R0 and RF, with the issue text and the diff. Cover-ups come first, then the issues by type. The model is never told what Mantis decided, so its agreement is an independent number. It answers in a strict JSON schema: `fixed`, `cover_up`, `regressed` or `unclear`.

The answer is shown next to the receipt and never changes the counts, the gate or the publish bar: Mantis's measurement decides. It runs after the sandbox is destroyed, on bytes already copied out, two requests at a time (`agent/vision.mjs`, `agent/png.mjs`).

## Who can do what

The app has one HTTP listener, on `127.0.0.1:8080`, and Caddy forwards public traffic to it. A request counts as **admin** only when all three hold: the peer is loopback, there is no `X-Forwarded-For` header (Caddy always adds one), and the `Host` is `127.0.0.1` or `localhost`. Any other request for `/admin/*` gets the same 404 as an unknown path.

| Who | How | What they can do |
|---|---|---|
| Anyone | HTTPS through Caddy | Read the home page, `/status`, `/latest/`, a run's page, its live events and its images. Start a run on the sample (or, through the API, on a public GitHub repository), but only while public runs are open; now `POST /api/tasks` answers 503. Even when they are open, a client with a loopback or private address is refused, and limits apply per network and per day. |
| A run's owner | The owner link, `/t/<id>#owner=<token>`, in a browser | Cancel the run; approve it once it is done with a patch; then download the patch. The page moves the token to the tab's session storage and removes it from the address bar. The server keeps only its SHA-256. |
| The operator | SSH to the VM as `deploy`, then `curl` to `127.0.0.1:8080` (`scripts/ring.sh`) | Start runs (the sample or a GitHub repository; any model in `allowedModels`; vision on or off; the gate on or off; caps up to the admin limits), watch them, read records, receipts and transcripts, download a task's files, cancel, publish a run that passes the bar, run probes and self-tests, read spend and change settings. **Never approve.** |

**The VM's users.** The app runs as `ring-orch`, which is in the `docker` group. The inference key sits in `/etc/mantis-ring/secrets.env` (mode 600, owned by `ring-orch`), and systemd puts it in the app's environment. The operator logs in as `deploy`, which can copy code to `/srv/mantis-ring`, restart the service and read its status, and run `ring-setup` and `ring-selftest` as `ring-orch`. It is not in the `docker` group and cannot read the secrets file. The split keeps the key out of the operator's shell. It is not a wall: `deploy` ships the code that `ring-orch` runs, as the header of `scripts/vm-bootstrap.sh` says.

**Approval and the patch.**
- `POST /api/tasks/<id>/approve` needs the owner token in the `x-ring-owner` header, a finished run with a non-empty patch, and a request that does not come from the admin channel.
- When the owner sets `RING_APPROVE_PASSPHRASE_SHA256` in the service's environment, Approve also needs that passphrase, with 5 wrong tries per run before it is refused until a restart.
- The record keeps which of the two approved the run, and the published page says no more than that: "Approved by a human at …, with the owner's approval passphrase", "Approved with the owner link at …", or "Not approved (patch shown for review only; nothing was applied anywhere)".
- `GET /api/tasks/<id>/patch` needs the owner token and an approved run.

**Publishing** (`POST /admin/publish/<id>`, never automatic):
- The bar: verdict `pass`, no lost control, every screen R0 measured compared, a patch that applies and was not cut, a sample project, a `REAL RUN` label and a sandbox confirmed destroyed. Otherwise the answer is 409 with the reasons.
- The page is built in a staging folder, renamed into place, and the `latest` symlink is swapped with a rename, so `/latest/` never shows half a run. It has no script and its own CSP, and every string on it is HTML-escaped. It holds the receipt, the proof sheet and contact sheets, `patch.txt`, `receipt.json`, and `containment.txt` with the last self-test results.

**Settings** (`app/config.mjs`, changed through `/admin/config`, validated, unknown keys refused):
- `fixModel` `deepseek-v4.1-flash-1017` and `visionModel` `qwen3.8-27b`;
- `fallbackModel` `minimax-m3.1-flash`: a stored setting for a manual switch, since the app never switches models by itself;
- `allowedModels`: the 7 models with a pinned list price. A model outside the list cannot be chosen, and the spend guard refuses a call to a model with no known price, except that a public task falls back to a daily token budget;
- `publicRuns` false, and `maxRunning` 2. `scripts/ring.sh` refuses to send a change to `publicRuns` unless the owner takes a second, explicit step.

The spend ledger (`app/spend.mjs`) is append-only and checks, before every model call, the task's cap ($0.60 by default, at most $2 for an admin task), the day's cap for public or admin runs ($5 and $15) and the total cap ($60), all at list price.

## The receipt

Each finished task gets `receipt.json` (schema `mantis-ring/receipt@1`, built by `agent/receipt.mjs`), `receipt.md` with the same facts, and `patch.diff`. Next to them are the reports of R0, of each check and of RF, the event stream, the conversation transcript (admin only), the proof sheet and the contact sheets. [bench/2026-11-04-lumen-t2/receipt.json](../bench/2026-11-04-lumen-t2/receipt.json) is a real one.

- **`line` and `counts`:** Mantis's own line, `N fixed · N new · N cover-ups · N lost`, taken from the final run's comparison with R0 and never from the model; errors and warnings before and after; screens compared against screens expected.
- **`label`:** `REAL RUN · Vultr VX1 sea · <UTC time>` only when the calls went to `api.vultrinference.com` and the sandbox ran under `runsc`. Otherwise it is `TEST RUN · <runtime> · <host>`, which can never be published.
- **`trust`:** on the sample, "Verified: re-measured by Mantis (no LLM) against the original baseline." On a GitHub repository, "Measured inside the repo's own sandbox", because the repository's own code ran next to the checker.
- **`verdict`:** `pass` when something was fixed and nothing is new, covered up or lost, on every screen R0 measured; `partial` when something was fixed but not all of that holds; `fail` when nothing was fixed; `no-issues` when R0 found nothing. **`publishable`** is true for a `pass` on the sample with a `REAL RUN` label and a sandbox confirmed destroyed; the publisher also checks the patch.
- **`gate` and `checks`:** whether the gate was on; cover-up, lost-control and tamper attempts; rollbacks; and one row per check with its decision, its Mantis line and its time.
- **`stopReason`:** `finish`, `checks`, `turns`, `time`, `budget`, `inference`, `no-tools` or `no-issues`.
- **`models`, `tokens` and `usd`:** per role (fix, vision), the calls and the prompt, completion and reasoning tokens, with the list price used. A model without a known price makes `usd` null, shown as "cost n/a", never $0.
- **`time`:** seconds per phase: sandbox, clone, install, serve, baseline, model, tools, checks, verify, proof, copyOut, destroy, vision.
- **`diff`:** files, lines added and removed, bytes, SHA-256, and whether it applies to the original.
- **`vision`:** the second opinion, pair by pair.
- **`summary`:** the model's own words, marked as not measured.
- **`containment`:** the runtime, the sandbox's name, its limits, its own network (`ring-task-<id>`), and whether `docker ps -a` confirmed it gone, with the time.
- **`mantis`** and **`promptVersion`:** the Mantis version, the run ids of R0 and RF, and the prompt version (`ring-2`).

## Containment, measured

`node test/containment.mjs` checks each claim against a fresh sandbox (16 checks):

| Claim | How it is checked |
|---|---|
| No secrets inside | A fake API key in the host environment is absent from `env` in the sandbox |
| Unprivileged | `id -u` is not 0 |
| Read-only root | `touch /usr/local/bin/x` fails |
| No direct internet | A TCP connect to 1.1.1.1:443 fails |
| Allowlisted egress only | `git ls-remote` works for github.com and is refused for gitlab.com |
| No exfiltration | `fetch('https://example.com')` fails |
| Tasks cannot reach each other | Two sandboxes start at once, each with a server on port 3000 on all its addresses. Each is alone on its own network. Neither reaches the other by address with a TCP connect, an HTTP request or an ICMP echo, and through the proxy a request by address, a CONNECT and a request by name all get 403. Each still reaches the proxy, and the proxy answers its ICMP echo, which shows that ping works in the sandbox |
| Process cap | Trying to start 700 processes ends at or below 512. Under gVisor the cap also counts the sandbox kernel's own threads, so the bomb stops the whole sandbox before 700 processes start |
| Memory cap | An allocation loop is stopped at the 3 GB cap. runc kills it with exit 137; under gVisor the sandbox kernel stops it, and the check reads how much it held when it stopped |
| Time limit | A task whose dev server never answers is stopped and its container removed |
| Cleanup | No container is left after a task, and none of the suite's five sandbox networks is left or still has the proxy on it |

The two-sandbox check also prints a note that is not part of any check: whether a sandbox can open a connection to the VM itself through its network's gateway address. On the VM it can (README, Known limits).

`node test/scenes.mjs` plays the containment scenes with two fixtures from `test/fixtures/` (test data, run only inside a fresh sandbox; 17 checks):
- a hostile repository that hunts for secrets, calls hosts off the allowlist (the cloud metadata address included), runs `rm -rf` on the whole filesystem and spawns processes without end;
- a dev server that never answers and ignores SIGTERM.

`node test/agent-loop.mjs` drives the loop with a fake model in real sandboxes (scenarios S1–S10): an honest fix, a cover-up with the gate on and off, a measurement tamper, paths out of the project, every cap, malformed tool calls, an inference error, a dev server that dies, a route that stops loading and a link the edit removed. After every scenario, the sandbox and its network must be gone. Its unit part (`--unit`, no Docker) includes U11, which drives the network's life cycle against `test/fake-docker.mjs`, a stand-in for the docker CLI, so that every failure path runs: a `docker run` that fails, a proxy that cannot join, a network that will not go at once or at all, the sweeps and a test stopped by a signal.

All three take `RING_RUNTIME=runsc` to run the sandboxes in gVisor, and a full run of each writes the result file that `/status` shows. On the VM, on commit `2e01f41` under gVisor, they passed 16/16, 17/17 and 91/91 (3 Nov, 21:53–21:59 UTC). The first scenes run that night gave 16/17: in the endless-spawn scene, gVisor stopped the whole sandbox at the process cap after 9 s, instead of holding it there until the 20 s limit. The same commit then passed 17/17. The containment fork bomb already accepts that outcome under gVisor; the scene does not yet. Before the per-sandbox networks, on `0c2e46d`, the suites passed 13/13, 17/17 and 83/83.

## Built before the event vs during it

The organisers' build start was 3 Nov 2026, 16:00 UTC (23:00 ICT).

| Part | AI? | When |
|---|---|---|
| Mantis CLI (MIT, npm `@vulinh1704/mantis`, 0.7.1 in the sandbox), including its cover-up detection | no | before; an existing open-source library |
| Mantis's buggy-app test fixture (13 planted bugs and their answer key) | no | before; copied into `demo/lumen` during the event, without the answer key |
| Mantis agent skills (`plugins/mantis/skills/`, including the `mantis-fix` prompt) and MCP server (`src/mcp.js`) | yes (prompts, tool schemas) | before; published with Mantis, listed in the README; Ring uses neither |
| Sandbox image, allowlist proxy, runner, containment tests and fixtures, VM bootstrap script (this repository up to the `pre-event-final` tag) | no | before (commits of 30–31 Oct) |
| Ring's prompts and tool schemas (written fresh), the Serverless Inference client with its probe and spend guard, the agent loop that the existing Mantis cover-up check gates, the vision second opinion, the web app | yes / product | during; commits from 3 Nov, 18:07 UTC (`aef5786`) |
| Runner and sandbox changes for the loop, the Lumen sample, deploy and admin scripts, tests, bench tooling | no | during; commits from 3 Nov, 16:53 UTC (`b07c0ad`) |

The README's "Built before the event" section has the details and the tags.
