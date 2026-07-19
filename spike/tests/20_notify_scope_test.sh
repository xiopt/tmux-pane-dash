#!/usr/bin/env bash
# Integration test for the notification-scope probe's recorded matrix.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
tmux_bin="${TMUX_BIN:-tmux}"
version="$(TMUX='' "$tmux_bin" -V | tr ' ' '_')"
artifact="$root/spike/results/$version/20_notify_scope.txt"
raw="$root/spike/results/$version/20_notify_scope_raw.txt"

bash "$root/spike/probes/20_notify_scope.sh"

grep -q '^MARKER:1:split-window in ATTACHED session$' "$artifact"
grep -q '^FINDING: 8 set a pane option in OTHER (status write) -> (none)$' "$artifact"
grep -q '^FINDING: 13 set a pane option in ATTACHED session (status write) -> (none)$' "$artifact"
grep -q '^FINDING: 1 split-window in ATTACHED session -> %' "$artifact"
awk '/^--- token summary ---$/ { summary = 1 } summary && /SYNC:/ { exit 1 }' "$artifact"
awk '
  /^%begin / { begin_ts = $2; begin_id = $3; sync = 0; next }
  /^SYNC:[0-9]+$/ { sync = substr($0, 6); next }
  /^%end / {
    if ($2 == begin_ts && $3 == begin_id && sync) complete[sync] = 1
    next
  }
  /^MARKER:[0-9]+:/ {
    split($0, marker, ":")
    if (marker[2] != 0 && !complete[marker[2]]) exit 1
  }
' "$raw"
