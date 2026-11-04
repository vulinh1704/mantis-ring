#!/bin/sh
# The VM's memory, read-only. scripts/ring.sh mem sends this file to the VM's sh over SSH as deploy,
# who is outside the docker group: so it reads the cgroups that docker stats reads, not docker itself.
# Usage: sh vm-mem.sh [seconds]
# - With seconds, MemAvailable (/proc/meminfo) is read once a second for that long, with what all the
#   containers' cgroups hold together, and the lowest and the highest are printed with their times.
# - Then free -m, and one line per cgroup: every container (a sandbox's limit is LIMITS.memory in
#   runner/sandbox.mjs, the proxy's 128 MB) and the services of the app, Caddy, Docker and containerd:
#   what it holds now, the most it held since it started (memory.peak) and its limit (memory.max).
# Nothing here writes anywhere.
secs=${1:-0}
case "$secs" in '' | *[!0-9]*) echo "vm-mem: the seconds must be a whole number" >&2; exit 64 ;; esac
cg=/sys/fs/cgroup/system.slice

mib() { awk -v b="$1" 'BEGIN { if (b == "max") print "no limit"; else if (b ~ /^[0-9]+$/) printf "%d MB", b / 1048576; else print "?" }'; }
value() { cat "$1" 2> /dev/null || printf '?'; }
# What all the containers' cgroups hold now, in bytes.
held() {
  total=0
  for d in "$cg"/docker-*.scope; do
    [ -r "$d/memory.current" ] || continue
    n=$(cat "$d/memory.current" 2> /dev/null) || continue
    case "$n" in '' | *[!0-9]*) continue ;; esac
    total=$((total + n))
  done
  echo "$total"
}

if [ "$secs" -gt 0 ]; then
  low='' low_at='' high=0 high_at=''
  i=0
  while [ "$i" -lt "$secs" ]; do
    avail=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
    now=$(date -u +%H:%M:%S)
    h=$(held)
    if [ -z "$low" ] || [ "$avail" -lt "$low" ]; then low=$avail low_at=$now; fi
    if [ "$h" -gt "$high" ]; then high=$h high_at=$now; fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$high" -gt 0 ]; then together="at most $(mib "$high") (at $high_at UTC)"; else together='no container seen'; fi
  echo "over $secs s: MemAvailable at least $low MB (at $low_at UTC); all containers together: $together"
fi

echo "$(date -u '+%Y-%m-%d %H:%M:%S') UTC"
free -m
echo
printf '%-26s %10s %10s %10s\n' cgroup now peak limit
for d in "$cg"/docker-*.scope "$cg"/mantis-ring.service "$cg"/caddy.service "$cg"/docker.service "$cg"/containerd.service; do
  [ -r "$d/memory.current" ] || continue
  name=${d##*/}
  case "$name" in docker-*.scope) name="container $(printf '%.12s' "${name#docker-}")" ;; esac
  printf '%-26s %10s %10s %10s\n' "$name" "$(mib "$(value "$d/memory.current")")" "$(mib "$(value "$d/memory.peak")")" "$(mib "$(value "$d/memory.max")")"
done
