#!/usr/bin/env bash
# Deploys this repository to the Vultr VM as `deploy` and restarts the app (BUILD-SPEC §5.1).
# It refuses uncommitted code (the VM should run a commit) and checks the code locally. The tree goes
# to a staging folder on the VM first (~/ring-next), where the VM's own Node 22 checks it: syntax,
# every module imported, and the Docker-free test suites. Only then is the live tree saved
# (~/ring-prev) and replaced. A restart that does not come up, or comes up without the agent loop,
# the probe, the vision check or the spend ledger, is rolled back to the saved tree. A restart
# interrupts every task that runs or waits and kills a self-test, and nothing holds the queue across
# it: the script refuses to go on while a task runs or waits, or a self-test waits or runs, both
# before it copies the code and again just before it swaps the tree in and restarts, so only a run
# that starts in the few seconds between that last check and the restart is interrupted. It ends with
# the checks a judge would see from outside: the pages answer, gVisor is on, /admin/* is a 404 through
# Caddy, and both public switches (runs of the sample, runs on GitHub repositories) are still closed.
#
# Usage: scripts/deploy.sh [--dirty] [--force] [--selftest]
#   --dirty     deploy uncommitted changes too (app/VERSION.json then says dirty: true)
#   --force     restart even while a task or a self-test runs, or when the VM's queue cannot be read
#   --selftest  afterwards, run the containment, scene and agent-loop suites through the app's queue, one
#               POST /admin/selftest each (scripts/ring.sh selftest): each waits until no task runs and
#               holds new ones until it ends. Each must start under gVisor and pass every check, and
#               /status.json must then show each suite's result on the deployed commit
# Once the owner opens public runs (D-5): RING_ALLOW_PUBLIC=sample accepts open sample runs while
# GitHub runs must still be closed, github the other way round, and yes accepts both open (the same
# values that let scripts/ring.sh config open each switch).
# RING_HEALTHCHECK=<script>: the outside checks run `bash <script> <url> --status-grep runsc`, which must
# exit 0 (the deployment templates' healthcheck.sh takes these arguments), instead of the built-in
# ones: /, /latest/ and /status answer 200 within 20 s, /status names runsc, and an https:// address
# has a certificate with 7 days or more left. When set, it must name a readable file.
# Environment, for tests only: RING_SSH, RING_RSYNC (programs to use instead of ssh and rsync; they
# must be executable), RING_HOST, RING_URL. With RING_TEST=1 the script refuses to run unless both
# programs are test stand-ins, the host is not the real VM and RING_URL is a loopback http:// address,
# so a broken fake can never fall through to the real ssh or the real site. test/app-api.mjs sources
# this file with RING_TEST=1 to run single steps against stand-ins: sourced, it only defines its
# functions and deploys nothing.
set -euo pipefail
# RING_HEALTHCHECK is a path from the caller's folder, so a relative one is resolved before the cd.
HEALTHCHECK=${RING_HEALTHCHECK:-}
[ -z "$HEALTHCHECK" ] || [[ $HEALTHCHECK == /* ]] || HEALTHCHECK=$PWD/$HEALTHCHECK
cd "$(dirname "${BASH_SOURCE[0]}")/.."
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
  # The outside checks would reach the real site (the default URL): only a loopback http:// address.
  [[ $URL =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$ ]] || die "RING_TEST=1, but RING_URL is not a loopback http:// address: '$URL'"
  for b in "$SSH_BIN" "$RSYNC_BIN"; do
    case "$(command -v -- "$b" || true)" in
      '' | /usr/bin/* | /bin/* | /usr/local/bin/*) die "RING_TEST=1, but '$b' is not a test stand-in: set RING_SSH and RING_RSYNC" ;;
    esac
  done
fi
[ -z "$HEALTHCHECK" ] || { [ -f "$HEALTHCHECK" ] && [ -r "$HEALTHCHECK" ]; } || die "RING_HEALTHCHECK is set but is not a readable file: $HEALTHCHECK"

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

# require_idle WHAT [NOTE]: stop unless nothing runs, waits or self-tests on the VM (or --force). NOTE,
# when given, ends the refusal: what has and has not been done on the VM so far.
require_idle() {
  local state running queued selftest note=${2:+ ($2)}
  state=$(busy_state)
  case "$state" in
    down) echo "nothing answers on 127.0.0.1:8080 on the VM (connection refused): nothing to protect" ;;
    unknown)
      [ "$force" = yes ] || die "the app answered, but its queue could not be read (or it timed out): check it, or pass --force$note"
      echo "the queue on the VM is unknown; going on anyway (--force)" ;;
    *)
      read -r running queued selftest <<< "$state"
      if [ "$running" != 0 ] || [ "$queued" != 0 ] || [ "$selftest" != none ]; then
        [ "$force" = yes ] || die "$running task(s) running, $queued waiting, self-test: $selftest. $1 would stop them. Wait, or pass --force$note"
        echo "$running running, $queued waiting, self-test $selftest; going on anyway (--force)"
      else
        echo "idle: no task running or waiting, no self-test"
      fi ;;
  esac
}

# The suites that --selftest runs through the app, in this order.
SELFTEST_SUITES=(containment scenes agent-loop)
# The app rereads the suites' result files for /status.json at most every 30 s, so a read that still
# shows the earlier results is tried again: up to STATUS_TRIES reads, STATUS_PAUSE seconds apart.
STATUS_TRIES=8
STATUS_PAUSE=5

# selftest_problem SUITE FILE: nothing when FILE, the output of one POST /admin/selftest, shows that the
# suite started under gVisor, that every "n/m ... checks passed" line it printed has n = m, and that
# its last line is "selftest SUITE: exit 0"; otherwise one sentence that names the suite.
selftest_problem() {
  local suite=$1 file=$2 started last summary
  started=$(grep -m 1 -E "^selftest $suite: started" "$file" || true)
  last=$(grep -v -E '^[[:space:]]*$' "$file" | tail -n 1 || true)
  summary=$(grep -E '^[0-9]+/[0-9]+ .*checks passed' "$file" || true)
  if [ -z "$started" ]; then
    echo "the $suite self-test did not start (no 'selftest $suite: started' line; the last line: ${last:-none})"
  elif [ "$started" != "selftest $suite: started, runtime runsc" ]; then
    echo "the $suite self-test did not run under gVisor: '$started'"
  elif [ "$last" != "selftest $suite: exit 0" ]; then
    echo "the $suite self-test failed: its last line is '$last', not 'selftest $suite: exit 0'"
  elif [ -z "$summary" ]; then
    echo "the $suite self-test printed no 'n/m ... checks passed' line"
  elif ! printf '%s\n' "$summary" | awk '{ split($1, n, "/"); if (n[1] != n[2] || n[2] == 0) bad = 1 } END { exit bad }'; then
    echo "the $suite self-test did not pass every check: $(printf '%s' "$summary" | tr '\n' ' ')"
  fi
}

# selftest_results COMMIT: one line per suite from the /status.json on stdin (app/status.mjs
# readSelftests); fails unless each suite's result is on COMMIT, under runsc, with every check passed.
selftest_results() {
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const commit = process.argv[1];
    let st = null;
    try { st = JSON.parse(s).selftest ?? null; } catch { st = null; }
    if (!st || typeof st !== "object") { console.log("/status.json: no self-test results"); process.exit(1); }
    let bad = 0;
    for (const [key, name] of [["containment", "containment"], ["scenes", "scenes"], ["agentLoop", "agent-loop"]]) {
      const r = st[key];
      const ok = !!r && r.commit === commit && r.runtime === "runsc" && Number.isInteger(r.total) && r.total > 0 && r.passed === r.total;
      if (!ok) bad += 1;
      console.log(`/status.json: ${name} ${r ? `${r.passed}/${r.total} under ${r.runtime ?? "an unknown runtime"} on ${r.commit ?? "an unknown commit"} at ${r.at ?? "an unknown time"}` : "no result"}${ok ? "" : ` (not a pass under runsc on ${commit})`}`);
    }
    process.exit(bad ? 1 : 0);
  });' "$1"
}

# run_selftests COMMIT: step 10. Each suite goes through the app's queue with scripts/ring.sh selftest,
# given the same ssh, host and test flag as this script. The app waits until no task runs and holds new
# ones meanwhile, so a busy VM is reported here, not refused. Afterwards /status.json must show each
# suite's result on COMMIT, under runsc, with every check passed.
run_selftests() {
  local commit=$1 state running queued busy suite rc why out verdict='' try
  local summaries=()
  [[ $commit =~ ^[0-9a-f]{4,40}$ ]] || die "the deployed commit is unknown ('$commit'), so the self-tests' results cannot be checked"
  state=$(busy_state)
  case "$state" in
    down) die "nothing answers on 127.0.0.1:8080 on the VM (connection refused): the self-tests run through the app" ;;
    unknown) echo "the queue on the VM could not be read; each suite still waits in the app until no task runs" ;;
    *)
      read -r running queued busy <<< "$state"
      if [ "$running" = 0 ] && [ "$queued" = 0 ] && [ "$busy" = none ]; then
        echo "idle: no task running or waiting, no self-test"
      else
        echo "busy: $running task(s) running, $queued waiting, self-test: $busy. Each suite waits until no task runs, and no task starts while it waits or runs"
      fi ;;
  esac
  SELFTEST_LOG=$(mktemp /tmp/ring-selftest.XXXXXX)
  trap 'rm -f "$SELFTEST_LOG"' EXIT
  for suite in "${SELFTEST_SUITES[@]}"; do
    printf '\n--- %s, through the app\n' "$suite"
    rc=0
    RING_SSH=${RING_SSH:-} RING_HOST=$HOST_ADDR RING_TEST=${RING_TEST:-} bash scripts/ring.sh selftest "$suite" | tee "$SELFTEST_LOG" || rc=$?
    why=$(selftest_problem "$suite" "$SELFTEST_LOG")
    [ -z "$why" ] || die "$why"
    [ "$rc" = 0 ] || die "scripts/ring.sh selftest $suite exited $rc"
    summaries+=("$(grep -E '^[0-9]+/[0-9]+ .*checks passed' "$SELFTEST_LOG" | tail -n 1)")
  done
  echo
  printf '%s\n' "${summaries[@]}"
  # A read that fails (ssh, or curl on the VM: the app restarting, say) is told apart from results that
  # are not there yet, so the last try names what really went wrong.
  for ((try = 1; try <= STATUS_TRIES; try++)); do
    rc=0
    out=$("${S[@]}" 'curl -fsS -m 10 http://127.0.0.1:8080/status.json' 2> /dev/null) || rc=$?
    if [ "$rc" != 0 ]; then
      verdict="could not read /status.json on the VM (ssh/curl exit $rc)"
    elif verdict=$(printf '%s' "$out" | selftest_results "$commit"); then
      printf '%s\n' "$verdict"
      return 0
    fi
    [ "$try" = "$STATUS_TRIES" ] || sleep "$STATUS_PAUSE"
  done
  printf '%s\n' "$verdict" >&2
  [ "$rc" = 0 ] || die "every suite passed (lines above), but /status.json could not be read on the VM after $STATUS_TRIES tries (ssh/curl exit $rc)"
  die "/status.json does not show every suite passing under runsc on $commit (lines above)"
}

# builtin_healthcheck: the outside checks' own health check when RING_HEALTHCHECK is not set, as strict
# as the deployment templates' healthcheck.sh: /, /latest/ and /status answer 200 within 20 s, /status
# names runsc (the page shows that word only when Docker lists gVisor), and an https:// address has a
# certificate with 7 days or more left. Prints one line, as healthcheck.sh does; fails when a check fails.
builtin_healthcheck() {
  local fail=0 parts=() p out code secs item hostport connect end end_s days
  for p in / /latest/ /status; do
    out=$(curl -sS --max-time 20 -w '\n%{http_code} %{time_total}' "$URL$p" 2> /dev/null || true)
    code='' secs=''
    read -r code secs <<< "${out##*$'\n'}" || true
    [[ $code =~ ^[0-9]{3}$ ]] || code=000
    if [[ $secs =~ ^[0-9]+(\.[0-9]{1,2})? ]]; then secs=${BASH_REMATCH[0]}; else secs=0; fi
    item="$p $code ${secs}s"
    if [ "$code" != 200 ]; then
      fail=1
      item="$item FAIL"
    elif [ "$p" = /status ] && [[ $out != *runsc* ]]; then
      fail=1
      item="$item (no 'runsc')"
    fi
    parts+=("$item")
  done
  if [[ $URL == https://* ]]; then
    hostport=${URL#https://}
    hostport=${hostport%%/*}
    connect=$hostport
    [[ $hostport == *:* ]] || connect=$hostport:443
    end=$(timeout 20 openssl s_client -servername "${hostport%%:*}" -connect "$connect" < /dev/null 2> /dev/null \
      | openssl x509 -noout -enddate 2> /dev/null | cut -d= -f2 || true)
    end_s=$(date -d "$end" +%s 2> /dev/null || true)
    if [ -n "$end" ] && [[ $end_s =~ ^[0-9]+$ ]]; then
      days=$(( (end_s - $(date +%s)) / 86400 ))
      [ "$days" -ge 7 ] || fail=1
      parts+=("cert ${days}d")
    else
      fail=1
      parts+=("cert unreadable")
    fi
  fi
  if [ "$fail" = 0 ]; then item=OK; else item=FAIL; fi
  echo "$(date -u +%FT%TZ) $item $URL$(printf ' | %s' "${parts[@]}")"
  [ "$fail" = 0 ]
}

# outside_checks: step 9, the site as a judge reaches it: the health check (RING_HEALTHCHECK's script,
# or the built-in one), /admin/* a 404 through Caddy, and both public switches closed (D-5), or only
# what RING_ALLOW_PUBLIC allows open.
outside_checks() {
  local hc admin_code api_config sample_runs github_runs
  if [ -n "$HEALTHCHECK" ]; then
    hc=$(bash "$HEALTHCHECK" "$URL" --status-grep runsc) || { printf '%s\n' "$hc" >&2; die "$HEALTHCHECK did not pass (its line above)"; }
  else
    hc=$(builtin_healthcheck) || { printf '%s\n' "$hc" >&2; die "the outside health check did not pass (its line above)"; }
  fi
  printf '%s\n' "$hc"
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
    github)
      [ "$sample_runs" = false ] || die "$URL/api/config says publicSampleRuns is '$sample_runs': runs of the sample must stay closed with RING_ALLOW_PUBLIC=github (D-5). Close them with scripts/ring.sh config, or set RING_ALLOW_PUBLIC=yes once the owner opens them." ;;
    *)
      [ "$sample_runs" = false ] && [ "$github_runs" = false ] \
        || die "$URL/api/config says publicSampleRuns is '$sample_runs' and publicGithubRuns is '$github_runs': public runs must stay closed (D-5). Close them with scripts/ring.sh config, or set RING_ALLOW_PUBLIC=sample or yes once the owner opens them." ;;
  esac
  echo "public runs: sample ${sample_runs:-unknown}, GitHub ${github_runs:-unknown}"
}

# swap_in: step 7. The busy check again, just before the live tree changes: step 6 takes half a minute or
# more, and a task that started meanwhile would be interrupted by the restart. Then the live tree is saved
# to ring-prev/ and the staged one put in its place. A refusal leaves the live tree and the service as
# they were.
swap_in() {
  require_idle "A restart" "the staged tree is in ring-next/; the live tree and the service were not touched"
  "${S[@]}" "rsync -a --delete $EXCLUDES /srv/mantis-ring/ ring-prev/ && rsync -a --delete $EXCLUDES ring-next/ /srv/mantis-ring/"
}

# Sourced by a test (only with RING_TEST=1, so the guard above has run): the functions are defined, and
# nothing below runs.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  [ "${RING_TEST:-}" = 1 ] || die "this file is sourced only by tests, with RING_TEST=1"
  return 0
fi

dirty=no force=no selftest=no
for arg in "$@"; do
  case "$arg" in
    --dirty) dirty=yes ;;
    --force) force=yes ;;
    --selftest) selftest=yes ;;
    -h | --help) sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# 4. Busy check: a restart kills running tasks, the queue and a self-test (checked again in step 7).
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

# 7. The busy check again, then save the live tree and put the staged one in its place.
say "7/11 busy check again, then save the live tree to ring-prev/ and swap ring-next/ in"
swap_in

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
outside_checks

# 10. Self-tests under gVisor, through the app's queue: no task runs beside them.
if [ "$selftest" = yes ]; then
  say "10/11 self-tests through the app's queue: ${SELFTEST_SUITES[*]} (every sandbox under gVisor)"
  run_selftests "$(json_field commit < app/VERSION.json)"
else
  say "10/11 self-tests skipped (pass --selftest to run them through the app's queue)"
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
