#!/usr/bin/env bash
# Integration test for the notification-scope probe's recorded matrix.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
tmux_bin="${TMUX_BIN:-tmux}"
version="$(TMUX='' "$tmux_bin" -V | tr ' ' '_')"
artifact="$root/spike/results/$version/20_notify_scope.txt"

bash "$root/spike/probes/20_notify_scope.sh"

grep -q '^MARKER:1:split-window in ATTACHED session$' "$artifact"
grep -q '^FINDING: 8 set a pane option in OTHER (status write) -> (none)$' "$artifact"
grep -q '^FINDING: 13 set a pane option in ATTACHED session (status write) -> (none)$' "$artifact"
grep -q '^FINDING: 1 split-window in ATTACHED session -> %' "$artifact"
