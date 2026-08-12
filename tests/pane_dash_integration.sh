#!/usr/bin/env bash
# tests/pane_dash_integration.sh — real-tmux safety checks for label binding.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091 # Local helper contains definitions only.
source "$ROOT/tests/pane_dash_pty.sh"
SOCK=""
CASE=0
MARKER="/tmp/pd-$$"
tmux_bin_candidate="${TMUX_BIN:-tmux}"
tmux_bin="$(command -v "$tmux_bin_candidate")"
tmux_dir="$(dirname "$tmux_bin")"
export PATH="$tmux_dir:$PATH"

cleanup() {
  TMUX='' "$tmux_bin" -L "$SOCK" kill-server 2>/dev/null || true
  rm -f "$MARKER"
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

assert_label() {
  local label="$1" pane tag pending client_pid

  CASE=$((CASE + 1))
  SOCK="pd-label-$$-$CASE"

  TMUX='' "$tmux_bin" -L "$SOCK" -f /dev/null new-session -d -s t
  pane="$(TMUX='' "$tmux_bin" -L "$SOCK" display-message -p -t t '#{pane_id}')"
  TMUX='' "$tmux_bin" -L "$SOCK" run-shell "$ROOT/pane_dash.tmux"

  { printf '\002'; sleep 0.2; printf 'M'; sleep 0.3; printf '%s\r' "$label"; sleep 2; } |
    TMUX='' pane_dash_run_in_pty "$tmux_bin" -L "$SOCK" attach-session -t t >/dev/null 2>&1 &
  client_pid=$!
  sleep 1

  tag="$(TMUX='' "$tmux_bin" -L "$SOCK" display-message -p -t "$pane" '#{@pane_dash_tag}')"
  pending="$(TMUX='' "$tmux_bin" -L "$SOCK" display-message -p -t "$pane" '#{@pane_dash_label_input}')"
  kill "$client_pid" 2>/dev/null || true
  wait "$client_pid" 2>/dev/null || true
  TMUX='' "$tmux_bin" -L "$SOCK" kill-server

  [ "$tag" = "$label" ] || fail "label stored incorrectly: $label"
  [ -z "$pending" ] || fail "label input option was not cleared"
  [ ! -e "$MARKER" ] || fail "hostile label executed a shell command"
  echo "ok: $label"
}

assert_label "it's a label"
assert_label 'a "double quote" label'
assert_label "; echo pwned > $MARKER"
assert_label '#{pane_id}'
