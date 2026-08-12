#!/usr/bin/env bash
# scripts/open.sh [--notification-list] <resolved-binary> <client-tty> <session-id> <pane-id>
set -euo pipefail

mode=dashboard
if [[ "${1:-}" == --notification-list ]]; then
  mode=notification-list
  shift
fi

binary="${1:?resolved binary required}"
client_tty="${2:?client tty required}"
session_id="${3:?session id required}"
pane_id="${4:?pane id required}"

get_opt() {
  local value
  value="$(tmux show-options -gqv "$1" || true)"
  printf '%s' "${value:-$2}"
}

w="$(get_opt @pane-dash-width 90%)"
h="$(get_opt @pane-dash-height 85%)"

tmux set-option -g "@pane_dash_focus_${client_tty}" 1
if [[ "$mode" == notification-list ]]; then
  tmux display-popup -E -c "$client_tty" -t "$pane_id" -w "$w" -h "$h" \
    "$binary" --notification-list "$client_tty" "$session_id" "$pane_id"
else
  tmux display-popup -E -c "$client_tty" -t "$pane_id" -w "$w" -h "$h" \
    "$binary" "$client_tty" "$session_id" "$pane_id"
fi
