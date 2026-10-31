#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 VM (Vultr) for Mantis Ring. Read it, then run it yourself as root:
#
#   scp -i ~/.ssh/vultr_ring_root scripts/vm-bootstrap.sh ~/.ssh/vultr_ring_deploy.pub root@<vm>:/root/
#   ssh -i ~/.ssh/vultr_ring_root root@<vm> bash /root/vm-bootstrap.sh --deploy-key /root/vultr_ring_deploy.pub
#
# Running it again is safe: each step checks first or rewrites the same content, and an existing
# /etc/mantis-ring/secrets.env is kept as it is.
#
# What it sets up:
#   - Docker Engine, gVisor (runsc, registered as a Docker runtime), Caddy and Node.js 22, each from
#     its vendor's apt repository, as the install page linked at each step describes;
#   - ufw: incoming traffic only on ports 22, 80 and 443;
#   - user ring-orch: runs the orchestrator; in the docker group, which is equivalent to root;
#   - user deploy: the account Claude uses. Not root, not in docker; its only SSH key is the .pub
#     file you pass;
#   - /etc/sudoers.d/mantis-ring: deploy may restart the mantis-ring service and read its status as
#     root, and run two root-owned wrappers as ring-orch: ring-setup (scripts/setup.sh) and
#     ring-selftest (the containment tests, sandboxes under gVisor). Nothing in it runs code that
#     deploy wrote as root;
#   - /srv/mantis-ring: the code, owned by deploy (rsync or git push over SSH);
#   - /etc/mantis-ring/secrets.env: empty, 600 ring-orch:ring-orch. You fill it in yourself; this
#     script never reads or prints it.
#
# What the split does not stop: deploy writes the code that ring-orch runs, and ring-orch is in the
# docker group. Code that deploy ships can read the keys when it runs, and can act as root through
# Docker. The split keeps the keys out of deploy's own shell; it does not make "Claude never sees
# the key" enforceable.
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf 'vm-bootstrap: %s\n' "$*" >&2; exit 1; }
usage() { echo "usage: bash vm-bootstrap.sh --deploy-key /path/to/vultr_ring_deploy.pub"; }

# write MODE OWNER GROUP PATH: write stdin to PATH with that mode and owner.
write() {
  local tmp
  tmp=$(mktemp)
  cat > "$tmp"
  install -m "$1" -o "$2" -g "$3" "$tmp" "$4"
  rm -f "$tmp"
}

docker_has_runsc() {
  local runtimes
  runtimes=$(docker info --format '{{json .Runtimes}}' 2> /dev/null || true)
  [[ $runtimes == *'"runsc"'* ]]
}

# ---------------------------------------------------------------------------------------------
# Checks, before anything is changed
# ---------------------------------------------------------------------------------------------
deploy_key=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --deploy-key) [ "$#" -ge 2 ] || die "--deploy-key needs a path"; deploy_key=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this as root: it installs packages and creates users"
# shellcheck source=/dev/null
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this script is for Ubuntu; found ${ID:-an unknown system}"
[ "${VERSION_ID:-}" = 24.04 ] || echo "vm-bootstrap: warning: written for Ubuntu 24.04, found ${VERSION_ID:-unknown}; continuing" >&2

[ -n "$deploy_key" ] || { usage >&2; exit 64; }
[ -f "$deploy_key" ] || die "no such file: $deploy_key"
command -v ssh-keygen > /dev/null || die "ssh-keygen is missing (apt-get install openssh-client)"
if grep -q 'PRIVATE KEY' "$deploy_key"; then die "$deploy_key is a private key; pass the .pub file"; fi
key_lines=$(grep -cvE '^[[:space:]]*(#|$)' "$deploy_key" || true)
[ "$key_lines" = 1 ] || die "$deploy_key must hold exactly one public key (it has $key_lines)"
ssh-keygen -l -f "$deploy_key" > /dev/null 2>&1 || die "$deploy_key is not an SSH public key"
key_line=$(grep -vE '^[[:space:]]*(#|$)' "$deploy_key")
key_blob=$(awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^AAAA/) { print $i; exit } }' <<< "$key_line")
[ -n "$key_blob" ] || die "could not read the key in $deploy_key"
if [ -f /root/.ssh/authorized_keys ] && grep -qF -- "$key_blob" /root/.ssh/authorized_keys; then
  die "the deploy key is also in /root/.ssh/authorized_keys, which would give its holder root. Remove it there, attach only vultr_ring_root.pub to root, and run this again."
fi
note "deploy key: $(ssh-keygen -l -f "$deploy_key")"

export DEBIAN_FRONTEND=noninteractive
apt_install() { apt-get install -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }
arch=$(dpkg --print-architecture)

# ---------------------------------------------------------------------------------------------
# Packages
# ---------------------------------------------------------------------------------------------
say "Base packages"
apt-get update -q
apt_install ca-certificates curl gnupg apt-transport-https debian-keyring debian-archive-keyring \
  ufw rsync git sudo openssh-client
install -m 0755 -d /etc/apt/keyrings

say "Docker apt repository (https://docs.docker.com/engine/install/ubuntu/)"
mapfile -t conflicts < <(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc \
  docker-buildx podman-docker containerd runc 2> /dev/null | awk '$2 == "install" { print $1 }')
if [ "${#conflicts[@]}" -gt 0 ]; then
  note "removing packages that conflict with Docker Engine: ${conflicts[*]}"
  apt-get remove -y -q "${conflicts[@]}"
fi
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
write 0644 root root /etc/apt/sources.list.d/docker.sources << EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF

say "gVisor apt repository (https://gvisor.dev/docs/user_guide/install/)"
curl -fsSL https://gvisor.dev/archive.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$arch signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | write 0644 root root /etc/apt/sources.list.d/gvisor.list

say "Caddy apt repository (https://caddyserver.com/docs/install#debian-ubuntu-raspbian)"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
caddy_list=$(curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt')
printf '%s\n' "$caddy_list" | write 0644 root root /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg

say "Node.js 22 apt repository (NodeSource; the same setup as https://deb.nodesource.com/setup_22.x, without piping it to bash)"
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/nodesource.gpg
chmod 644 /usr/share/keyrings/nodesource.gpg
write 0644 root root /etc/apt/sources.list.d/nodesource.sources << EOF
Types: deb
URIs: https://deb.nodesource.com/node_22.x
Suites: nodistro
Components: main
Architectures: $arch
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' | write 0644 root root /etc/apt/preferences.d/nodejs

say "Install Docker Engine, gVisor, Caddy and Node.js 22"
apt-get update -q
apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
apt_install runsc caddy nodejs
systemctl enable --now docker
node_version=$(node --version)
[[ $node_version == v22.* ]] || die "expected Node.js 22, found $node_version"

say "Register runsc as a Docker runtime"
runsc install
if ! docker_has_runsc; then
  note "restarting Docker so it loads the runsc runtime"
  systemctl restart docker
fi
docker_has_runsc || die "Docker does not list the runsc runtime after a restart"
note "Docker runtimes: $(docker info --format '{{json .Runtimes}}' | tr -d '\n' | cut -c1-200)"

# ---------------------------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------------------------
# Ports that Docker publishes bypass ufw (https://docs.docker.com/engine/network/packet-filtering-firewalls/).
# Mantis Ring publishes none: Caddy runs on the host, and the sandboxes and the proxy have no ports.
say "Firewall: ufw lets in only 22, 80 and 443"
want=$'ufw allow 22/tcp\nufw allow 80/tcp\nufw allow 443/tcp\nufw allow 443/udp'
have=$(ufw show added 2> /dev/null | grep '^ufw ' || true)
if [ "$have" != "$want" ]; then
  [ -z "$have" ] || note "replacing these rules: $(tr '\n' ';' <<< "$have")"
  ufw --force reset > /dev/null
  ufw allow 22/tcp > /dev/null
  ufw allow 80/tcp > /dev/null
  ufw allow 443/tcp > /dev/null
  ufw allow 443/udp > /dev/null   # HTTP/3, which Caddy serves on UDP 443
fi
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
ufw --force enable > /dev/null
ufw status verbose | sed 's/^/    /'

# ---------------------------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------------------------
say "User ring-orch (runs the orchestrator; in the docker group)"
if ! id ring-orch > /dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/ring-orch --shell /usr/sbin/nologin ring-orch
fi
usermod -aG docker ring-orch
note "$(id ring-orch)"

say "User deploy (for Claude: no root, not in docker, one SSH key)"
if ! id deploy > /dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
usermod -p '*' deploy   # no password login at all, but not "locked", so SSH keys still work
for group in docker sudo admin adm lxd; do
  if [[ " $(id -nG deploy) " == *" $group "* ]]; then
    note "removing deploy from group $group"
    gpasswd -d deploy "$group" > /dev/null
  fi
done
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
printf 'no-agent-forwarding,no-X11-forwarding %s\n' "$key_line" | write 0600 deploy deploy /home/deploy/.ssh/authorized_keys
note "$(id deploy)"
note "authorized_keys: 1 key ($(ssh-keygen -l -f "$deploy_key" | awk '{ print $2 }'))"

say "Directories"
install -d -m 0755 -o deploy -g deploy /srv/mantis-ring
install -d -m 0750 -o root -g ring-orch /etc/mantis-ring
if [ -e /etc/mantis-ring/secrets.env ]; then
  note "/etc/mantis-ring/secrets.env exists: kept as it is (not read)"
else
  install -m 0600 -o ring-orch -g ring-orch /dev/null /etc/mantis-ring/secrets.env
  note "/etc/mantis-ring/secrets.env created, empty"
fi
chown ring-orch:ring-orch /etc/mantis-ring/secrets.env
chmod 0600 /etc/mantis-ring/secrets.env
stat -c '%A %U:%G %n' /srv/mantis-ring /etc/mantis-ring /etc/mantis-ring/secrets.env | sed 's/^/    /'

# ---------------------------------------------------------------------------------------------
# Wrappers and sudoers
# ---------------------------------------------------------------------------------------------
say "Wrappers /usr/local/sbin/ring-setup and ring-selftest (root-owned; deploy can run, not change them)"
write 0755 root root /usr/local/sbin/ring-setup << 'EOF'
#!/bin/bash
# Installed by mantis-ring scripts/vm-bootstrap.sh. Owned by root: deploy can run it, not change it.
# Builds the images, creates the networks and starts the proxy (/srv/mantis-ring/scripts/setup.sh).
# Usage: sudo -u ring-orch /usr/local/sbin/ring-setup
set -euo pipefail
[ "$#" -eq 0 ] || { echo "ring-setup takes no arguments" >&2; exit 64; }
[ "$(id -un)" = ring-orch ] || { echo "run it as ring-orch: sudo -u ring-orch $0" >&2; exit 1; }
export HOME=/var/lib/ring-orch PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd "$HOME"
exec /bin/bash /srv/mantis-ring/scripts/setup.sh
EOF
write 0755 root root /usr/local/sbin/ring-selftest << 'EOF'
#!/bin/bash
# Installed by mantis-ring scripts/vm-bootstrap.sh. Owned by root: deploy can run it, not change it.
# Runs the containment tests of /srv/mantis-ring with every sandbox under gVisor (runsc).
# Usage: sudo -u ring-orch /usr/local/sbin/ring-selftest
set -euo pipefail
[ "$#" -eq 0 ] || { echo "ring-selftest takes no arguments" >&2; exit 64; }
[ "$(id -un)" = ring-orch ] || { echo "run it as ring-orch: sudo -u ring-orch $0" >&2; exit 1; }
export HOME=/var/lib/ring-orch PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin RING_RUNTIME=runsc
runtimes=$(docker info --format '{{json .Runtimes}}')
[[ $runtimes == *'"runsc"'* ]] || { echo "Docker has no runsc runtime; run vm-bootstrap.sh again" >&2; exit 1; }
cd "$HOME"
status=0
node /srv/mantis-ring/test/containment.mjs || status=1
node /srv/mantis-ring/test/scenes.mjs || status=1
exit "$status"
EOF

say "sudoers: /etc/sudoers.d/mantis-ring"
# `systemctl status` may start a pager. Under sudo, systemctl runs it in secure mode
# ($SYSTEMD_PAGERSECURE, see systemctl(1)), and without a terminal no pager starts at all.
sudoers=$(mktemp)
cat > "$sudoers" << 'EOF'
# Installed by mantis-ring scripts/vm-bootstrap.sh. Nothing here runs code that deploy wrote as root.
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart mantis-ring, /usr/bin/systemctl status mantis-ring
deploy ALL=(ring-orch) NOPASSWD: /usr/local/sbin/ring-setup, /usr/local/sbin/ring-selftest
EOF
visudo -cqf "$sudoers" || { rm -f "$sudoers"; die "the sudoers rules did not pass visudo -c"; }
install -m 0440 -o root -g root "$sudoers" /etc/sudoers.d/mantis-ring
rm -f "$sudoers"
visudo -cq || die "visudo -c fails with /etc/sudoers.d/mantis-ring in place"
sudo -l -U deploy | sed 's/^/    /'

# ---------------------------------------------------------------------------------------------
say "Done"
note "$(docker --version)"
note "$(runsc --version 2>&1 | head -n 1)"
note "caddy $(caddy version | cut -d' ' -f1)"
note "node $(node --version)"
cat << 'EOF'

Next:
  1. You, as root: write the keys into /etc/mantis-ring/secrets.env (keep it 600 ring-orch:ring-orch).
  2. Claude, as deploy (ssh -i ~/.ssh/vultr_ring_deploy deploy@<vm>):
       rsync the repository into /srv/mantis-ring
       sudo -u ring-orch /usr/local/sbin/ring-setup
       sudo -u ring-orch /usr/local/sbin/ring-selftest
  3. The mantis-ring systemd service and the Caddyfile do not exist yet; they come with the app.
     Until then `sudo systemctl restart mantis-ring` fails.
EOF
