#!/usr/bin/env bash
# pane_dash.tmux — TPM entry point. Binds dashboard + tag keys.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

get_opt() { local value; value="$(tmux show-option -gqv "$1" || true)"; printf '%s' "${value:-$2}"; }

# Quote paths baked into run-shell commands. Task 10 copies the release binary
# to bin/pane-dash so this plugin-local location wins over PATH.
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

dash_key="$(get_opt @pane-dash-key D)"
tag_key="$(get_opt @pane-dash-tag-key T)"
label_key="$(get_opt @pane-dash-label-key M)"
engine="$(get_opt @pane-dash-engine fzf)"

if [ "$engine" = rust ]; then
  binary="$DIR/bin/pane-dash"
  if [ ! -x "$binary" ]; then
    candidate="$(command -v pane-dash || true)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      case "$candidate" in
        /*) binary="$candidate" ;;
        *) binary="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")" ;;
      esac
    else
      binary=""
    fi
  fi

  if [ -n "$binary" ]; then
    tmux bind-key "$dash_key" run-shell \
      "$(shell_quote "$DIR/scripts/open_v2.sh") $(shell_quote "$binary") '#{client_tty}' '#{session_id}' '#{pane_id}'"
  else
    tmux display-message "pane-dash: rust engine selected but pane-dash binary not found; using fzf"
    tmux bind-key "$dash_key" run-shell "$(shell_quote "$DIR/scripts/dash.sh") '#{client_tty}' '#{pane_id}'"
  fi
else
  tmux bind-key "$dash_key" run-shell "$(shell_quote "$DIR/scripts/dash.sh") '#{client_tty}' '#{pane_id}'"
fi
tmux bind-key "$tag_key" run-shell "\"$DIR/scripts/tag.sh\" toggle '#{pane_id}'"
tmux bind-key "$label_key" command-prompt -p 'pane-dash label:' \
  "set-option -p @pane_dash_label_input \"%%%\" ; run-shell '\"$DIR/scripts/tag.sh\" label-from-option \"#{pane_id}\"'"
