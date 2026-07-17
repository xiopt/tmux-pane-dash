#!/usr/bin/env bash
# tests/pane_dash_integration.sh — real-tmux safety checks for label binding.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCK="pd-label-$$"
MARKER="/tmp/pd-$$"

cleanup() {
  TMUX='' tmux -L "$SOCK" kill-server 2>/dev/null || true
  rm -f "$MARKER"
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

assert_label() {
  local label="$1" pane tag pending client_pid

  TMUX='' tmux -L "$SOCK" -f /dev/null new-session -d -s t
  pane="$(TMUX='' tmux -L "$SOCK" display-message -p -t t '#{pane_id}')"
  TMUX='' tmux -L "$SOCK" run-shell "$ROOT/pane_dash.tmux"

  { printf '\002'; sleep 0.2; printf 'M'; sleep 0.3; printf '%s\r' "$label"; sleep 2; } |
    TMUX='' script -q /dev/null tmux -L "$SOCK" attach-session -t t >/dev/null 2>&1 &
  client_pid=$!
  sleep 1

  tag="$(TMUX='' tmux -L "$SOCK" display-message -p -t "$pane" '#{@pane_dash_tag}')"
  pending="$(TMUX='' tmux -L "$SOCK" display-message -p -t "$pane" '#{@pane_dash_label_input}')"
  kill "$client_pid" 2>/dev/null || true
  wait "$client_pid" 2>/dev/null || true
  TMUX='' tmux -L "$SOCK" kill-server

  [ "$tag" = "$label" ] || fail "label stored incorrectly: $label"
  [ -z "$pending" ] || fail "label input option was not cleared"
  [ ! -e "$MARKER" ] || fail "hostile label executed a shell command"
  echo "ok: $label"
}

assert_label "it's a label"
assert_label 'a "double quote" label'
assert_label "; echo pwned > $MARKER"
assert_label '#{pane_id}'
