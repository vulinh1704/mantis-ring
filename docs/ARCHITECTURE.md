# Mantis Ring: architecture

A coding agent fixes UI bugs in a repository it is handed. It can punch, but not outside the ropes:
- every action runs in a throwaway sandbox;
- the model never sees a secret;
- a fix that only hides a bug is refused;
- a human approves before anything leaves the ring.

```
Browser ──► Vultr VM (Cloud Compute)
            ├─ Caddy (HTTPS) ─► web app + API (Node)
            ├─ Orchestrator: agent loop; calls Vultr Serverless Inference (OpenAI-compatible)
            │     tools = docker exec into the task sandbox: read_file, write_file, run_mantis, read_report
            ├─ Docker (gVisor runsc on the VM): one container per task
            │     Node, git, Chromium headless shell, Mantis CLI · no secrets · read-only root
            │     network: ring-internal (no route out) ─► ring-proxy (allowlist) ─► npm, GitHub
            └─ Artifacts: report, screenshots, diff, before/after proof
```

## One task

1. The user gives a public GitHub repository, routes, viewports and languages.
2. `Sandbox.create()` starts a fresh container from `mantis-ring/sandbox`:
   - `--read-only`, with tmpfs for `/work`, `/tmp` and the home directory;
   - `--memory 3g` (no swap), `--cpus 2`, `--pids-limit 512`, `--cap-drop ALL`, `no-new-privileges`;
   - an unprivileged user (uid 10001);
   - on the `ring-internal` network only. Its single exit is `ring-proxy`, which lets through `registry.npmjs.org` and GitHub and refuses every other host. The proxy's address is written into the sandbox's `/etc/hosts` (`--add-host`), because under gVisor Docker's embedded DNS cannot be reached and the name would not resolve;
   - no environment from the host. API keys and the GitHub token stay with the orchestrator.
3. The repository is cloned inside the sandbox through the proxy, or copied in as a tar stream. Then dependencies are installed and the dev server is started.
4. `mantis look` checks every route × viewport × theme × language and writes `report.json`.
5. **During the event:** the agent loop reads the report as text, edits files in the sandbox, and looks again, up to 3 rounds.
   - Mantis compares each round with the previous one.
   - A change that hides a bug (overflow masked, element hidden, text shrunk) is a `cover-up` error. The loop must undo it and fix the cause.
6. The result is a receipt: `N fixed · 0 new · 0 cover-ups`, before/after screenshots and the diff.
7. A human presses **Approve**. Only then does the orchestrator, outside the sandbox, open the pull request or offer the patch.
8. `destroy()` removes the container. A wall-clock limit destroys it early if a step hangs.

## Containment, measured

`node test/containment.mjs` checks each claim against a fresh sandbox:

| Claim | How it is checked |
|---|---|
| No secrets inside | A fake API key in the host environment is absent from `env` in the sandbox |
| Unprivileged | `id -u` is not 0 |
| Read-only root | `touch /usr/local/bin/x` fails |
| No direct internet | A TCP connect to 1.1.1.1:443 fails |
| Allowlisted egress only | `git ls-remote` works for github.com and is refused for gitlab.com |
| No exfiltration | `fetch('https://example.com')` fails |
| Process cap | Trying to start 700 processes ends at or below 512. Under gVisor the cap also counts the sandbox kernel's own threads, so the bomb stops the whole sandbox before 700 processes start |
| Memory cap | An allocation loop is killed |
| Time limit | A task whose dev server never answers is stopped and its container removed |
| Cleanup | No container is left after a task |

`node test/scenes.mjs` plays the containment scenes with two fixtures from `test/fixtures/` (test data, run only inside a fresh sandbox):
- a hostile repository that hunts for secrets, calls hosts off the allowlist (the cloud metadata address included), runs `rm -rf` on the whole filesystem and spawns processes without end;
- a dev server that never answers and ignores SIGTERM.

Both suites take `RING_RUNTIME=runsc` to run the sandboxes in gVisor.

## Built before the event vs during it

| Part | AI? | When |
|---|---|---|
| Mantis CLI (MIT, npm `@vulinh1704/mantis`), including its cover-up detection | no | before; an existing open-source library |
| Mantis agent skills (`plugins/mantis/skills/`, including the `mantis-fix` prompt) and MCP server (`src/mcp.js`) | yes (prompts, tool schemas) | before; published with Mantis, listed in the README |
| Sandbox image, allowlist proxy, runner, containment tests and fixtures, VM bootstrap script (this repository up to the `pre-event-final` tag) | no | before (30 Oct – 3 Nov, 22:00 ICT) |
| Ring's prompts and tool schemas (written fresh), Serverless Inference client, the agent loop that the existing Mantis cover-up check gates, vision-model check, web app, Vultr deployment | yes / product | during (3–9 Nov) |

The README's "Built before the event" section has the details and the tags.
