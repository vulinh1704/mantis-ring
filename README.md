# Mantis Ring

A boxing ring for coding agents that fix UI bugs. They can punch, but not outside the ropes:
- every action runs in a throwaway sandbox;
- the model never sees a secret;
- a "fix" that only hides a bug is refused;
- nothing is applied anywhere, and the owner can download the patch only after approving it.

Built for the Vultr Agent Rush hackathon (Challenge 1, Blast Radius Zero). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

The demo runs on a Vultr VM at https://104-156-252-200.sslip.io, with every task sandbox under gVisor (`runsc`). The VM runs commit `0c2e46d`. Later commits change only `bench/` and the docs.

**Built before the event (non-AI scaffolding):**
- the task sandbox;
- the egress allowlist proxy;
- the runner that clones, installs, serves and checks a repository with [Mantis](https://github.com/vulinh1704/mantis);
- the containment tests, with two fixtures: a hostile repository and a dev server that never exits;
- the VM bootstrap script, which the owner runs as root.

**Built during the event, and deployed:**
- **The agent loop** (`agent/loop.mjs`), with Ring's prompts and tool schemas written fresh (`agent/prompt.mjs`, `agent/tools.mjs`). The model works through seven tools. Each check is Mantis measuring every screen again and comparing it with the starting point, the baseline run R0. A cover-up, a control or heading that disappears from the sample, an edit aimed at the checker, and a check that cannot measure every screen are all rolled back with git. An admin-only control arm can turn the gate off, and then cover-ups are kept. The orchestrator, not the model, caps checks, turns, tool calls, tokens, money and wall clock.
- **The Vultr Serverless Inference client** (`agent/inference.mjs`), with a probe per candidate model (`agent/probe.mjs`), pinned list prices (`agent/prices.mjs`) and a spend ledger whose guard fails closed (`app/spend.mjs`).
- **The vision second opinion** (`agent/vision.mjs`): up to four before/after crops go to a vision model, `qwen3.8-27b` by default. It never changes the counts, the gate or the publish bar.
- **The web app and orchestrator** (`app/`): a queue, live progress over Server-Sent Events, the receipt page, Approve and the patch download for the run's owner, `/status`, the published "Latest verified run" at `/latest/`, and a local-admin API that answers only local requests.
- **The rest:** the deploy and admin scripts (`scripts/deploy.sh`, `scripts/ring.sh`), the Lumen sample (`demo/lumen`), the new tests (`test/fake-gateway.mjs`, `test/agent-loop.mjs`, `test/app-api.mjs`) and the bench tooling (`bench/`).

**Measured on the VM** on 3 Nov between 19:28 and 20:53 UTC (02:28–03:53 ICT on 4 Nov):
- Self-tests on `0c2e46d`, sandboxes under gVisor: containment 13/13, scenes 17/17, agent-loop 83/83. The agent-loop suite drives the loop with a fake model and spends no tokens.
- The first calls to the real Vultr Serverless Inference, a tool-calling probe ([bench/probe-2026-11-04.md](bench/probe-2026-11-04.md)): all five candidate text models passed the two steps the bake-off needs. It also settled three open questions. The gateway accepts an assistant message sent back with its `reasoning` field (the client still strips it). It accepts a forced `tool_choice`, but `minimax-m3.1-flash` ignores it, so the loop keeps ending a task itself. And it accepts a strict `json_schema` response format for the vision model.
- One real run on Lumen, and a bake-off of three models: see [First real runs](#first-real-runs).
- The probe, the real run and the bake-off cost $0.839 together, at list price.

**Not done yet:**
- **Public runs are closed.** `publicRuns` is false, so the "Run sample" button is disabled and `POST /api/tasks` answers 503. Runs start only through the admin channel.
- **No GitHub repository has gone through the loop yet.** The code path exists (a clone through the proxy, an install, the project's own dev server, a 20-minute limit), but it has not been run or timed on the VM.
- **A harder benchmark.** Every bake-off run fixed everything Mantis found on Lumen, so Lumen no longer tells these models apart.

## First real runs

All of them ran on the VM under gVisor, on commit `0c2e46d`, on the Lumen sample: 2 pages × mobile and desktop × light and dark × English and Vietnamese, 16 screens. Lumen is built from Mantis's buggy-app test fixture, which has 13 planted UI bugs; the model is never told about them. After each run, `bench/grade-lumen.mjs` checks the planted bugs on the host against Mantis's answer key, which never enters a sandbox.

**T2, one run with the default models** ([bench/2026-11-04-lumen-t2/receipt.md](bench/2026-11-04-lumen-t2/receipt.md)):
- `REAL RUN · Vultr VX1 sea · 2026-11-03 20:43 UTC`. Fix model `deepseek-v4.1-flash-1017`, vision model `qwen3.8-27b`, gate on.
- **18 fixed · 0 new · 0 cover-ups · 0 lost.** Errors 14 → 0 and warnings 4 → 0, with 16 of 16 screens compared. Verdict pass. The grader found all 13 planted bugs fixed.
- 2 checks, none rolled back. 18 turns and 33 tool calls, none invalid.
- 250,425 prompt and 13,553 completion tokens; $0.0464 at list price; 117.3 s in all.
- The patch changes 3 files (+26 −24) and applies to the original files.
- The vision model agreed with Mantis on 4 of 4 pairs.
- This is the run published at [/latest/](https://104-156-252-200.sslip.io/latest/). It is not approved: its page says the patch is shown for review only and nothing was applied anywhere.

**T3, the bake-off** ([bench/2026-11-04-bakeoff/RESULTS.md](bench/2026-11-04-bakeoff/RESULTS.md)): three models, two runs each, with the same settings (gate on, vision off, seed 7). Every run ended with `18 fixed · 0 new · 0 cover-ups · 0 lost` and errors 14 → 0, and the grader found all 13 planted bugs fixed in every run. The "Per model" table, quoted from RESULTS.md:

| model | runs | done | planted fixed (mean) | new (mean) | USD (mean) | seconds (mean) | invalid calls | final cover-up | a run with 0 new | probe p1+p2 | eligible |
|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v4.1-flash-1017 | 2 | 2 | 13.0 | 0.0 | $0.0571 | 102 | 0% | no | yes | pass | yes |
| glm-5.3 | 2 | 2 | 13.0 | 0.0 | $0.2740 | 135 | 0% | no | yes | pass | yes |
| minimax-m3.1-flash | 2 | 2 | 13.0 | 0.0 | $0.0608 | 59 | 0% | no | yes | pass | yes |

The rule ranks models by planted bugs fixed, then new issues, then cost, then time. The three tie on the first two, so the cheapest wins: the `fixModel` setting is `deepseek-v4.1-flash-1017`, and `fallbackModel` is `minimax-m3.1-flash` (a stored setting for a manual switch; the app never switches models by itself). The choice is not firm: there were two runs per model, the cost gap of $0.004 per task is inside the run-to-run spread, and minimax was about 40% faster.

**T4, timing** ([bench/2026-11-04-bakeoff/TIMING.md](bench/2026-11-04-bakeoff/TIMING.md)): over the 7 real runs, one full task took a median of 102 s (46–148 s). Model calls are most of it, with a median of 64 s. Mantis took 12.5 s for R0 and 9.6 s for each check (medians). Setting up the sandbox took under 1 s, and the wrap-up about 2 s. The six bake-off runs, two at a time, took 7 min 14 s in all.

## Try it

**The live demo**, https://104-156-252-200.sslip.io: `/latest/` is the published run, and `/status` shows the sandbox runtime, the model service, the last self-tests and today's spend.

**The tests** need Node 22 or newer. Two suites need nothing else:

```bash
node test/agent-loop.mjs --unit     # path and tool rules, the receipt, check messages, the tamper guard, the client against a fake gateway (48 checks)
node test/app-api.mjs               # the HTTP API: the admin rule, closed public runs, limits, approval and patch rules, SSE replay (49 checks)
```

The others need Docker:

```bash
scripts/setup.sh                    # build the images, create the internal network, start the proxy
node test/containment.mjs           # measure every containment claim (13 checks)
node test/scenes.mjs                # the hostile-repo and never-exits scenes (17 checks)
node test/agent-loop.mjs            # the unit checks, then scenarios S1-S10 in real sandboxes, driven by a fake model
node runner/run-task.mjs --repo https://github.com/<owner>/<repo> --routes /,/settings   # one Mantis look, no model
```

`RING_RUNTIME=runsc` runs the suites' sandboxes in gVisor; the runner takes `--runtime runsc`. No suite calls the real model service.

**The app:**

```bash
node app/server.mjs                 # http://127.0.0.1:8080
```

It reads `PORT`, `HOST`, `RING_STATE_DIR`, `RING_PUBLIC_DIR` and `RING_RUNTIME`. Model calls need `VULTR_INFERENCE_API_KEY` in the app's own environment; the key never reaches a sandbox. Public runs are closed by default, so tasks start through the local-admin API (`/admin/*`), which answers only loopback requests that name a loopback host and carry no `X-Forwarded-For` header.

**On the Vultr VM**, the owner runs `scripts/vm-bootstrap.sh --deploy-key <file.pub>` as root once (Docker, gVisor, Caddy, Node 22, ufw, the `ring-orch` and `deploy` users). After that, everything goes over SSH as `deploy`:

```bash
scripts/deploy.sh --selftest               # a clean commit only; checked on the VM's Node 22 first, rolled back if the restart fails
scripts/ring.sh status
scripts/ring.sh run '{"sample":"lumen"}'   # real model calls; add "visionModel":null to skip vision. Prints the id and the owner link
scripts/ring.sh watch <id>                 # live events until the task is done
scripts/ring.sh get <id>                   # the full record and the receipt
scripts/ring.sh bundle <id> <dir>          # every file of the task
scripts/ring.sh publish <id>               # only a run that passes the publish bar
scripts/ring.sh selftest agent-loop        # or containment, or scenes; sandboxes under gVisor
```

With `--selftest`, `deploy.sh` also runs `ring-selftest`, a wrapper the bootstrap script installs, which runs the containment and scene suites with `RING_RUNTIME=runsc`. The owner link is for the owner only. The admin channel can never approve a run.

## Built before the event

The organisers' official build start was **3 Nov 2026 at 16:00 UTC (23:00 ICT)**. The lablab Live page gives that time, the kick-off stream began then, and registration closed at the same moment. An earlier version of the Live page said 15:00 UTC (22:00 ICT), and the `pre-event-final` tag message still uses that earlier time (see the tags below).

The event page and the lablab Rule Book say nothing about code written before the start. The general [lablab FAQ](https://lablab.ai/guide/ai-hackathons), under "Can I use pre-existing code or open-source libraries?", says:

> Yes. Most events require only that the core AI-powered functionality was built during the event window. Using open-source libraries, starter templates, or prior non-AI scaffolding is generally allowed — check each event's specific rules.

**What existed before the start:**
- **The Mantis CLI** ([vulinh1704/mantis](https://github.com/vulinh1704/mantis), MIT, npm `@vulinh1704/mantis`, 0.7.1 in the sandbox). Its measurements use no LLM. Its cover-up detection is part of the CLI since 0.2.0: each run is compared with the previous one, and an issue that went away because its element was hidden, removed, shrunk, cut off or emptied becomes a `cover-up` error. Ring passes the first run as the baseline, so every check is compared with the starting point instead.
- **Mantis's buggy-app test fixture**: a small site with 13 planted UI bugs and their answer key, `PLANTED.json`. During the event, `scripts/make-demo-lumen.sh` copied it into `demo/lumen` (the Lumen sample), without the answer key and without the comments that hint at a bug.
- **Mantis's agent skills and MCP server**, also public before the event, so Mantis as a whole is not AI-free:
  - the skills in `plugins/mantis/skills/` (`mantis`, `mantis-fix`, `mantis-perf`, `mantis-proof`). `mantis-fix/SKILL.md` is a prompt for coding agents: fix the cause, not the symptom; run `mantis look` again, which prints `N fixed · N new · N cover-ups · N lost`; undo any change that Mantis calls a cover-up and fix the cause; stop after 3 rounds;
  - the MCP server `src/mcp.js`, with tool schemas for `mantis_look`, `mantis_perf`, `mantis_learn` and `mantis_proof`.
- **This repository's non-AI scaffolding**, up to the signed `pre-event-final` tag: the sandbox image, the allowlist proxy, the runner, the containment tests and their fixtures, the VM bootstrap script and the license.

**Written after the start:** Ring's prompts and tool schemas, the Serverless Inference client, the agent loop that the existing Mantis cover-up check gates, the vision second opinion, the web app and its deployment to the Vultr VM. Ring's prompts and tool schemas are new: they are not copied from the Mantis skills or `src/mcp.js`, and Ring uses neither; it runs only the CLI's `look` and `proof` commands. All of this is in commits dated after the start. The first of them is `aef5786`, the inference client, dated 4 Nov 01:07 ICT (3 Nov 18:07 UTC). `git log --format='%h %ci %s'` lists every commit with its date.

The loop follows the routine that the `mantis-fix` skill already describes (fix, measure with Mantis, undo and redo on a cover-up, at most 3 rounds), and its receipt line `N fixed · N new · N cover-ups · N lost` is Mantis's own comparison line. What the event adds is running that routine on its own, in a sandbox on Vultr, with a vision model's second opinion and the owner's approval.

**The tags:**
- `kickoff` (signed, 30 Oct 2026) is on `dcc708b` and marks the scaffolding as it was that day. It stays as evidence and is never moved. Its message gives the start as 23:00 ICT on 3 Nov, which is the official start. It also calls the tag "everything built before the Vultr Agent Rush kickoff"; that is out of date, because more non-AI commits came after it.
- `pre-event-final` (signed, 2 Nov 2026) is on `8b38e4e` (31 Oct, 22:51 ICT), the last commit before the start. That is where the work before the event ends. Its message gives the start as 22:00 ICT, the Live page's earlier time. A signed tag cannot be edited, so this README corrects it. Both times give the same split: the next commit, `b07c0ad` (a containment-test fix, no AI), is dated 3 Nov, 23:53 ICT.
- The commits between `kickoff` and `pre-event-final` have no AI in them: no model calls, prompts or tool schemas.
- Every line of Ring's agent is in commits dated after 23:00 ICT on 3 Nov.

## Known limits

- **A hostile repository can game its own receipt.** A GitHub repository's code runs as the same user as Mantis inside its sandbox, so its dev server could show the checker a different page, or rewrite Mantis's run folder. Receipts for GitHub repositories therefore say "measured inside the repo's own sandbox", not "verified", and only runs on the built-in sample are ever published as the latest verified run.
- **The tamper guard is a list of words.** A check is rolled back when an edit mentions the checker (`data-mantis…`, `mantis`), headless-browser or webdriver checks, user-agent sniffing, or the usual ways to hide such a word (split strings, `atob`, character codes, `\x`/`\u` escapes). A model could still find a spelling the list misses. The real fix belongs in Mantis: a look option that ignores page-supplied `data-mantis-ignore` and counts ignored elements per screen.
- **Approval.** The owner link carries the token that approves a run, and the operator who starts a run through the admin channel sees it. The admin channel itself can never approve, but only an approval passphrase set on the server (`RING_APPROVE_PASSPHRASE_SHA256` in the service's environment) proves that a person approved. Without one, the published page says "Approved with the owner link", not "by a human".
- **Lost controls on live sites.** On the sample, a check that makes a visible control or heading disappear is rolled back like a cover-up. On a GitHub repository it only lowers the verdict to partial, because live content can come and go between two measurements.
- **The diff is public before approval.** Anyone with a run's address can read its diff on the run page, and a published run shows it as `patch.txt` for review. Approval gates only the owner's patch download. The demo never applies a patch anywhere.
- **Costs are list prices.** Receipts, `/status` and the bench files count every call at the list price in the Vultr catalogue. The bill may differ.

## License

MIT, see [LICENSE](LICENSE).
