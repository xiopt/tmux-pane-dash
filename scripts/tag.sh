#!/usr/bin/env bash
# scripts/tag.sh — tag/untag/label a pane. Usage:
#   tag.sh toggle <pane_id>
#   tag.sh label  <pane_id> <label>
#   tag.sh label-from-option <pane_id>
set -euo pipefail

sanitize() { printf '%s' "$1" | tr '\t\n\r' '   ' | tr -d '\000-\037\177' | cut -c1-80; }
escape_format() { printf '%s' "$1" | sed 's/#/##/g'; }

set_label() {
  local label
  label="$(sanitize "$1")"
  # trim to empty if only spaces
  label="$(printf '%s' "$label" | sed 's/^ *//; s/ *$//')"
  if [ -n "$label" ]; then
    tmux set-option -p -t "$pane" @pane_dash_tag "$label"
    tmux display-message "pane-dash: tagged as $(escape_format "$label")"
  else
    tmux display-message "pane-dash: empty label, not tagged"
  fi
}

cmd="${1:?usage: tag.sh toggle|label|label-from-option <pane_id> [label]}"
pane="${2:?pane id required}"

case "$cmd" in
  toggle)
    cur="$(tmux show-option -pqv -t "$pane" @pane_dash_tag || true)"
    if [ -n "$cur" ]; then
      tmux set-option -pu -t "$pane" @pane_dash_tag
      tmux display-message "pane-dash: untagged"
    else
      label="$(sanitize "$(tmux display-message -p -t "$pane" '#{pane_current_command}')")"
      tag="${label:-pane}"
      tmux set-option -p -t "$pane" @pane_dash_tag "$tag"
      tmux display-message "pane-dash: tagged as $(escape_format "$tag")"
    fi
    ;;
  label)
    set_label "${3:-}"
    ;;
  label-from-option)
    label="$(tmux show-option -pqv -t "$pane" @pane_dash_label_input || true)"
    tmux set-option -pu -t "$pane" @pane_dash_label_input
    set_label "$label"
    ;;
  *) echo "unknown command: $cmd" >&2; exit 1 ;;
esac
