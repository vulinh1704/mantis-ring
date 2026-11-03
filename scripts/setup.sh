#!/usr/bin/env bash
# Host setup: build the sandbox and proxy images, create ring-egress (the proxy's way out) and start
# the allowlist proxy. Sandboxes need no network from here: each one gets an internal network of its
# own when it starts (runner/sandbox.mjs), and the running proxy joins it then.
# Run it with no task running: it restarts the proxy, and a running sandbox would lose its way out.
# Usage: scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

docker build -q -t mantis-ring/sandbox sandbox
docker build -q -t mantis-ring/proxy proxy

docker network inspect ring-egress > /dev/null 2>&1 || docker network create ring-egress > /dev/null

docker rm -f ring-proxy > /dev/null 2>&1 || true
# With the proxy gone, sandbox networks (Mantis Ring's own, by label) that no sandbox runs on are
# unused, and so is ring-internal, the one network that every sandbox shared in earlier versions.
docker network prune -f --filter label=mantis-ring=task > /dev/null
docker network rm ring-internal > /dev/null 2>&1 || true
# Bounded logs: tinyproxy logs every refused request, and a hostile install loop must not fill the disk.
docker run -d --name ring-proxy --restart unless-stopped \
  --network ring-egress --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --pids-limit 64 --log-opt max-size=10m --log-opt max-file=3 mantis-ring/proxy > /dev/null
echo "ready: images mantis-ring/sandbox and mantis-ring/proxy, proxy ring-proxy:8888 on ring-egress; each sandbox gets its own internal network"
