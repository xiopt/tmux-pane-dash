#!/usr/bin/env bash
# scripts/preview.sh <pane_id|$session_id> — render a live fzf preview.
set -uo pipefail

pane="${1:-}"
[ -n "$pane" ] || { echo "[no pane selected]"; exit 0; }

if [[ "$pane" == \$* ]]; then
  if ! tmux has-session -t "$pane" 2>/dev/null; then
    echo "[session gone]"
    exit 0
  fi
  printf '\033[1;34m▸ %s\033[0m\n' "$pane"
  tmux list-windows -t "$pane" -F '#{window_index}: #{window_name} #{?window_active,*, } #{window_panes} panes' \
    2>/dev/null || echo "[session gone]"
  exit 0
fi

us="$(printf '\037')"
probe="$(tmux display-message -p -t "$pane" "#{pane_id}${us}#{pane_current_path}${us}#{@pane_dash_title}" 2>/dev/null || true)"
IFS="$us" read -r pane_id path title <<< "$probe"
if [ "$pane_id" != "$pane" ]; then
  echo "[pane $pane is gone]"
  exit 0
fi

columns="${FZF_PREVIEW_COLUMNS:-80}"
case "$columns" in
  '' | *[!0-9]*) columns=80 ;;
esac

separator=""
i=0
while [ "$i" -lt "$columns" ]; do
  separator="${separator}─"
  i=$((i + 1))
done
printf '\033[1;34m%s\033[0m  \033[2m%s\033[0m\n\033[2m%s\033[0m\n' "$path" "$title" "$separator"

tmux capture-pane -ep -t "$pane" 2>/dev/null || echo "[capture failed]"
