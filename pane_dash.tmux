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

has_notify_hook() {
  local hooks marker
  hooks="$(tmux show-hooks -g "$1" 2>/dev/null || true)"
  marker="$2"
  case "$hooks" in
    *"$marker"*) return 0 ;;
    *) return 1 ;;
  esac
}

install_notify_hook() {
  if ! has_notify_hook "$1" "$2"; then
    tmux set-hook -ag "$1" "$3"
  fi
}

notify_hook_command() {
  printf 'run-shell -b "TMUX=#{q:socket_path},#{q:pid},0 #{q:@pane_dash_notify_binary} %s >/dev/null 2>&1"' "$*"
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
  tmux set-option -g @pane_dash_notify_binary "$binary"
  tmux run-shell -b "$(shell_quote "$binary") notify serve --tmux-socket #{q:socket_path} --server-pid #{q:pid}"

  tmux set-option -g status 2
  tmux set-option -g 'status-format[1]' '#{E:@pane_dash_notify_status}'

  focus_in_notify_hook="$(notify_hook_command notify hook focus --client '#{q:client_tty}' --pane '#{q:pane_id}' --width '#{q:client_width}' --focused 1)"
  focus_out_notify_hook="$(notify_hook_command notify hook focus --client '#{q:client_tty}' --pane '#{q:pane_id}' --width '#{q:client_width}' --focused 0)"
  active_notify_hook="$(notify_hook_command notify hook focus --client '#{q:client_tty}' --pane '#{q:pane_id}' --width '#{q:client_width}' --focused 1)"
  pane_exited_notify_hook="$(notify_hook_command notify hook pane-exited --pane '#{q:hook_pane}')"
  session_closed_notify_hook="$(notify_hook_command notify hook session-closed)"

  install_notify_hook client-focus-in 'notify hook focus --client' "$focus_in_notify_hook"
  install_notify_hook client-focus-out 'notify hook focus --client' "$focus_out_notify_hook"
  install_notify_hook after-select-pane 'notify hook focus --client' "$active_notify_hook"
  install_notify_hook after-select-window 'notify hook focus --client' "$active_notify_hook"
  install_notify_hook client-session-changed 'notify hook focus --client' "$active_notify_hook"
  install_notify_hook client-resized 'notify hook focus --client' "$active_notify_hook"
  install_notify_hook pane-exited 'notify hook pane-exited --pane' "$pane_exited_notify_hook"
  install_notify_hook session-closed 'notify hook session-closed' "$session_closed_notify_hook"

  visible_click_condition='#{&&:#{==:#{mouse_status_line},1},#{m/r:^pane-dash-visible-[0-9]+$,#{mouse_status_range}}}'
  more_click_condition='#{&&:#{==:#{mouse_status_line},1},#{==:#{mouse_status_range},pane-dash-more}}'
  open_script="$(shell_quote "$DIR/scripts/open.sh")"
  visible_click_command="run-shell -b \"TMUX=#{q:socket_path},#{q:pid},0 #{q:@pane_dash_notify_binary} notify click --range #{q:mouse_status_range} --client #{q:client_tty} >/dev/null 2>&1\""
  more_click_command="run-shell -b \"TMUX=#{q:socket_path},#{q:pid},0 #{q:@pane_dash_notify_binary} notify click --range #{q:mouse_status_range} --client #{q:client_tty} >/dev/null 2>&1 && $open_script --notification-list #{q:@pane_dash_notify_binary} #{q:client_tty} #{q:session_id} #{q:pane_id}\""
  more_click_branch="{ if-shell -F \"$more_click_condition\" { $more_click_command } { switch-client -t = } }"
  tmux bind-key -T root MouseDown1Status if-shell -F "$visible_click_condition" \
    "{ $visible_click_command }" "$more_click_branch"

  tmux bind-key "$dash_key" run-shell \
    "$(shell_quote "$DIR/scripts/open.sh") $(shell_quote "$binary") '#{client_tty}' '#{session_id}' '#{pane_id}'"
else
  tmux display-message "pane-dash: Rust binary unavailable; run 'make build' in the tmux-pane-dash directory"
fi
tmux bind-key "$tag_key" run-shell "\"$DIR/scripts/tag.sh\" toggle '#{pane_id}'"
tmux bind-key "$label_key" command-prompt -p 'pane-dash label:' \
  "set-option -p @pane_dash_label_input \"%%%\" ; run-shell '\"$DIR/scripts/tag.sh\" label-from-option \"#{pane_id}\"'"
