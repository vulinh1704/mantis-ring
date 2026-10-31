# Test fixtures

Test data for `test/scenes.mjs`. Each fixture is copied into a fresh sandbox and runs only there.

- `hostile-repo/`: a repository that attacks its host. `hostile.sh` reads every environment and secret path it can, calls hosts off the allowlist (directly, through the proxy and through DNS, with `exfil.mjs`), runs `rm -rf /`, and spawns processes without end (`spawn-forever.mjs`). **Never run it on a host.** `hostile.sh` and `spawn-forever.mjs` refuse to run outside a Mantis Ring sandbox (inside Docker, as uid 10001, behind `ring-proxy`); `exfil.mjs` only opens connections and DNS lookups.
- `never-exits/`: a dev server that accepts connections, never answers and ignores SIGTERM. The runner must stop it at the task's time limit and remove its container.

There is no AI here: no model calls and no prompts.
