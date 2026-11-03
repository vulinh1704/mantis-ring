#!/usr/bin/env bash
# Drives the Mantis Ring app on the VM as local admin (BUILD-SPEC §5.2). Every command is a curl to
# 127.0.0.1:8080 run over SSH as `deploy`, so it reaches the app from loopback without X-Forwarded-For.
# JSON bodies travel on stdin (curl --data-binary @-), never inside the remote command line, and task
# ids are checked before they are. The owner link that `run` prints is for the owner only: approving
# a run needs the owner's browser and is refused on this admin channel.
#
# Usage: scripts/ring.sh <command> [args]
#   status                    /status.json
#   health                    /admin/health (running and queued tasks, Docker, proxy, sandboxes)
#   probe '<json>'            POST /admin/probe  {"models":[...],"vision":[...]}
#   run '<json>'              POST /admin/tasks  prints the id, the position and the owner link
#   watch <id>                live events (SSE) until the task is done; Ctrl-C to stop
#   get <id>                  /admin/tasks/<id>: the full record and the receipt
#   tasks [state] [label]     /admin/tasks, optionally filtered
#   cancel <id>               POST /admin/tasks/<id>/cancel
#   bundle <id> <localdir>    every file of the task, unpacked into <localdir>
#   publish <id>              POST /admin/publish/<id>
#   config ['<json>']         GET, or POST with a patch, /admin/config
#   spend                     /admin/spend
#   selftest <suite>          POST /admin/selftest (agent-loop | containment | scenes); streams its output
#   logs                      the last 300 lines of the app's journal
set -euo pipefail
H=deploy@104.156.252.200
S=(ssh -i ~/.ssh/vultr_ring_deploy -o BatchMode=yes -o ConnectTimeout=10 "$H")
APP=http://127.0.0.1:8080

die() { printf 'ring.sh: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '8,22p' "$0" | sed 's/^# \{0,1\}//'; }
need_id() { [[ ${1:-} =~ ^t_[0-9a-f]{32}$ ]] || die "not a task id: '${1:-}' (t_ and 32 hex digits)"; }
need_json() { node -e 'JSON.parse(process.argv[1])' "${1:-}" 2> /dev/null || die "not valid JSON: ${1:-<nothing>}"; }
# get PATH / post PATH JSON: one admin request. --fail-with-body: an error answer prints its sentence
# and fails. Paths are built only from checked parts and single-quoted for the VM's shell. The status
# is returned explicitly, so a failure also counts inside $(...), where errexit is off.
get() {
  local rc=0
  "${S[@]}" "curl -sS --fail-with-body '$APP$1'" || rc=$?
  echo
  return "$rc"
}
post() {
  local rc=0
  printf '%s' "$2" | "${S[@]}" "curl -sS --fail-with-body -X POST -H 'content-type: application/json' --data-binary @- '$APP$1'" || rc=$?
  echo
  return "$rc"
}
# A query value that is safe on the remote command line: URL-encoded, then only [A-Za-z0-9%._~-].
query_value() {
  local v
  v=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1")
  [[ $v =~ ^[A-Za-z0-9%._~-]*$ ]] || die "cannot pass this value: $1"
  printf '%s' "$v"
}

cmd=${1:-}
[ "$#" -gt 0 ] && shift
case "$cmd" in
  status) get /status.json ;;
  health) get /admin/health ;;
  probe)
    need_json "${1:-}"
    post /admin/probe "$1" ;;
  run)
    need_json "${1:-}"
    if ! out=$(post /admin/tasks "$1"); then printf '%s\n' "$out" >&2; exit 1; fi
    printf '%s' "$out" | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const r = JSON.parse(s);
      console.log(`id: ${r.id}\nposition: ${r.position}\nownerLink: ${r.ownerLink}\n(give the owner link to the owner only: it carries the token that approves this run)`);
    });' ;;
  watch)
    need_id "${1:-}"
    "${S[@]}" "curl -sSN '$APP/api/tasks/$1/events'" ;;
  get)
    need_id "${1:-}"
    get "/admin/tasks/$1" ;;
  tasks)
    q=''
    [ -z "${1:-}" ] || { [[ $1 =~ ^(queued|running|done|failed|timeout|cancelled|interrupted)$ ]] || die "unknown state: $1"; q="state=$1"; }
    [ -z "${2:-}" ] || q="$q&label=$(query_value "$2")"
    get "/admin/tasks${q:+?$q}" ;;
  cancel)
    need_id "${1:-}"
    post "/admin/tasks/$1/cancel" '{}' ;;
  bundle)
    need_id "${1:-}"
    [ -n "${2:-}" ] || die "usage: ring.sh bundle <id> <localdir>"
    mkdir -p -- "$2"
    "${S[@]}" "curl -sS --fail '$APP/admin/tasks/$1/bundle'" | tar -xf - -C "$2" --no-same-owner --no-same-permissions
    echo "unpacked into $2:"
    ls -l -- "$2" ;;
  publish)
    need_id "${1:-}"
    post "/admin/publish/$1" '{}' ;;
  config)
    if [ "$#" -ge 1 ]; then need_json "$1"; post /admin/config "$1"; else get /admin/config; fi ;;
  spend) get /admin/spend ;;
  selftest)
    [[ ${1:-} =~ ^(agent-loop|containment|scenes)$ ]] || die "suite must be agent-loop, containment or scenes"
    printf '{"suite":"%s"}' "$1" | "${S[@]}" "curl -sSN --fail-with-body -X POST -H 'content-type: application/json' --data-binary @- '$APP/admin/selftest'" ;;
  logs) "${S[@]}" 'sudo journalctl -u mantis-ring -n 300 --no-pager' ;;
  '' | -h | --help | help) usage ;;
  *) usage >&2; exit 64 ;;
esac
