#!/usr/bin/env bash
# pane_dash.tmux — TPM entry point. Binds dashboard + tag keys.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

get_opt() { local value; value="$(tmux show-option -gqv "$1" || true)"; printf '%s' "${value:-$2}"; }

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

has_focus_hook() {
  local hooks
  hooks="$(tmux show-hooks -g "$1" 2>/dev/null)"
  case "$hooks" in
    *'@pane_dash_focus_#{hook_client}'*) return 0 ;;
    *) return 1 ;;
  esac
}

install_focus_hook() {
  if ! has_focus_hook "$1"; then
    tmux set-hook -ag "$1" "$2"
  fi
}

has_focus_terminal_feature() {
  local terminal_features feature
  terminal_features="$(tmux show-options -sv terminal-features 2>/dev/null)"
  while IFS= read -r feature || [ -n "$feature" ]; do
    [ "$feature" = '*:focus' ] && return 0
  done <<EOF
$terminal_features
EOF
  return 1
}

dash_key="$(get_opt @pane-dash-key D)"
tag_key="$(get_opt @pane-dash-tag-key T)"
label_key="$(get_opt @pane-dash-label-key M)"

install_focus_hook client-focus-in 'set-option -gF "@pane_dash_focus_#{hook_client}" "1"'
install_focus_hook client-focus-out 'set-option -gF "@pane_dash_focus_#{hook_client}" "0"'

tmux set-option -g focus-events on
if ! has_focus_terminal_feature; then
  tmux set-option -sa terminal-features '*:focus'
fi

binary="$DIR/bin/pane-dash"
if [ -f "$binary" ] && [ -x "$binary" ]; then
  tmux bind-key "$dash_key" run-shell \
    "$(shell_quote "$DIR/scripts/open.sh") $(shell_quote "$binary") '#{client_tty}' '#{session_id}' '#{pane_id}'"
else
  tmux display-message "pane-dash: Rust binary unavailable; run 'make build' in the tmux-pane-dash directory"
fi
tmux bind-key "$tag_key" run-shell "\"$DIR/scripts/tag.sh\" toggle '#{pane_id}'"
tmux bind-key "$label_key" command-prompt -p 'pane-dash label:' \
  "set-option -p @pane_dash_label_input \"%%%\" ; run-shell '\"$DIR/scripts/tag.sh\" label-from-option \"#{pane_id}\"'"
