#!/usr/bin/env bash
# scripts/dash.sh — entry: version checks, then popup running fzf (--inner).
# Outer usage: dash.sh [client_tty] [source_pane]. Task 9 passes tmux's
# #{client_tty} and #{pane_id} expansions to keep multi-client popups pinned.
# Spec sections: "Version requirements", "dash.sh", "Key model".
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

version_ge() { # version_ge <have> <need>
  local have="$1" need="$2"
  local -a have_parts need_parts
  local i have_part need_part length

  IFS=. read -r -a have_parts <<< "$have"
  IFS=. read -r -a need_parts <<< "$need"
  length=${#have_parts[@]}
  [ "${#need_parts[@]}" -gt "$length" ] && length=${#need_parts[@]}

  for ((i = 0; i < length; i++)); do
    have_part="${have_parts[i]:-0}"
    need_part="${need_parts[i]:-0}"
    ((10#$have_part > 10#$need_part)) && return 0
    ((10#$have_part < 10#$need_part)) && return 1
  done

  return 0
}

get_opt() { local v; v="$(tmux show-option -gqv "$1" || true)"; printf '%s' "${v:-$2}"; }

if [ "${1:-}" != "--inner" ]; then
  # ---- outer: run by the key binding ----
  if [ -z "${TMUX:-}" ]; then
    echo "pane-dash: must be run inside tmux" >&2
    exit 1
  fi

  tmux_ver="$(tmux -V | sed 's/[^0-9.]*//g' | cut -d. -f1,2)"
  if ! version_ge "$tmux_ver" "3.2"; then
    tmux display-message "pane-dash: tmux >= 3.2 required (found $tmux_ver)"
    exit 1
  fi
  if ! command -v fzf >/dev/null 2>&1; then
    tmux display-message "pane-dash: fzf not found (>= 0.73.0 required)"
    exit 1
  fi
  fzf_ver="$(fzf --version | awk '{print $1}')"
  if ! version_ge "$fzf_ver" "0.73.0"; then
    tmux display-message "pane-dash: fzf >= 0.73.0 required (found $fzf_ver)"
    exit 1
  fi

  client_tty="${1:-}"
  source_pane="${2:-}"
  [ -n "$client_tty" ] || client_tty="$(tmux display-message -p '#{client_tty}')"
  [ -n "$source_pane" ] || source_pane="$(tmux display-message -p '#{pane_id}')"
  width="$(get_opt @pane-dash-width 80%)"
  height="$(get_opt @pane-dash-height 70%)"
  popup_args=()
  [ -n "$client_tty" ] && popup_args+=(-c "$client_tty")
  [ -n "$source_pane" ] && popup_args+=(-t "$source_pane")
  popup_args+=(-E -w "$width" -h "$height")
  exec tmux display-popup "${popup_args[@]}" \
    "$DIR/dash.sh" --inner "$client_tty"
fi

# ---- inner: runs inside the popup ----
client_tty="${2:-}"

# Neutralize user defaults so they cannot break our bindings (spec M8)
export FZF_DEFAULT_OPTS=""
unset FZF_DEFAULT_OPTS_FILE
export PANE_DASH_DIR="$DIR"
export PANE_DASH_CLIENT="$client_tty"

# shellcheck disable=SC2016 # fzf expands these variables later via $SHELL -c.
# Pin action commands to Bash because the transform binding uses Bash syntax.
"$DIR/list.sh" | fzf \
  --with-shell 'bash -c' \
  --ansi \
  --delimiter '\t' \
  --with-nth 2.. \
  --accept-nth 1 \
  --id-nth 1 \
  --track \
  --no-input \
  --layout reverse-list \
  --no-sort \
  --pointer '▶' \
  --header 'enter:jump  /:filter  ctrl-s:send  ctrl-z:zoom  q:quit' \
  --preview '"$PANE_DASH_DIR/preview.sh" {1}' \
  --preview-window 'right,60%,border-left' \
  --bind 'every(1):reload-sync("$PANE_DASH_DIR/list.sh")+refresh-preview' \
  --bind 'j:down,k:up,g:first,G:last,q:abort' \
  --bind '/:show-input+unbind(j,k,g,G,q,/)' \
  --bind "esc:transform:
    if [ \"\$FZF_INPUT_STATE\" = enabled ]; then
      echo \"hide-input+rebind(j,k,g,G,q,/)\"
    else
      echo abort
    fi" \
  --bind 'enter:become("$PANE_DASH_DIR/action.sh" jump {1} "$PANE_DASH_CLIENT")' \
  --bind 'ctrl-z:become("$PANE_DASH_DIR/action.sh" zoom {1} "$PANE_DASH_CLIENT")' \
  --bind 'ctrl-s:execute("$PANE_DASH_DIR/action.sh" send {1})+reload-sync("$PANE_DASH_DIR/list.sh")' \
  || true
