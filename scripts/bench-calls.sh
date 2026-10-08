#!/usr/bin/env bash
# Measures the Nexus desktop app while synthetic participants (LiveKit CLI
# load-test) join the call the app is already in.
#
# Prereqs: Nexus open and joined to a call; LIVEKIT_URL / LIVEKIT_API_KEY /
# LIVEKIT_API_SECRET exported; lk and nexus-bench on PATH (or LK / BENCH vars).
# Usage: scripts/bench-calls.sh <room-name> [process-name]
set -euo pipefail
ROOM="$1"
PROC="${2:-nexus-desktop.exe}"
LK="${LK:-lk}"
BENCH="${BENCH:-nexus-bench}"
OUT="${OUT:-bench-results}"
WARMUP="${WARMUP:-20}"
SAMPLE="${SAMPLE:-60}"
mkdir -p "$OUT"

run() {
  local label="$1"; shift
  echo "== $label"
  "$LK" load-test --room "$ROOM" --duration "$((WARMUP + SAMPLE + 10))s" "$@" >"$OUT/lk-$label.log" 2>&1 &
  local lk_pid=$!
  sleep "$WARMUP"
  "$BENCH" measure --process "$PROC" --duration "$SAMPLE" --label "$label" --csv "$OUT/$label.csv"
  # A result only counts if the app was still in the call the whole time.
  if [ -n "${EXPECT_IDENTITY:-}" ] && ! "$LK" room participants list "$ROOM" 2>/dev/null | grep -q "$EXPECT_IDENTITY"; then
    echo "INVALID: $EXPECT_IDENTITY is no longer in $ROOM; discard $label"
  fi
  wait "$lk_pid" || true
  sleep 5
}

run call-2-voice --audio-publishers 1
run call-5-voice --audio-publishers 4
run call-10-voice --audio-publishers 9
run call-2-video --audio-publishers 1 --video-publishers 1 --video-resolution high
run call-5-video --audio-publishers 4 --video-publishers 4 --video-resolution medium
