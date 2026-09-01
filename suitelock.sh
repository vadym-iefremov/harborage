#!/bin/bash
# Serialises anything that spawns browsers or a daemon, and reaps it by exact PID.
#
# Why this exists: several agents share one laptop, and it has overheated twice
# from concurrent Chromium fleets. Two guarantees, both of which matter:
#
#   1. Only one holder at a time, machine-wide. The lock is a directory, because
#      mkdir is atomic on every filesystem here and macOS has no flock(1).
#   2. The child is killed by PID, never by name pattern. A `pkill -f` would
#      reach other agents' processes, which is precisely the accident this file
#      is meant to prevent.
#
# Usage:  ./suitelock.sh <command> [args...]
#         ./suitelock.sh npm test
# Env:    SUITELOCK_TIMEOUT  seconds to wait for the lock (default 1800)
#         SUITELOCK_DIR      lock location (default /tmp/harborage-suitelock)

set -uo pipefail

LOCK="${SUITELOCK_DIR:-/tmp/harborage-suitelock}"
WAIT="${SUITELOCK_TIMEOUT:-1800}"

if [ "$#" -eq 0 ]; then
  echo "suitelock: nothing to run. Usage: ./suitelock.sh <command> [args...]" >&2
  exit 64
fi

waited=0
until mkdir "$LOCK" 2>/dev/null; do
  # A holder that died without cleaning up would block everyone forever, so the
  # recorded PID is checked rather than trusted. kill -0 tests for existence
  # only; it sends no signal.
  if [ -f "$LOCK/pid" ] && ! kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    echo "suitelock: clearing a stale lock from pid $(cat "$LOCK/pid" 2>/dev/null)" >&2
    rm -rf "$LOCK"
    continue
  fi
  if [ "$waited" -ge "$WAIT" ]; then
    echo "suitelock: gave up after ${WAIT}s waiting for $(cat "$LOCK/owner" 2>/dev/null || echo 'another run')" >&2
    exit 75
  fi
  [ "$((waited % 30))" -eq 0 ] && echo "suitelock: waiting for $(cat "$LOCK/owner" 2>/dev/null || echo 'another run') (${waited}s)" >&2
  sleep 2
  waited=$((waited + 2))
done

echo $$ > "$LOCK/pid"
echo "$*" > "$LOCK/owner"

child=""

# Descendants are collected by walking PPID links from the known child PID, so
# every kill below targets a PID this script actually started. pgrep -P takes a
# parent PID, not a pattern.
descendants() {
  local parent="$1" kid
  for kid in $(pgrep -P "$parent" 2>/dev/null); do
    descendants "$kid"
    echo "$kid"
  done
}

cleanup() {
  local status=$?
  if [ -n "$child" ]; then
    local pids
    pids="$(descendants "$child") $child"
    for pid in $pids; do kill -TERM "$pid" 2>/dev/null; done
    # Give them a moment to exit on their own before insisting.
    local tries=0
    while [ "$tries" -lt 10 ]; do
      local alive=0
      for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive=1; done
      [ "$alive" -eq 0 ] && break
      sleep 0.5
      tries=$((tries + 1))
    done
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then
        echo "suitelock: pid $pid ignored SIGTERM, sending SIGKILL" >&2
        kill -KILL "$pid" 2>/dev/null
      fi
    done
    # Verified by PID, so "reaped" is a fact rather than an assumption.
    for pid in $pids; do
      kill -0 "$pid" 2>/dev/null && echo "suitelock: WARNING pid $pid survived" >&2
    done
  fi
  rm -rf "$LOCK"
  exit "$status"
}
trap cleanup EXIT INT TERM

"$@" &
child=$!
wait "$child"
