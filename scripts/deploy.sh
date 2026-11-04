#!/usr/bin/env bash
# Deploys this repository to the Vultr VM as `deploy` and restarts the app (BUILD-SPEC §5.1).
# It refuses uncommitted code (the VM should run a commit) and checks the code locally. The tree goes
# to a staging folder on the VM first (~/ring-next), where the VM's own Node 22 checks it: syntax,
# every module imported, and the Docker-free test suites. Only then is the live tree saved
# (~/ring-prev) and replaced. A restart that does not come up, or comes up without the agent loop,
# the probe, the vision check or the spend ledger, is rolled back to the saved tree. It refuses to
# restart while a task runs or waits, or a self-test runs (a restart kills them), and ends with the
# checks a judge would see from outside: the pages answer, gVisor is on, /admin/* is a 404 through
# Caddy, and both public switches (runs of the sample, runs on GitHub repositories) are still closed.
#
# Usage: scripts/deploy.sh [--dirty] [--force] [--selftest]
#   --dirty     deploy uncommitted changes too (app/VERSION.json then says dirty: true)
#   --force     restart even while a task or a self-test runs, or when the VM's queue cannot be read
#   --selftest  afterwards, with no task running, run ring-selftest (containment and scenes; every check must pass)
# Once the owner opens public runs (D-5): RING_ALLOW_PUBLIC=sample accepts open sample runs while
# GitHub runs must still be closed, and RING_ALLOW_PUBLIC=yes accepts both open.
# Environment, for tests only: RING_SSH, RING_RSYNC (programs to use instead of ssh and rsync; they
# must be executable), RING_HOST, RING_URL. With RING_TEST=1 the script refuses to run unless both
# programs are test stand-ins and the host is not the real VM, so a broken fake can never fall
# through to the real ssh.
set -euo pipefail
cd "$(dirname "$0")/.."
REAL_HOST=104.156.252.200
HOST_ADDR=${RING_HOST:-$REAL_HOST}
H=deploy@$HOST_ADDR
SSH_BIN=${RING_SSH:-ssh}
RSYNC_BIN=${RING_RSYNC:-rsync}
KEY=~/.ssh/vultr_ring_deploy
# IdentitiesOnly: only the deploy key is ever offered, never an agent's key or a default identity.
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10)
S=("$SSH_BIN" "${SSH_OPTS[@]}" "$H")
URL=${RING_URL:-https://104-156-252-200.sslip.io}
HEALTHCHECK=/mnt/g/Work/MyCompany/FindJob/30-projects/mantis/vultr-pack/deploy/healthcheck.sh
PATHS=(app agent runner test scripts demo sandbox proxy bench)
# Anchored where they must be (/out, /state, /.ring-public); excluded paths on the VM are never deleted.
EXCLUDES='--exclude .git --exclude node_modules --exclude /out --exclude .mantis --exclude /state --exclude /.ring-public'

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
# json_field FIELD: print one top-level field of the JSON on stdin ('' when absent or not JSON).
json_field() {
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { const v = JSON.parse(s)[process.argv[1]]; console.log(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)); }
    catch { console.log(""); } });' "$1"
}

# Test stand-ins must really be what runs (the 3 Nov incident: a fake ssh lost its exec bit, and the
# real ssh reached the VM).
for v in RING_SSH RING_RSYNC; do
  [ -z "${!v:-}" ] || [ -x "${!v}" ] || die "$v is set but is not an executable file: ${!v}"
done
if [ "${RING_TEST:-}" = 1 ]; then
  [ "$HOST_ADDR" != "$REAL_HOST" ] || die "RING_TEST=1, but the host is the real VM: set RING_HOST"
  for b in "$SSH_BIN" "$RSYNC_BIN"; do
    case "$(command -v -- "$b" || true)" in
      '' | /usr/bin/* | /bin/* | /usr/local/bin/*) die "RING_TEST=1, but '$b' is not a test stand-in: set RING_SSH and RING_RSYNC" ;;
    esac
  done
fi

# busy_state: "<running> <queued> <selftest|none>" from the app on the VM; "down" when nothing listens
# on its port (curl exit 7); "unknown" for anything else (a timeout, an answer without numbers).
busy_state() {
  local out rc=0 running queued selftest=''
  out=$("${S[@]}" 'curl -sS -m 10 http://127.0.0.1:8080/admin/busy' 2> /dev/null) || rc=$?
  case "$rc" in
    0) ;;
    7) echo down; return 0 ;;
    255) die "ssh to $H failed" ;;
    *) echo unknown; return 0 ;;
  esac
  running=$(printf '%s' "$out" | json_field running)
  if [[ $running =~ ^[0-9]+$ ]]; then
    queued=$(printf '%s' "$out" | json_field queued)
    selftest=$(printf '%s' "$out" | json_field selftest)
  else
    # An app from before /admin/busy: the queue numbers from /status.json (no self-test flag there).
    out=$("${S[@]}" 'curl -sS -m 10 http://127.0.0.1:8080/status.json' 2> /dev/null) || { echo unknown; return 0; }
    running=$(printf '%s' "$out" | json_field queue | json_field running)
    queued=$(printf '%s' "$out" | json_field queue | json_field queued)
  fi
  [[ $running =~ ^[0-9]+$ && $queued =~ ^[0-9]+$ ]] || { echo unknown; return 0; }
  echo "$running $queued ${selftest:-none}"
}

# require_idle WHAT: stop unless nothing runs, waits or self-tests on the VM (or --force).
require_idle() {
  local state running queued selftest
  state=$(busy_state)
  case "$state" in
    down) echo "nothing answers on 127.0.0.1:8080 on the VM (connection refused): nothing to protect" ;;
    unknown)
      [ "$force" = yes ] || die "the app answered, but its queue could not be read (or it timed out): check it, or pass --force"
      echo "the queue on the VM is unknown; going on anyway (--force)" ;;
    *)
      read -r running queued selftest <<< "$state"
      if [ "$running" != 0 ] || [ "$queued" != 0 ] || [ "$selftest" != none ]; then
        [ "$force" = yes ] || die "$running task(s) running, $queued waiting, self-test: $selftest. $1 would stop them. Wait, or pass --force"
        echo "$running running, $queued waiting, self-test $selftest; going on anyway (--force)"
      else
        echo "idle: no task running or waiting, no self-test"
      fi ;;
  esac
}

dirty=no force=no selftest=no
for arg in "$@"; do
  case "$arg" in
    --dirty) dirty=yes ;;
    --force) force=yes ;;
    --selftest) selftest=yes ;;
    -h | --help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: scripts/deploy.sh [--dirty] [--force] [--selftest]" >&2; exit 64 ;;
  esac
done

# 1. Clean tree. app/VERSION.json is written by this script, so it never counts as a change.
say "1/11 clean tree"
changes=$(git status --porcelain -- "${PATHS[@]}" ':(exclude)app/VERSION.json')
if [ -n "$changes" ]; then
  printf '%s\n' "$changes"
  [ "$dirty" = yes ] || die "uncommitted changes (listed above): commit them first, or pass --dirty"
  echo "deploying these uncommitted changes (--dirty)"
else
  echo "clean at $(git rev-parse --short HEAD)"
fi

# 2. Local checks: syntax, the Node 22 lint (Appendix C) and the unit tests.
say "2/11 local checks"
for f in app/*.mjs agent/*.mjs runner/*.mjs test/*.mjs bench/*.mjs; do node --check "$f"; done
node --check app/public/app.js
grep -nE 'Promise\.try|RegExp\.escape|Error\.isError|fromBase64|toBase64\(|\.toHex\(|fromHex|Float16Array|Temporal\.|getOrInsert|Iterator\.concat|URLPattern|DisposableStack|sumPrecise|^\s*(await\s+)?using\s+[A-Za-z_$]|\(\?[imsx-]+:' app/*.mjs agent/*.mjs runner/*.mjs test/*.mjs bench/*.mjs \
  && die "the lines above use APIs that the VM's Node 22 does not have (BUILD-SPEC Appendix C)" || true
# Two statements, not `a && b`: under set -e a failure on the left of && would not stop the script.
node test/agent-loop.mjs --unit || die "node test/agent-loop.mjs --unit failed"
node test/app-api.mjs || die "node test/app-api.mjs failed"

# 3. Version file, shown on /status.
say "3/11 app/VERSION.json"
is_dirty=false
[ -z "$changes" ] || is_dirty=true
printf '{"commit":"%s","dirty":%s,"deployedAt":"%s"}\n' "$(git rev-parse --short HEAD)" "$is_dirty" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > app/VERSION.json
cat app/VERSION.json

# 4. Busy check: a restart kills running tasks, the queue and a self-test.
say "4/11 busy check"
require_idle "A restart"
# The commit the VM runs now, for the rollback message and the reminder in step 11.
old_commit=$("${S[@]}" 'curl -fsS -m 10 http://127.0.0.1:8080/status.json' 2> /dev/null | json_field version | json_field commit || true)

# 5. rsync into the staging folder in deploy's home; the live tree is not touched yet.
say "5/11 rsync to $H:ring-next/ (staging)"
# shellcheck disable=SC2086 # EXCLUDES is a list of options
"$RSYNC_BIN" -az --delete --chmod=go+rX,go-w $EXCLUDES -e "$SSH_BIN ${SSH_OPTS[*]}" ./ "$H":ring-next/

# 6. The VM runs Node 22, and WSL's Node accepts code that it rejects: check the staged tree there.
say "6/11 checks on the VM's Node 22, in ring-next"
"${S[@]}" 'set -e; cd ring-next; echo "node $(node --version)"
for f in app/*.mjs agent/*.mjs runner/*.mjs test/*.mjs bench/*.mjs; do node --check "$f"; done
clean() { env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 "$@"; }
clean node --input-type=module -e "for (const m of [\"./app/server.mjs\", \"./agent/loop.mjs\", \"./agent/probe.mjs\", \"./agent/vision.mjs\"]) await import(m); console.log(\"every module imports\")"
for t in "agent-loop.mjs --unit" "app-api.mjs"; do
  log=$(mktemp /tmp/ring-next-check.XXXXXX)
  if clean node test/$t > "$log" 2>&1; then tail -n 1 "$log"; rm -f "$log"; else grep -E "^FAIL" "$log" | head -n 20; tail -n 3 "$log"; rm -f "$log"; exit 1; fi
done' || die "the VM's Node 22 rejects the staged tree (lines above); the live tree and the service were not touched"

# 7. Save the live tree, then put the staged one in its place.
say "7/11 save the live tree to ring-prev/ and swap ring-next/ in"
"${S[@]}" "rsync -a --delete $EXCLUDES /srv/mantis-ring/ ring-prev/ && rsync -a --delete $EXCLUDES ring-next/ /srv/mantis-ring/"

# 8. Restart, wait for /status.json, and check that every part of the app loaded. Roll back otherwise.
say "8/11 restart mantis-ring"
restart_and_wait() {
  "${S[@]}" 'sudo systemctl restart mantis-ring' || return 1
  for _ in $(seq 1 30); do
    if "${S[@]}" 'curl -fsS -m 3 http://127.0.0.1:8080/status.json' > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
# The server starts without a part that fails to load (and every run then fails), so ask it.
parts_loaded() {
  local h f
  h=$("${S[@]}" 'curl -fsS -m 30 http://127.0.0.1:8080/admin/health' 2> /dev/null) || { echo "/admin/health did not answer" >&2; return 1; }
  for f in loop probe vision spend; do
    [ "$(printf '%s' "$h" | json_field "$f")" = true ] || { echo "/admin/health: '$f' is not loaded" >&2; return 1; }
  done
  echo "/admin/health: loop, probe, vision and spend are loaded"
}
rollback() {
  echo "$1; the end of the journal:" >&2
  # This exact command line is the only journalctl that sudo allows deploy; the output is filtered here.
  "${S[@]}" 'sudo journalctl -u mantis-ring -n 300 --no-pager' | tail -n 40 >&2 || true
  echo "rolling back to the saved tree (ring-prev/, commit ${old_commit:-unknown})" >&2
  "${S[@]}" "rsync -a --delete $EXCLUDES ring-prev/ /srv/mantis-ring/" || die "the rollback copy failed: the VM needs a hand"
  restart_and_wait || die "the saved tree did not start either: the VM needs a hand"
  die "$1 (rolled back to ${old_commit:-the saved tree}; the app answers again)"
}
restart_and_wait || rollback "the app did not answer /status.json after the restart"
parts_loaded || rollback "a part of the app did not load"
echo "the app answers /status.json"
# Exits 3 when the unit is inactive: never chain it with &&.
"${S[@]}" 'sudo systemctl status mantis-ring' || true

# 9. From outside, as a judge: the pages answer, gVisor is on, the admin API is not reachable, and
# both public switches are still closed (D-5), or only what RING_ALLOW_PUBLIC allows is open.
say "9/11 outside checks ($URL)"
if hc=$(bash "$HEALTHCHECK" "$URL" --status-grep runsc); then
  echo "$hc"
else
  echo "$hc" >&2
  die "the healthcheck did not print OK (line above)"
fi
admin_code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$URL/admin/health" || true)
[ "$admin_code" = 404 ] || die "$URL/admin/health answered $admin_code (it must be 404): the admin API may be public. Fix this before anything else."
echo "/admin/health through Caddy: 404"
# Each switch reads true, false, or '' when /api/config did not answer or lacks it (anything but false is open).
api_config=$(curl -fsS -m 20 "$URL/api/config" || true)
sample_runs=$(printf '%s' "$api_config" | json_field publicSampleRuns)
github_runs=$(printf '%s' "$api_config" | json_field publicGithubRuns)
case "${RING_ALLOW_PUBLIC:-}" in
  yes) ;;
  sample)
    [ "$github_runs" = false ] || die "$URL/api/config says publicGithubRuns is '$github_runs': runs on GitHub repositories must stay closed with RING_ALLOW_PUBLIC=sample (D-5). Close them with scripts/ring.sh config, or set RING_ALLOW_PUBLIC=yes once the owner opens them." ;;
  *)
    [ "$sample_runs" = false ] && [ "$github_runs" = false ] \
      || die "$URL/api/config says publicSampleRuns is '$sample_runs' and publicGithubRuns is '$github_runs': public runs must stay closed (D-5). Close them with scripts/ring.sh config, or set RING_ALLOW_PUBLIC=sample or yes once the owner opens them." ;;
esac
echo "public runs: sample ${sample_runs:-unknown}, GitHub ${github_runs:-unknown}"

# 10. Self-tests under gVisor, only with no task running.
if [ "$selftest" = yes ]; then
  say "10/11 ring-selftest (every sandbox under gVisor)"
  require_idle "The self-test"
  log=$(mktemp /tmp/ring-selftest.XXXXXX)
  trap 'rm -f "$log"' EXIT
  status=0
  "${S[@]}" 'sudo -u ring-orch /usr/local/sbin/ring-selftest' 2>&1 | tee "$log" || status=$?
  summary=$(grep -E '^[0-9]+/[0-9]+ .*checks passed' "$log" || true)
  printf '\n%s\n' "$summary"
  [ "$status" = 0 ] || die "ring-selftest failed (exit $status)"
  [ "$(printf '%s\n' "$summary" | grep -c .)" -ge 2 ] || die "ring-selftest printed fewer than two summary lines"
  printf '%s\n' "$summary" | awk '{ split($1, n, "/"); if (n[1] != n[2]) bad = 1 } END { exit bad }' \
    || die "a self-test suite did not pass every check"
else
  say "10/11 self-tests skipped (pass --selftest to run ring-selftest)"
fi

# 11. Images and the proxy are rebuilt by ring-setup, which this script never runs on its own.
say "11/11 sandbox/, proxy/ and scripts/setup.sh"
setup="${S[*]} 'sudo -u ring-orch /usr/local/sbin/ring-setup'"
if [ -n "$old_commit" ] && git cat-file -e "$old_commit^{commit}" 2> /dev/null; then
  if git diff --quiet "$old_commit" HEAD -- sandbox proxy scripts/setup.sh && [ -z "$(git status --porcelain -- sandbox proxy scripts/setup.sh)" ]; then
    echo "unchanged since $old_commit: nothing to do"
  else
    echo "sandbox/, proxy/ or scripts/setup.sh changed since $old_commit. With no task running, rebuild them:"
    echo "  $setup"
  fi
else
  echo "the VM's previous commit is unknown. If sandbox/, proxy/ or scripts/setup.sh changed, run this with no task running:"
  echo "  $setup"
fi
echo
echo "deployed $(json_field commit < app/VERSION.json) to $URL (the previous tree is kept in $H:ring-prev/)"
