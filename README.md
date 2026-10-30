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
- the containment tests.

**During the event (3–9 Nov):**
- the agent loop on Vultr Serverless Inference;
- the cover-up gate;
- the web app;
- the Vultr deployment.

## Try the scaffolding

Needs Docker and Node 22.

```bash
scripts/setup.sh                      # build images, create the internal network, start the proxy
node test/containment.mjs             # measure every containment claim
node runner/run-task.mjs --repo https://github.com/<owner>/<repo> --routes /,/settings
```

## Built before the event

Hackathon rules ask that the AI-powered core be built during the event.
- **Before the event:** the Mantis CLI (an existing MIT library, no AI) and this repository's non-AI scaffolding, up to the `kickoff` tag.
- **After the `kickoff` tag:** everything else.
