#!/usr/bin/env bash
# scripts/action.sh <jump|zoom|send> <pane_id> [client_tty]
# All mutating dashboard actions.
set -euo pipefail

cmd="${1:?usage: action.sh jump|zoom|send <pane_id> [client_tty]}"
pane="${2:?pane id required}"
client="${3:-}"

pane_exists() {
  local found
  found="$(tmux display-message -p -t "$pane" '#{pane_id}' 2>/dev/null)" || return 1
  [ "$found" = "$pane" ]
}

jump() {
  # -c pins the originating client; -Z preserves its zoom state.
  if [ -n "$client" ]; then
    tmux switch-client -Z -c "$client" -t "$pane"
  else
    tmux switch-client -Z -t "$pane"
  fi
}

case "$cmd" in
  jump)
    pane_exists || exit 0
    jump
    ;;
  zoom)
    pane_exists || exit 0
    tmux resize-pane -Z -t "$pane"
    jump
    ;;
  send)
    if ! pane_exists; then
      printf 'pane %s is gone\n' "$pane" > /dev/tty
      sleep 1
      exit 0
    fi
    cur="$(tmux display-message -p -t "$pane" '#{pane_current_command}' 2>/dev/null || true)"
    printf '\nsend to %s (running: %s) — empty cancels\n> ' "$pane" "$cur" > /dev/tty
    IFS= read -r line < /dev/tty || exit 0
    [ -n "$line" ] || exit 0
    pane_exists || {
      printf 'pane %s vanished, aborted\n' "$pane" > /dev/tty
      sleep 1
      exit 0
    }
    tmux send-keys -l -t "$pane" -- "$line"
    tmux send-keys -t "$pane" Enter
    ;;
  *)
    echo "unknown action: $cmd" >&2
    exit 1
    ;;
esac
