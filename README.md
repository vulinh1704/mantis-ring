# Mantis Ring

A boxing ring for coding agents that fix UI bugs. They can punch, but not outside the ropes:
- every action runs in a throwaway sandbox;
- the model never sees a secret;
- a "fix" that only hides a bug is refused;
- a human approves before anything leaves the ring.

Built for the Vultr Agent Rush hackathon (Challenge 1, Blast Radius Zero). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

**Before the event (non-AI scaffolding):**
- the task sandbox;
- the egress allowlist proxy;
- the runner that clones, installs, serves and checks a repository with [Mantis](https://github.com/vulinh1704/mantis);
- the containment tests, with two fixtures: a hostile repository and a dev server that never exits;
- the VM bootstrap script, which the owner runs as root.

**During the event (3–9 Nov):**
- Ring's prompts and tool schemas, written fresh;
- the Vultr Serverless Inference client;
- the agent loop that the existing Mantis cover-up check gates;
- the vision-model check;
- the web app, with the approval step;
- the Vultr deployment.

## Try the scaffolding

Needs Docker and Node 22.

```bash
scripts/setup.sh                      # build images, create the internal network, start the proxy
node test/containment.mjs             # measure every containment claim (13 checks)
node test/scenes.mjs                  # the hostile-repo and never-exits scenes (17 checks)
node runner/run-task.mjs --repo https://github.com/<owner>/<repo> --routes /,/settings
```

On the Vultr VM, the owner runs `scripts/vm-bootstrap.sh --deploy-key <file.pub>` as root once (Docker, gVisor, Caddy, Node 22, ufw, the `ring-orch` and `deploy` users). The tests then run with every sandbox under gVisor: `RING_RUNTIME=runsc`, which the `ring-selftest` wrapper sets.

## Built before the event

The event starts on 3 Nov 2026 at **22:00 ICT** (15:00 UTC). The event page and the lablab Rule Book say nothing about code written before it. The general [lablab FAQ](https://lablab.ai/guide/ai-hackathons), under "Can I use pre-existing code or open-source libraries?", says:

> Yes. Most events require only that the core AI-powered functionality was built during the event window. Using open-source libraries, starter templates, or prior non-AI scaffolding is generally allowed — check each event's specific rules.

**What existed before 22:00 ICT on 3 Nov:**
- **The Mantis CLI** ([vulinh1704/mantis](https://github.com/vulinh1704/mantis), MIT, npm `@vulinh1704/mantis`, 0.7.1 in the sandbox). Its measurements use no LLM. Its cover-up detection is part of the CLI since 0.2.0: each run is compared with the previous one, and an issue that went away because its element was hidden, removed, shrunk, cut off or emptied becomes a `cover-up` error.
- **Mantis's agent skills and MCP server**, also public before the event, so Mantis as a whole is not AI-free:
  - the skills in `plugins/mantis/skills/` (`mantis`, `mantis-fix`, `mantis-perf`, `mantis-proof`). `mantis-fix/SKILL.md` is a prompt for coding agents: fix the cause, not the symptom; run `mantis look` again, which prints `N fixed · N new · N cover-ups · N lost`; undo any change that Mantis calls a cover-up and fix the cause; stop after 3 rounds;
  - the MCP server `src/mcp.js`, with tool schemas for `mantis_look`, `mantis_perf`, `mantis_learn` and `mantis_proof`.
- **This repository's non-AI scaffolding**, up to the signed `pre-event-final` tag: the sandbox image, the allowlist proxy, the runner, the containment tests and their fixtures, the VM bootstrap script and the license.

**Written after 22:00 ICT on 3 Nov:** Ring's prompts and tool schemas, the Serverless Inference client, the agent loop that the existing Mantis cover-up check gates, the vision-model check, the web app and the Vultr deployment. Ring's prompts and tool schemas are new: they are not copied from the Mantis skills or `src/mcp.js`.

The loop follows the routine that the `mantis-fix` skill already describes (fix, measure with Mantis, undo and redo on a cover-up, at most 3 rounds), and its receipt `N fixed · 0 new · 0 cover-ups` is Mantis's own comparison line. What the event adds is running that routine on its own, in a sandbox on Vultr, with a vision model and a human approval.

**The tags:**
- `kickoff` (signed, 30 Oct 2026) marks the scaffolding as it was that day. It stays as evidence and is never moved. Its message is out of date on two points, and a signed tag cannot be edited, so this README corrects them:
  - it gives the kickoff as 23:00 ICT. The event starts at 22:00 ICT; 23:00 ICT is the kick-off stream;
  - it calls the tag "everything built before the Vultr Agent Rush kickoff". More non-AI commits came after it.
- `pre-event-final` (signed) is on the last commit before 22:00 ICT on 3 Nov. That is where the work before the event ends. The commits between `kickoff` and `pre-event-final` have no AI in them: no model calls, prompts or tool schemas.
- Every line of Ring's agent is written after 22:00 ICT on 3 Nov.

## Known limits

- **A hostile repository can game its own receipt.** A GitHub repository's code runs as the same user as Mantis inside its sandbox, so its dev server could show the checker a different page, or rewrite Mantis's run folder. Receipts for GitHub repositories therefore say "measured inside the repo's own sandbox", not "verified", and only runs on the built-in sample are ever published as the latest verified run.
- **The tamper guard is a list of words.** A check is rolled back when an edit mentions the checker (`data-mantis…`, `mantis`), headless-browser or webdriver checks, user-agent sniffing, or the usual ways to hide such a word (split strings, `atob`, character codes, `\x`/`\u` escapes). A model could still find a spelling the list misses. The real fix belongs in Mantis: a look option that ignores page-supplied `data-mantis-ignore` and counts ignored elements per screen.
- **Approval.** The owner link carries the token that approves a run, and the operator who starts a run through the admin channel sees it. The admin channel itself can never approve, but only an approval passphrase set on the server (`RING_APPROVE_PASSPHRASE_SHA256` in the service's environment) proves that a person approved. Without one, the published page says "Approved with the owner link", not "by a human".
- **Lost controls on live sites.** On the sample, a check that makes a visible control or heading disappear is rolled back like a cover-up. On a GitHub repository it only lowers the verdict to partial, because live content can come and go between two measurements.
- **The diff is public before approval.** Anyone with a run's address can read its diff on the run page; approval gates the patch file. The demo never applies a patch anywhere.

## License

MIT, see [LICENSE](LICENSE).
