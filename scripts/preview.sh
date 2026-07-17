#!/usr/bin/env bash
# scripts/preview.sh <pane_id> — render a live fzf preview for a pane.
set -uo pipefail

pane="${1:-}"
[ -n "$pane" ] || { echo "[no pane selected]"; exit 0; }

pane_id="$(tmux display-message -p -t "$pane" '#{pane_id}' 2>/dev/null || true)"
if [ "$pane_id" != "$pane" ]; then
  echo "[pane $pane is gone]"
  exit 0
fi

alt="$(tmux display-message -p -t "$pane" '#{alternate_on}' 2>/dev/null || true)"

path="$(tmux display-message -p -t "$pane" '#{pane_current_path}' 2>/dev/null || true)"
title="$(tmux display-message -p -t "$pane" '#{@pane_dash_title}' 2>/dev/null || true)"
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

if [ "$alt" = "1" ]; then
  tmux capture-pane -aep -t "$pane" 2>/dev/null || echo "[capture failed]"
else
  tmux capture-pane -ep -t "$pane" 2>/dev/null || echo "[capture failed]"
fi
