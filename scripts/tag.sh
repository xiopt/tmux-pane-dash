#!/usr/bin/env bash
# scripts/tag.sh — tag/untag/label a pane. Usage:
#   tag.sh toggle <pane_id>
#   tag.sh label  <pane_id> <label>
set -euo pipefail

sanitize() { printf '%s' "$1" | tr '\t\n\r' '   ' | tr -d '\000-\037\177' | cut -c1-80; }

cmd="${1:?usage: tag.sh toggle|label <pane_id> [label]}"
pane="${2:?pane id required}"

case "$cmd" in
  toggle)
    cur="$(tmux show-option -pqv -t "$pane" @pane_dash_tag || true)"
    if [ -n "$cur" ]; then
      tmux set-option -pu -t "$pane" @pane_dash_tag
      tmux display-message "pane-dash: untagged"
    else
      label="$(sanitize "$(tmux display-message -p -t "$pane" '#{pane_current_command}')")"
      tmux set-option -p -t "$pane" @pane_dash_tag "${label:-pane}"
      tmux display-message "pane-dash: tagged as ${label:-pane}"
    fi
    ;;
  label)
    label="$(sanitize "${3:-}")"
    # trim to empty if only spaces
    label="$(printf '%s' "$label" | sed 's/^ *//; s/ *$//')"
    if [ -n "$label" ]; then
      tmux set-option -p -t "$pane" @pane_dash_tag "$label"
      tmux display-message "pane-dash: tagged as $label"
    else
      tmux display-message "pane-dash: empty label, not tagged"
    fi
    ;;
  *) echo "unknown command: $cmd" >&2; exit 1 ;;
esac
