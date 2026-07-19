#!/usr/bin/env bash
# Verify that a one-shot tmux client's cwd reaches newly created panes.
set -euo pipefail

export TMUX=''
# shellcheck disable=SC1091 # The shared harness is resolved relative to this probe.
source "$(dirname "$0")/../lib.sh"

A="60_cwd_hatch.txt"
pd_reset_artifact "$A"

sock="$(pd_server cwd)"
d='/tmp/pd spike #[weird] \back dir'
operational_failures=0

cleanup() {
  rm -rf "$d"
  TMUX='' pd_kill_server "$sock"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

record_operational_error() { # $1=label, remaining args=error text
  local label="$1"
  shift
  pd_record "$A" "ERROR: $label: $*"
  operational_failures=$((operational_failures + 1))
}

read_pane_cwd() { # $1=pane id
  TMUX='' "$TMUX_BIN" -L "$sock" display-message -p -t "$1" '#{pane_current_path}'
}

mkdir -p "$d"
# tmux reports the physical cwd on macOS (/private/tmp rather than /tmp), so
# normalize the expected value without changing the hostile path components.
d="$(cd "$d" && pwd -P)"
TMUX='' pd_new_server "$sock"

# The creation commands deliberately omit -c. Their one-shot clients run with
# the target cwd, so tmux can propagate that cwd to the spawned pane.
if ! pane_id="$(cd "$d" && TMUX='' "$TMUX_BIN" -L "$sock" new-window -d -t base -P -F '#{pane_id}' 2>&1)"; then
  record_operational_error 'new-window creation failed' "$pane_id"
elif ! got="$(read_pane_cwd "$pane_id" 2>&1)"; then
  record_operational_error 'new-window cwd readback failed' "$got"
elif [[ "$got" == "$d" ]]; then
  pd_record "$A" 'new-window: HATCH_WORKS'
else
  pd_record "$A" "new-window: HATCH_FAILED got=[$got]"
fi

if ! pane_id="$(cd "$d" && TMUX='' "$TMUX_BIN" -L "$sock" split-window -d -t base:0 -P -F '#{pane_id}' 2>&1)"; then
  record_operational_error 'split-window creation failed' "$pane_id"
elif ! got="$(read_pane_cwd "$pane_id" 2>&1)"; then
  record_operational_error 'split-window cwd readback failed' "$got"
elif [[ "$got" == "$d" ]]; then
  pd_record "$A" 'split-window: HATCH_WORKS'
else
  pd_record "$A" "split-window: HATCH_FAILED got=[$got]"
fi

if ! pane_id="$(cd "$d" && TMUX='' "$TMUX_BIN" -L "$sock" new-session -d -s hatch -P -F '#{pane_id}' 2>&1)"; then
  record_operational_error 'new-session creation failed' "$pane_id"
elif ! got="$(read_pane_cwd "$pane_id" 2>&1)"; then
  record_operational_error 'new-session cwd readback failed' "$got"
elif [[ "$got" == "$d" ]]; then
  pd_record "$A" 'new-session: HATCH_WORKS'
else
  pd_record "$A" "new-session: HATCH_FAILED got=[$got]"
fi

# Control: passing the same hostile path with -c exercises the format-expanded
# route that this hatch intentionally avoids.
if ! control_id="$(TMUX='' "$TMUX_BIN" -L "$sock" new-window -d -t base -c "$d" -P -F '#{pane_id}' 2>&1)"; then
  pd_record "$A" "CONTROL new-window -c: REJECTED error=[$control_id]"
elif ! control_got="$(read_pane_cwd "$control_id" 2>&1)"; then
  record_operational_error 'CONTROL new-window -c cwd readback failed' "$control_got"
elif [[ "$control_got" == "$d" ]]; then
  pd_record "$A" "CONTROL new-window -c: UNEXPECTED_ROUNDTRIP got=[$control_got]"
else
  pd_record "$A" "CONTROL new-window -c: MANGLED got=[$control_got]"
fi

if grep -q 'HATCH_FAILED' "$(pd_artifact "$A")"; then
  exit 1
fi
(( operational_failures == 0 ))
