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
engine_line="$(tmux show-option -gq @pane-dash-engine || true)"

install_focus_hook client-focus-in 'set-option -gF "@pane_dash_focus_#{hook_client}" "1"'
install_focus_hook client-focus-out 'set-option -gF "@pane_dash_focus_#{hook_client}" "0"'

tmux set-option -g focus-events on
if ! has_focus_terminal_feature; then
  tmux set-option -sa terminal-features '*:focus'
fi

case "$engine_line" in
  '@pane-dash-engine fzf')
    tmux display-message 'pane-dash: @pane-dash-engine fzf is deprecated; supported through v2.x, removed no earlier than v3.0'
    tmux bind-key "$dash_key" run-shell "$(shell_quote "$DIR/scripts/dash.sh") '#{client_tty}' '#{pane_id}'"
    ;;
  '' | '@pane-dash-engine rust') engine_warning="" ;;
  *) engine_warning='pane-dash: invalid @pane-dash-engine value; using Rust-first resolution' ;;
esac

if [ "$engine_line" != '@pane-dash-engine fzf' ]; then
  [ -z "${engine_warning:-}" ] || tmux display-message "$engine_warning"
  binary="$DIR/bin/pane-dash"
  if [ ! -f "$binary" ] || [ ! -x "$binary" ]; then
    binary=""
    candidate="$(type -P pane-dash || true)"
    if [ -n "$candidate" ] && [ -f "$candidate" ] && [ -x "$candidate" ]; then
      binary="$(cd "$(dirname "$candidate")" && pwd -P)/$(basename "$candidate")"
    fi
  fi

  if [ -n "$binary" ]; then
    tmux bind-key "$dash_key" run-shell \
      "$(shell_quote "$DIR/scripts/open.sh") $(shell_quote "$binary") '#{client_tty}' '#{session_id}' '#{pane_id}'"
  else
    tmux display-message "pane-dash: Rust binary not found; using legacy fzf (run 'make build' in the plugin directory or 'make install')"
    tmux bind-key "$dash_key" run-shell "$(shell_quote "$DIR/scripts/dash.sh") '#{client_tty}' '#{pane_id}'"
  fi
fi
tmux bind-key "$tag_key" run-shell "\"$DIR/scripts/tag.sh\" toggle '#{pane_id}'"
tmux bind-key "$label_key" command-prompt -p 'pane-dash label:' \
  "set-option -p @pane_dash_label_input \"%%%\" ; run-shell '\"$DIR/scripts/tag.sh\" label-from-option \"#{pane_id}\"'"
