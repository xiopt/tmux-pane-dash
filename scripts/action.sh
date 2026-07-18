#!/usr/bin/env bash
# scripts/action.sh <jump|zoom|send> <pane_id|session_key> [client_tty]
# All mutating dashboard actions.
set -euo pipefail

cmd="${1:?usage: action.sh jump|zoom|send <target> [client_tty]}"
pane="${2:?pane id or session key required}"
client="${3:-}"
# PANE_DASH_TTY is test-only; production uses the controlling terminal.
tty="${PANE_DASH_TTY:-/dev/tty}"

pane_exists() {
  local found
  found="$(tmux display-message -p -t "$pane" '#{pane_id}' 2>/dev/null)" || return 1
  [ "$found" = "$pane" ]
}

session_key() {
  [[ "$pane" == \$* ]] && [ -n "${pane#\$}" ]
}

session_target() {
  printf '=%s' "${pane#\$}"
}

session_exists() {
  tmux has-session -t "$(session_target)" 2>/dev/null
}

session_jump() {
  local target
  target="$(session_target)"
  if [ -n "$client" ]; then
    tmux switch-client -c "$client" -t "$target"
  else
    tmux switch-client -t "$target"
  fi
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
    if session_key; then
      session_exists || exit 0
      session_jump
    else
      pane_exists || exit 0
      jump
    fi
    ;;
  zoom)
    if session_key; then
      session_exists || exit 0
      session_jump
    else
      pane_exists || exit 0
      tmux resize-pane -Z -t "$pane"
      jump
    fi
    ;;
  send)
    if session_key; then
      printf 'select a pane, not a session\n' >> "$tty"
      sleep 1
      exit 0
    fi
    if ! pane_exists; then
      printf 'pane %s is gone\n' "$pane" >> "$tty"
      sleep 1
      exit 0
    fi
    cur="$(tmux display-message -p -t "$pane" '#{pane_current_command}' 2>/dev/null || true)"
    printf '\nsend to %s (running: %s) — empty cancels\n> ' "$pane" "$cur" >> "$tty"
    IFS= read -r line < "$tty" || exit 0
    [ -n "$line" ] || exit 0
    pane_exists || {
      printf 'pane %s vanished, aborted\n' "$pane" >> "$tty"
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
