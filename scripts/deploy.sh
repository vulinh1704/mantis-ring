#!/usr/bin/env bash
# Deploys this repository to the Vultr VM as `deploy` and restarts the app (BUILD-SPEC §5.1).
# It refuses uncommitted code (the VM should run a commit), checks the code locally and on the VM's
# Node 22, refuses to restart while a task is running (a restart kills it), and ends with the checks a
# judge would see from outside: the pages answer, gVisor is on, and /admin/* is a 404 through Caddy.
#
# Usage: scripts/deploy.sh [--dirty] [--force] [--selftest]
#   --dirty     deploy uncommitted changes too (app/VERSION.json then says dirty: true)
#   --force     restart even while a task is running
#   --selftest  afterwards, with no task running, run ring-selftest (13/13 containment, 17/17 scenes)
set -euo pipefail
cd "$(dirname "$0")/.."
H=deploy@104.156.252.200
S=(ssh -i ~/.ssh/vultr_ring_deploy -o BatchMode=yes -o ConnectTimeout=10 "$H")
URL=https://104-156-252-200.sslip.io
HEALTHCHECK=/mnt/g/Work/MyCompany/FindJob/30-projects/mantis/vultr-pack/deploy/healthcheck.sh
PATHS=(app agent runner test scripts demo sandbox proxy)

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
# json_field FIELD: print one top-level field of the JSON on stdin ('' when absent or not JSON).
json_field() {
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { const v = JSON.parse(s)[process.argv[1]]; console.log(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)); }
    catch { console.log(""); } });' "$1"
}
# running_tasks: the number of running tasks on the VM; '' when the app does not answer; 'unknown'
# when it answers without a readable number (then nobody can say a restart is harmless).
running_tasks() {
  local health n
  health=$("${S[@]}" 'curl -fsS -m 5 http://127.0.0.1:8080/admin/health' 2> /dev/null) || return 0
  n=$(printf '%s' "$health" | json_field running)
  if [[ $n =~ ^[0-9]+$ ]]; then echo "$n"; else echo unknown; fi
}

dirty=no force=no selftest=no
for arg in "$@"; do
  case "$arg" in
    --dirty) dirty=yes ;;
    --force) force=yes ;;
    --selftest) selftest=yes ;;
    -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: scripts/deploy.sh [--dirty] [--force] [--selftest]" >&2; exit 64 ;;
  esac
done

# 1. Clean tree. app/VERSION.json is written by this script, so it never counts as a change.
say "1/10 clean tree"
changes=$(git status --porcelain -- "${PATHS[@]}" ':(exclude)app/VERSION.json')
if [ -n "$changes" ]; then
  printf '%s\n' "$changes"
  [ "$dirty" = yes ] || die "uncommitted changes (listed above): commit them first, or pass --dirty"
  echo "deploying these uncommitted changes (--dirty)"
else
  echo "clean at $(git rev-parse --short HEAD)"
fi

# 2. Local checks: syntax, the Node 22 lint (Appendix C) and the unit tests.
say "2/10 local checks"
for f in app/*.mjs agent/*.mjs runner/*.mjs test/*.mjs; do node --check "$f"; done
node --check app/public/app.js
grep -nE 'Promise\.try|RegExp\.escape|Error\.isError|fromBase64|toBase64\(|\.toHex\(|fromHex|Float16Array|Temporal\.|getOrInsert|Iterator\.concat|URLPattern|DisposableStack|sumPrecise|^\s*(await\s+)?using\s+[A-Za-z_$]|\(\?[imsx-]+:' app/*.mjs agent/*.mjs runner/*.mjs test/*.mjs \
  && die "the lines above use APIs that the VM's Node 22 does not have (BUILD-SPEC Appendix C)" || true
# Two statements, not `a && b`: under set -e a failure on the left of && would not stop the script.
node test/agent-loop.mjs --unit || die "node test/agent-loop.mjs --unit failed"
node test/app-api.mjs || die "node test/app-api.mjs failed"

# 3. Version file, shown on /status.
say "3/10 app/VERSION.json"
is_dirty=false
[ -z "$changes" ] || is_dirty=true
printf '{"commit":"%s","dirty":%s,"deployedAt":"%s"}\n' "$(git rev-parse --short HEAD)" "$is_dirty" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > app/VERSION.json
cat app/VERSION.json

# 4. Busy check. No answer means no app yet (or it is down): nothing to protect.
say "4/10 busy check"
running=$(running_tasks)
case "$running" in
  '') echo "the app does not answer on the VM: continuing" ;;
  0) echo "no task running" ;;
  unknown)
    [ "$force" = yes ] || die "the app answered /admin/health without a number of running tasks: check it, or pass --force"
    echo "the number of running tasks is unknown; restarting anyway (--force)" ;;
  *)
    [ "$force" = yes ] || die "$running task(s) running on the VM: a restart would kill them. Wait, or pass --force"
    echo "$running task(s) running; restarting anyway (--force)" ;;
esac
# The commit the VM runs now, for the reminder in step 10.
old_commit=$("${S[@]}" 'curl -fsS -m 5 http://127.0.0.1:8080/status.json' 2> /dev/null | json_field version | json_field commit || true)

# 5. rsync. The excludes are anchored where they must be (/out, /state, /.ring-public).
say "5/10 rsync to $H:/srv/mantis-ring/"
rsync -az --delete --chmod=go+rX,go-w --exclude .git --exclude node_modules --exclude /out --exclude .mantis --exclude /state --exclude /.ring-public \
  -e "ssh -i ~/.ssh/vultr_ring_deploy -o BatchMode=yes" ./ "$H":/srv/mantis-ring/

# 6. The VM runs Node 22: WSL's Node accepts code that it rejects.
say "6/10 node --check on the VM"
"${S[@]}" 'cd /srv/mantis-ring && for f in app/*.mjs agent/*.mjs runner/*.mjs; do node --check "$f" || exit 1; done' \
  || die "the VM's Node 22 rejects the file above; the service was not restarted"

# 7. Restart, then wait for /status.json.
say "7/10 restart mantis-ring"
"${S[@]}" 'sudo systemctl restart mantis-ring'
up=no
for _ in $(seq 1 20); do
  if "${S[@]}" 'curl -fsS -m 3 http://127.0.0.1:8080/status.json' > /dev/null 2>&1; then up=yes; break; fi
  sleep 1
done
if [ "$up" != yes ]; then
  echo "the app did not answer /status.json after the restart; the end of its journal:" >&2
  # This exact command line is the only journalctl that sudo allows deploy; the output is filtered here.
  "${S[@]}" 'sudo journalctl -u mantis-ring -n 300 --no-pager' | tail -n 60 >&2 || true
  exit 1
fi
echo "the app answers /status.json"
# Exits 3 when the unit is inactive: never chain it with &&.
"${S[@]}" 'sudo systemctl status mantis-ring' || true

# 8. From outside, as a judge: the pages answer, gVisor is on, and the admin API is not reachable.
say "8/10 outside checks ($URL)"
if hc=$(bash "$HEALTHCHECK" "$URL" --status-grep runsc); then
  echo "$hc"
else
  echo "$hc" >&2
  die "the healthcheck did not print OK (line above)"
fi
admin_code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$URL/admin/health" || true)
[ "$admin_code" = 404 ] || die "$URL/admin/health answered $admin_code (it must be 404): the admin API may be public. Fix this before anything else."
echo "/admin/health through Caddy: 404"

# 9. Self-tests under gVisor, only with no task running.
if [ "$selftest" = yes ]; then
  say "9/10 ring-selftest (every sandbox under gVisor)"
  running=$(running_tasks)
  [ "$running" = 0 ] || die "a task is running (or the app does not answer): run the self-test later"
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
  say "9/10 self-tests skipped (pass --selftest to run ring-selftest)"
fi

# 10. Images and the proxy are rebuilt by ring-setup, which this script never runs on its own.
say "10/10 sandbox/ and proxy/"
setup="${S[*]} 'sudo -u ring-orch /usr/local/sbin/ring-setup'"
if [ -n "$old_commit" ] && git cat-file -e "$old_commit^{commit}" 2> /dev/null; then
  if git diff --quiet "$old_commit" HEAD -- sandbox proxy && [ -z "$(git status --porcelain -- sandbox proxy)" ]; then
    echo "unchanged since $old_commit: nothing to do"
  else
    echo "sandbox/ or proxy/ changed since $old_commit. With no task running, rebuild them:"
    echo "  $setup"
  fi
else
  echo "the VM's previous commit is unknown. If sandbox/ or proxy/ changed, run this with no task running:"
  echo "  $setup"
fi
echo
echo "deployed $(json_field commit < app/VERSION.json) to $URL"
