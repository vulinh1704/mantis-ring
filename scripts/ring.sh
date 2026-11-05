#!/usr/bin/env bash
# Drives the Mantis Ring app on the VM as local admin (BUILD-SPEC §5.2). Every command is a curl to
# 127.0.0.1:8080 run over SSH as `deploy`, so it reaches the app from loopback without X-Forwarded-For.
# JSON bodies travel on stdin (curl --data-binary @-), never inside the remote command line, and task
# ids are checked before they are. The owner link that `run` prints is for the owner only: approving
# a run needs the owner's browser and is refused on this admin channel (and, once the owner sets an
# approval passphrase on the server, an admin run needs that passphrase too).
#
# Usage: scripts/ring.sh <command> [args]
#   status                    /status.json
#   health                    /admin/health: running and queued tasks, Docker, the runtime, the proxy, and how
#                             many of the app's sandboxes and their own networks (ring-task-…) exist; 0 and 0 when idle
#   probe '<json>'            POST /admin/probe  {"models":[...],"vision":[...]}
#   run '<json>'              POST /admin/tasks  prints the id, the position and the owner link
#   watch <id>                live events (SSE) until the task is done; Ctrl-C to stop
#   get <id>                  /admin/tasks/<id>: the full record and the receipt
#   tasks [state] [label]     /admin/tasks, optionally filtered
#   cancel <id>               POST /admin/tasks/<id>/cancel
#   bundle <id> <localdir>    every file of the task, unpacked into <localdir>
#   publish <id>              POST /admin/publish/<id>
#   config ['<json>']         GET, or POST with a patch, /admin/config. A patch that opens publicSampleRuns
#                             needs RING_ALLOW_PUBLIC=sample (or yes), one that opens publicGithubRuns needs
#                             RING_ALLOW_PUBLIC=github (or yes), and yes alone lets one patch open both, as in
#                             deploy.sh; the old publicRuns needs yes. Closing them never needs anything
#   spend                     /admin/spend
#   selftest <suite>          POST /admin/selftest (agent-loop | containment | scenes): the app waits until no
#                             task runs and holds new ones until the suite ends. Streams its output, with SSH
#                             keepalives while it waits, and exits with the suite's own exit code
#   logs                      the last 300 lines of the app's journal
#   mem [seconds]             the VM's memory, read-only (scripts/vm-mem.sh): free -m, then what each container (the
#                             sandboxes, the proxy), the app, Caddy and Docker hold now, at most and at their limit;
#                             with seconds (at most 600), first the least memory available over that long
#   tts <model> <text-file> <out-file> [voice|- [speed]]
#                             POST /admin/speech: the VM speaks the text file in English (at most 800 characters;
#                             white space becomes single spaces) with a priced speech model of the catalogue, such
#                             as chatterbox or qwen3-tts-12hz-1.7b, and a built-in voice (- for the model's own).
#                             speed, from 0.5 to 2, slows or quickens the reading; the provider bills the seconds
#                             before it. The audio comes back into <out-file>, whose extension picks the format
#                             (.mp3 .wav .flac .opus); the key stays on the VM. A call goes out only if its
#                             estimate fits $0.05 and today's $0.50 (see spend)
# Environment, for tests only: RING_SSH (a program to use instead of ssh; it must be executable) and
# RING_HOST. With RING_TEST=1 the script refuses the real ssh and the real VM.
set -euo pipefail
REAL_HOST=104.156.252.200
HOST_ADDR=${RING_HOST:-$REAL_HOST}
H=deploy@$HOST_ADDR
SSH_BIN=${RING_SSH:-ssh}
# IdentitiesOnly: only the deploy key is ever offered, never an agent's key or a default identity.
SSH_OPTS=(-i ~/.ssh/vultr_ring_deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10)
S=("$SSH_BIN" "${SSH_OPTS[@]}" "$H")
APP=http://127.0.0.1:8080

die() { printf 'ring.sh: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '8,40p' "$0" | sed 's/^# \{0,1\}//'; }
if [ -n "${RING_SSH:-}" ] && [ ! -x "$RING_SSH" ]; then die "RING_SSH is set but is not an executable file: $RING_SSH"; fi
if [ "${RING_TEST:-}" = 1 ]; then
  [ "$HOST_ADDR" != "$REAL_HOST" ] || die "RING_TEST=1, but the host is the real VM: set RING_HOST"
  case "$(command -v -- "$SSH_BIN" || true)" in
    '' | /usr/bin/* | /bin/* | /usr/local/bin/*) die "RING_TEST=1, but '$SSH_BIN' is not a test stand-in: set RING_SSH" ;;
  esac
fi
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
      console.log(`id: ${r.id}\nposition: ${r.position}\nownerLink: ${r.ownerLink}\n(the owner link is for the owner only: it opens the run as its owner. Approving also needs the approval passphrase when the server has one, and is refused on this admin channel)`);
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
    if [ "$#" -ge 1 ]; then
      need_json "$1"
      # D-5: opening public runs spends tokens for anyone, so it takes a second, deliberate step, one
      # switch at a time: RING_ALLOW_PUBLIC=sample may open the sample's runs, github the GitHub runs,
      # and yes both (deploy.sh reads it the same way). Closing them (false) never needs it. The old
      # switch publicRuns opened both kinds, so a value other than false needs yes.
      allow=${RING_ALLOW_PUBLIC:-}
      opens=$(node -e 'const p = JSON.parse(process.argv[1]); const o = p !== null && typeof p === "object" && !Array.isArray(p) ? p : {};
        const on = (k) => Object.hasOwn(o, k) && o[k] !== false;
        console.log([on("publicSampleRuns") && "sample", on("publicGithubRuns") && "github", on("publicRuns") && "both"].filter(Boolean).join(" "))' "$1") \
        || die "could not read the patch: $1"
      for kind in $opens; do
        case "$kind:$allow" in
          sample:sample | sample:yes | github:github | github:yes | both:yes) ;;
          sample:*) die "this patch opens public runs of the sample (publicSampleRuns). They stay closed (D-5) unless the owner says so: set RING_ALLOW_PUBLIC=sample (or yes) to send it" ;;
          github:*) die "this patch opens public runs on GitHub repositories (publicGithubRuns). They stay closed (D-5) unless the owner says so: set RING_ALLOW_PUBLIC=github (or yes) to send it" ;;
          *) die "this patch sets the old publicRuns, which opened both kinds of public run: send publicSampleRuns or publicGithubRuns instead (or set RING_ALLOW_PUBLIC=yes)" ;;
        esac
      done
      post /admin/config "$1"
    else
      get /admin/config
    fi ;;
  spend) get /admin/spend ;;
  selftest)
    [[ ${1:-} =~ ^(agent-loop|containment|scenes)$ ]] || die "suite must be agent-loop, containment or scenes"
    # The app answers 200 before the suite starts and reports the outcome in its last line
    # ("selftest <suite>: exit N"), so the exit code comes from that line, not from curl; a stream
    # cut short ends with another line and fails. Before the suite starts, the app may say nothing
    # for as long as running tasks take: keepalives hold an idle connection open and end a dead one
    # within 3 minutes.
    tmp=$(mktemp /tmp/ring-selftest.XXXXXX)
    trap 'rm -f "$tmp"' EXIT
    rc=0
    printf '{"suite":"%s"}' "$1" | "$SSH_BIN" "${SSH_OPTS[@]}" -o ServerAliveInterval=30 -o ServerAliveCountMax=6 "$H" \
      "curl -sSN --fail-with-body -X POST -H 'content-type: application/json' --data-binary @- '$APP/admin/selftest'" | tee "$tmp" || rc=$?
    last=$(grep -v -E '^[[:space:]]*$' "$tmp" | tail -n 1 || true)
    case "$last" in
      "selftest $1: exit 0") exit 0 ;;
      "selftest $1: exit "* | "selftest $1: could not start"*) die "the self-test failed: $last" ;;
      *) die "no final 'selftest $1: exit N' line came back (curl/ssh exit $rc)" ;;
    esac ;;
  logs) "${S[@]}" 'sudo journalctl -u mantis-ring -n 300 --no-pager' ;;
  mem)
    # The script travels on stdin and runs in the VM's sh as deploy; only checked digits reach the
    # remote command line. deploy is outside the docker group, so it reads the cgroups, not docker stats.
    secs=${1:-0}
    { [[ $secs =~ ^[0-9]{1,3}$ ]] && [ "$secs" -le 600 ]; } || die "usage: ring.sh mem [seconds, 0 to 600]"
    "${S[@]}" "sh -s $secs" < "$(dirname -- "$0")/vm-mem.sh" ;;
  tts)
    { [ "$#" -ge 3 ] && [ "$#" -le 5 ]; } || die "usage: ring.sh tts <model> <text-file> <out-file> [voice|- [speed]]"
    model=$1 textfile=$2 out=$3 voice=${4:-} speed=${5:-}
    if [ "$voice" = - ]; then voice=; fi
    [[ $model =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$ ]] || die "not a model id: $model"
    [ -z "$voice" ] || [[ $voice =~ ^[a-z][a-z0-9_]{0,39}$ ]] || die "not a voice name: $voice"
    # The app takes a speed from 0.5 to 2 (a JSON number); anything else stops here, before ssh.
    [ -z "$speed" ] || { [[ $speed =~ ^[0-9](\.[0-9]{1,3})?$ ]] && awk -v s="$speed" 'BEGIN { exit !(s >= 0.5 && s <= 2) }'; } \
      || die "speed must be a number from 0.5 to 2: $speed"
    { [ -f "$textfile" ] && [ -r "$textfile" ]; } || die "cannot read the text file: $textfile"
    fmt=${out##*.}
    case "$fmt" in
      mp3 | wav | flac | opus) ;;
      *) die "the out file must end in .mp3, .wav, .flac or .opus: $out" ;;
    esac
    [ -d "$(dirname -- "$out")" ] || die "no such folder for the out file: $(dirname -- "$out")"
    # The body, as JSON on stdin: the text with its white space folded into single spaces.
    body=$(node -e 'const fs = require("node:fs");
      const [model, file, format, voice, speed] = process.argv.slice(1);
      if (fs.statSync(file).size > 16384) { console.error("the text file is larger than 16 KB"); process.exit(1); }
      const input = fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\s+/g, " ").trim();
      const b = { model, input, format, language: "English" };
      if (voice) b.voice = voice;
      if (speed) b.speed = Number(speed);
      process.stdout.write(JSON.stringify(b));' "$model" "$textfile" "$fmt" "$voice" "$speed") || die "could not read the text file: $textfile"
    # The audio arrives on stdout, the response headers (what it cost) on stderr.
    hdr=$(mktemp /tmp/ring-tts.XXXXXX)
    part="$out.part"
    trap 'rm -f "$hdr" "$part"' EXIT
    rc=0
    printf '%s' "$body" | "${S[@]}" "curl -sS --fail-with-body -D /dev/stderr -X POST -H 'content-type: application/json' --data-binary @- '$APP/admin/speech'" > "$part" 2> "$hdr" || rc=$?
    if [ "$rc" != 0 ]; then
      # The app's refusal is one JSON sentence; curl and ssh say theirs on stderr, next to the
      # response headers, whose lines end in CR LF and are left out.
      { head -c 2000 -- "$part"; echo; grep -v -E $'(\r$|^$)' "$hdr" || true; } >&2
      die "no audio came back (exit $rc)"
    fi
    mv -f -- "$part" "$out"
    field() { grep -i -m 1 "^$1:" "$hdr" | cut -d: -f2- | tr -d '\r' | sed 's/^ *//' || true; }
    printf 'wrote %s (%s bytes): %s, voice %s%s, %s characters, %s s of audio billed, $%s (%s); speech today $%s\n' \
      "$out" "$(wc -c < "$out" | tr -d ' ')" "$(field x-ring-speech-model)" "$(field x-ring-speech-voice)" "${speed:+, speed $speed}" "$(field x-ring-speech-chars)" \
      "$(field x-ring-speech-seconds)" "$(field x-ring-speech-usd)" "$(field x-ring-speech-usd-from)" "$(field x-ring-speech-today-usd)" ;;
  '' | -h | --help | help) usage ;;
  *) usage >&2; exit 64 ;;
esac
