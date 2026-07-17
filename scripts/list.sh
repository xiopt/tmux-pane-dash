#!/usr/bin/env bash
# scripts/list.sh — emit dashboard rows: "<pane_id>\t<display>" per line.
# Delimiter safety: every field is fetched individually and sanitized
# BEFORE joining (spec: "Delimiter-safe framing"). Exactly one TAB per row.
set -euo pipefail

now="${PANE_DASH_NOW:-$(date +%s)}"

stale_secs="$(tmux show-option -gqv @pane-dash-stale-secs || true)"
case "$stale_secs" in ('' | *[!0-9]*) stale_secs=60 ;; esac
[ "$stale_secs" -gt 0 ] 2>/dev/null || stale_secs=60

match="$(tmux show-option -gqv @pane-dash-match || true)"
match="${match:-opencode}"

sanitize() { printf '%s' "$1" | tr '\t\n\r' '   ' | tr -d '\000-\037\177' | cut -c1-"${2:-120}"; }

# f <pane> <format-key> [maxlen] — one field per query, sanitized at the source
f() { sanitize "$(tmux display-message -p -t "$1" "#{$2}" 2>/dev/null || true)" "${3:-120}"; }

age() {
  local since="$1" d
  case "$since" in ('' | *[!0-9]*) echo ""; return ;; esac
  d=$((now - since))
  if [ "$d" -lt 0 ]; then d=0; fi
  if [ "$d" -lt 60 ]; then echo "${d}s"
  elif [ "$d" -lt 3600 ]; then echo "$((d / 60))m"
  elif [ "$d" -lt 86400 ]; then echo "$((d / 3600))h"
  else echo "$((d / 86400))d"; fi
}

# rank <status> — sort group (spec "Sort order")
rank() {
  case "$1" in
    needs_input) echo 0 ;;
    error)       echo 1 ;;
    working)     echo 2 ;;
    idle)        echo 3 ;;
    unknown)     echo 4 ;;
    stale)       echo 5 ;;
    *)           echo 6 ;;
  esac
}

glyph() {
  case "$1" in
    needs_input) printf '\033[31m●\033[0m' ;;
    error)       printf '\033[31m✖\033[0m' ;;
    working)     printf '\033[33m◐\033[0m' ;;
    idle)        printf '\033[32m○\033[0m' ;;
    stale)       printf '\033[90m~\033[0m' ;;
    *)           printf '\033[90m?\033[0m' ;;
  esac
}

color_status() { # needs_input gets red text (spec: highlighted)
  case "$1" in
    needs_input) printf '\033[31m%-11s\033[0m' "$1" ;;
    *)           printf '%-11s' "$1" ;;
  esac
}

while IFS= read -r pane; do
  [ -n "$pane" ] || continue
  plug_status="$(f "$pane" '@pane_dash_status' 20)"
  tag="$(f "$pane" '@pane_dash_tag' 80)"
  cmd="$(f "$pane" 'pane_current_command' 40)"

  status=""
  if [ -n "$plug_status" ]; then
    hb="$(f "$pane" '@pane_dash_heartbeat' 20)"
    case "$hb" in
      ('' | *[!0-9]*) status="stale" ;;
      (*) if [ $((now - hb)) -gt "$stale_secs" ]; then status="stale"; else status="$plug_status"; fi ;;
    esac
  elif [ "$cmd" = "$match" ]; then
    status="unknown"
  elif [ -n "$tag" ]; then
    status="unknown"
  else
    continue
  fi

  since="$(f "$pane" '@pane_dash_status_since' 20)"
  target="$(f "$pane" 'session_name' 20):$(f "$pane" 'window_index' 6).$(f "$pane" 'pane_index' 6)"
  dir="$(basename "$(f "$pane" 'pane_current_path' 200)" 2>/dev/null || true)"
  model="$(f "$pane" '@pane_dash_model' 24)"
  title="$(f "$pane" '@pane_dash_title' 60)"
  label="${title:-${tag:-$cmd}}"

  display="$(printf '%s %s %-4s %-16s %-14s %-10s %s' \
    "$(glyph "$status")" "$(color_status "$status")" "$(age "$since")" \
    "$target" "$dir" "$model" "$label")"

  sort_since="${since:-9999999999}"
  case "$sort_since" in (*[!0-9]*) sort_since=9999999999 ;; esac
  printf '%s\t%s\t%s\t%s\n' "$(rank "$status")" "$sort_since" "$pane" "$display"
done < <(tmux list-panes -a -F '#{pane_id}') |
  sort -t "$(printf '\t')" -k1,1n -k2,2n |
  cut -f3-
