#!/usr/bin/env bash
# One-time host setup: build the sandbox and proxy images, create the internal network the sandboxes
# live on, and start the allowlist proxy, the only container on both that network and the outside.
# Usage: scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

docker build -q -t mantis-ring/sandbox sandbox
docker build -q -t mantis-ring/proxy proxy

# --internal: no route to the internet from this network, only to its own members.
docker network inspect ring-internal > /dev/null 2>&1 || docker network create --internal ring-internal > /dev/null
docker network inspect ring-egress > /dev/null 2>&1 || docker network create ring-egress > /dev/null

docker rm -f ring-proxy > /dev/null 2>&1 || true
# Bounded logs: tinyproxy logs every refused request, and a hostile install loop must not fill the disk.
docker run -d --name ring-proxy --restart unless-stopped \
  --network ring-egress --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --pids-limit 64 --log-opt max-size=10m --log-opt max-file=3 mantis-ring/proxy > /dev/null
docker network connect ring-internal ring-proxy
echo "ready: images mantis-ring/sandbox and mantis-ring/proxy, network ring-internal, proxy ring-proxy:8888"
