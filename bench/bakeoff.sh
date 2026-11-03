#!/usr/bin/env bash
# T3 bake-off (BUILD-SPEC §6.5): the same Lumen task for each model, <runs> runs each, two tasks at a
# time with a different model in each pair (glm-5.3 allows only 30 requests/min), then each task's
# bundle under <out>/<model>-<n>/ and RESULTS.md from bench/table.mjs. Same settings for every model:
# default 16-cell matrix, gate on, vision off, default caps except maxUsd 1.50, seed 7, reasoning low,
# and the per-model sampling the app applies from its config (§4.9).
# Every call goes through scripts/ring.sh (local admin over SSH), so nothing here holds a key. Only
# task ids are kept: owner links and tokens are never printed or stored (admin calls cannot approve).
# Usage: bench/bakeoff.sh [--models a,b,c] [--runs 2] [--out bench/<date>-bakeoff] [--dry-run]
#   RING_SH and BAKEOFF_POLL_SEC replace scripts/ring.sh and the 15 s poll (for testing this script).
set -euo pipefail
cd "$(dirname "$0")/.."

models="deepseek-v4.1-flash-1017,minimax-m3.1-flash,glm-5.3"
runs=2
day="$(TZ=Asia/Ho_Chi_Minh date +%F)"   # the spec names bench files by the ICT date
out="bench/${day}-bakeoff"
dry=0
poll="${BAKEOFF_POLL_SEC:-15}"          # seconds between status reads
max_wait=$((40 * 60))                   # per task: its own wall clock is 15 min, plus the queue

usage() { echo "usage: bench/bakeoff.sh [--models a,b,c] [--runs 1-5] [--out <dir>] [--dry-run]"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --models) models="${2:?--models needs a list}"; shift 2 ;;
    --runs) runs="${2:?--runs needs a number}"; shift 2 ;;
    --out) out="${2:?--out needs a folder}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "bakeoff: unknown option $1" >&2; usage >&2; exit 64 ;;
  esac
done

[[ "$runs" =~ ^[1-5]$ ]] || { echo "bakeoff: --runs must be 1 to 5" >&2; exit 64; }
[[ "$poll" =~ ^[1-9][0-9]*$ ]] || { echo "bakeoff: BAKEOFF_POLL_SEC must be a positive whole number" >&2; exit 64; }
IFS=',' read -r -a model_list <<< "$models"
[ "${#model_list[@]}" -ge 1 ] || { echo "bakeoff: no models given" >&2; exit 64; }
for m in "${model_list[@]}"; do
  # The id goes into a JSON string and a folder name: only the characters a model id may have (app/config.mjs).
  [[ "$m" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$ ]] || { echo "bakeoff: not a model id: $m" >&2; exit 64; }
done
label="bakeoff-${day}"
ring="${RING_SH:-scripts/ring.sh}"
if [ "$dry" = 0 ] && [ ! -x "$ring" ]; then echo "bakeoff: $ring is missing or not executable" >&2; exit 1; fi

# Schedule: run 1 of every model, then run 2 of every model, …; consecutive entries are paired when
# their models differ, so a pair never runs the same model twice at once.
sched_model=(); sched_n=()
for ((n = 1; n <= runs; n++)); do
  for m in "${model_list[@]}"; do sched_model+=("$m"); sched_n+=("$n"); done
done
dir_of() { echo "$out/${1//[\/:]/_}-$2"; }

for ((i = 0; i < ${#sched_model[@]}; i++)); do
  d="$(dir_of "${sched_model[$i]}" "${sched_n[$i]}")"
  if [ -d "$d" ] && [ -n "$(ls -A "$d")" ]; then echo "bakeoff: $d already holds a run; pick another --out" >&2; exit 1; fi
done

body_for() {
  printf '{"sample":"lumen","model":"%s","gate":true,"visionModel":null,"caps":{"maxUsd":1.5},"sampling":{"seed":7},"label":"%s"}' "$1" "$label"
}
now() { date -u +%H:%M:%S; }
hide_owner() { sed -E 's/#owner=[A-Za-z0-9_-]+/#owner=<hidden>/g; s/("ownerToken"[[:space:]]*:[[:space:]]*")[^"]*"/\1<hidden>"/g'; }

# Submit one task; prints its id. The answer carries the owner link, so only the id is taken from it.
submit() {
  local answer id
  if ! answer="$("$ring" run "$(body_for "$1")" 2>&1)"; then
    echo "bakeoff: ring.sh run failed for $1: $(printf '%s' "$answer" | hide_owner | tail -n 3)" >&2
    return 1
  fi
  id="$(printf '%s\n' "$answer" | grep -oE 't_[0-9a-f]{32}' | head -n 1 || true)"
  if [ -z "$id" ]; then
    echo "bakeoff: no task id in the answer for $1: $(printf '%s' "$answer" | hide_owner | tail -n 3)" >&2
    return 1
  fi
  echo "$id"
}

# The task's state from /admin/tasks/<id>, or "unknown" when it cannot be read.
state_of() {
  local answer
  answer="$("$ring" get "$1" 2>/dev/null)" || { echo unknown; return 0; }
  printf '%s' "$answer" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const j = JSON.parse(s); console.log((j.task ?? j).state ?? "unknown"); } catch { console.log("unknown"); }
    });'
}
terminal() { case "$1" in done|failed|timeout|cancelled|interrupted) return 0 ;; *) return 1 ;; esac; }

running_ids=()
on_interrupt() {
  echo >&2
  if [ "${#running_ids[@]}" -gt 0 ]; then
    echo "bakeoff: stopped; these tasks may still be running on the VM: ${running_ids[*]}" >&2
    echo "bakeoff: cancel one with POST /admin/tasks/<id>/cancel (local admin), or let it finish and bundle it later" >&2
  fi
  exit 130
}
trap on_interrupt INT TERM

# Run one pair (or a single entry): submit, wait for both to end, bundle each.
run_group() {
  local idx ids=() i id state waited d
  for idx in "$@"; do
    if [ "$dry" = 1 ]; then
      echo "  would submit: $(body_for "${sched_model[$idx]}")  → $(dir_of "${sched_model[$idx]}" "${sched_n[$idx]}")"
      continue
    fi
    if id="$(submit "${sched_model[$idx]}")"; then
      ids+=("$id"); running_ids+=("$id")
      echo "[$(now)] submitted ${sched_model[$idx]} run ${sched_n[$idx]}: $id"
      printf '%s %s %s\n' "${sched_model[$idx]}" "${sched_n[$idx]}" "$id" >> "$out/ids.txt"
    else
      ids+=("")
    fi
  done
  [ "$dry" = 1 ] && return 0

  i=0
  for idx in "$@"; do
    id="${ids[$i]}"; i=$((i + 1))
    [ -n "$id" ] || continue
    waited=0
    state="$(state_of "$id")"
    while ! terminal "$state" && [ "$waited" -lt "$max_wait" ]; do
      sleep "$poll"; waited=$((waited + poll))
      state="$(state_of "$id")"
    done
    terminal "$state" || echo "bakeoff: $id still '$state' after $((max_wait / 60)) min; bundling what is there" >&2
    d="$(dir_of "${sched_model[$idx]}" "${sched_n[$idx]}")"
    mkdir -p "$d"
    if "$ring" bundle "$id" "$d"; then
      echo "[$(now)] ${sched_model[$idx]} run ${sched_n[$idx]}: $state, bundle in $d"
    else
      echo "bakeoff: could not bundle $id into $d" >&2
    fi
  done
  running_ids=()
}

total=${#sched_model[@]}
echo "bakeoff: ${#model_list[@]} model(s) × $runs run(s) = $total tasks, label $label, into $out$([ "$dry" = 1 ] && echo ' (dry run)')"
[ "$dry" = 1 ] || mkdir -p "$out"
i=0; group=0
while [ "$i" -lt "$total" ]; do
  group=$((group + 1))
  if [ $((i + 1)) -lt "$total" ] && [ "${sched_model[$i]}" != "${sched_model[$((i + 1))]}" ]; then
    echo "[$(now)] pair $group: ${sched_model[$i]} run ${sched_n[$i]} + ${sched_model[$((i + 1))]} run ${sched_n[$((i + 1))]}"
    run_group "$i" "$((i + 1))"
    i=$((i + 2))
  else
    echo "[$(now)] alone $group: ${sched_model[$i]} run ${sched_n[$i]}"
    run_group "$i"
    i=$((i + 1))
  fi
done

if [ "$dry" = 1 ]; then echo "bakeoff: dry run, nothing submitted"; exit 0; fi
node bench/table.mjs "$out"
for f in "$out"/*/; do
  [ -f "$f/r0.report.json" ] && node bench/grade-lumen.mjs --dir "$f" --out "$f/grade.json" > /dev/null || true
done
echo "bakeoff: done; results in $out/RESULTS.md"
