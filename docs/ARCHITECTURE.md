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
   - on the `ring-internal` network only. Its single exit is `ring-proxy`, which lets through `registry.npmjs.org` and GitHub and refuses every other host;
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
| Process cap | Trying to start 700 processes ends at or below 512 |
| Memory cap | An allocation loop is killed |
| Time limit | A task whose dev server never answers is stopped and its container removed |
| Cleanup | No container is left after a task |

## Built before the event vs during it

| Part | AI? | When |
|---|---|---|
| Mantis CLI (MIT, npm `@vulinh1704/mantis`) | no | before; an existing open-source library |
| Sandbox image, allowlist proxy, runner, containment tests (this repository up to the kickoff tag) | no | before (30 Oct – 3 Nov) |
| Agent loop, prompts, tools, Serverless Inference client, cover-up gate, web app, Vultr deployment | yes / product | during (3–9 Nov) |
