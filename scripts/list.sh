#!/usr/bin/env bash
# scripts/list.sh — emit dashboard rows: "<pane_id>\t<display>" per line.
# Delimiter safety: one RS/US-framed list-panes stream is validated before
# fields are sanitized and joined. Exactly one TAB is emitted per row.
set -euo pipefail

now="${PANE_DASH_NOW:-$(date +%s)}"
group_mode="$(tmux show-option -gqv @pane_dash_group || true)"

case "${1:-}" in
  toggle-group)
    if [ "$group_mode" = "1" ]; then
      tmux set-option -g @pane_dash_group 0
    else
      tmux set-option -g @pane_dash_group 1
    fi
    exit 0
    ;;
  '') ;;
  *)
    echo "usage: $0 [toggle-group]" >&2
    exit 2
    ;;
esac

stale_secs="$(tmux show-option -gqv @pane-dash-stale-secs || true)"
case "$stale_secs" in ('' | *[!0-9]*) stale_secs=60 ;; esac
[ "$stale_secs" -gt 0 ] 2>/dev/null || stale_secs=60

match="$(tmux show-option -gqv @pane-dash-match || true)"
match="${match:-opencode}"

age() {
  local since="$1" d
  age_value=""
  case "$since" in ('' | *[!0-9]*) return ;; esac
  d=$((now - since))
  if [ "$d" -lt 0 ]; then d=0; fi
  if [ "$d" -lt 60 ]; then age_value="${d}s"
  elif [ "$d" -lt 3600 ]; then age_value="$((d / 60))m"
  elif [ "$d" -lt 86400 ]; then age_value="$((d / 3600))h"
  else age_value="$((d / 86400))d"; fi
}

# rank <status> — sort group (spec "Sort order")
rank() {
  case "$1" in
    needs_input) rank_value=0 ;;
    error)       rank_value=1 ;;
    working)     rank_value=2 ;;
    idle)        rank_value=3 ;;
    unknown)     rank_value=4 ;;
    stale)       rank_value=5 ;;
    *)           rank_value=6 ;;
  esac
}

glyph() {
  case "$1" in
    needs_input) glyph_value=$'\033[31m●\033[0m' ;;
    error)       glyph_value=$'\033[31m✖\033[0m' ;;
    working)     glyph_value=$'\033[33m◐\033[0m' ;;
    idle)        glyph_value=$'\033[32m○\033[0m' ;;
    stale)       glyph_value=$'\033[90m~\033[0m' ;;
    *)           glyph_value=$'\033[90m?\033[0m' ;;
  esac
}

color_status() { # needs_input gets red text (spec: highlighted)
  case "$1" in
    needs_input) printf -v color_status_value '\033[31m%-11s\033[0m' "$1" ;;
    *)           printf -v color_status_value '%-11s' "$1" ;;
  esac
}

rs="$(printf '\036')"
us="$(printf '\037')"
format="${rs}#{pane_id}${us}#{@pane_dash_status}${us}#{@pane_dash_tag}${us}#{@pane_dash_heartbeat}${us}#{@pane_dash_status_since}${us}#{@pane_dash_model}${us}#{@pane_dash_title}${us}#{session_name}${us}#{window_index}${us}#{pane_index}${us}#{pane_current_path}${us}#{pane_current_command}"

# A newline in a hostile value yields a continuation line. Hold each record
# until the next record (or EOF), so any continuation drops the whole record.
while IFS= read -r record; do
  payload="${record#"$rs"}"
  IFS="$us" read -r pane plug_status tag hb since model title session window pane_index path cmd <<< "$payload"

  [ -n "$pane" ] || continue

  status=""
  if [ -n "$plug_status" ]; then
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

  target="$session:$window.$pane_index"
  case "$path" in
    /) dir=/ ;;
    */) dir="${path%/}"; dir="${dir##*/}" ;;
    *) dir="${path##*/}" ;;
  esac
  label="${title:-${tag:-$cmd}}"

  glyph "$status"
  color_status "$status"
  age "$since"
  printf -v display '%s %s %-4s %-16s %-14s %-10s %s' \
    "$glyph_value" "$color_status_value" "$age_value" "$target" "$dir" "$model" "$label"

  sort_since="${since:-9999999999}"
  case "$sort_since" in (*[!0-9]*) sort_since=9999999999 ;; esac
  if [ "$group_mode" = "1" ]; then
    sort_window="${window:-9999999999}"
    sort_pane="${pane_index:-9999999999}"
    case "$sort_window" in (*[!0-9]*) sort_window=9999999999 ;; esac
    case "$sort_pane" in (*[!0-9]*) sort_pane=9999999999 ;; esac
    printf '%s\t%s\t%s\t%s\t%s\n' "$session" "$sort_window" "$sort_pane" "$pane" "$display"
  else
    rank "$status"
    printf '%s\t%s\t%s\t%s\n' "$rank_value" "$sort_since" "$pane" "$display"
  fi
done < <(
  tmux list-panes -a -F "$format" |
    awk -v rs="$rs" -v us="$us" '
      function clean(value, limit) {
        gsub(/\t/, " ", value)
        gsub(/[[:cntrl:]]/, "", value)
        return substr(value, 1, limit)
      }
      function flush(    field, count, i, limits, output) {
        if (!have || bad) return
        count = split(substr(record, 2), field, us)
        if (count != 12) return
        split("120 20 80 20 20 24 60 20 6 6 200 40", limits, " ")
        output = rs
        for (i = 1; i <= count; i++) output = output clean(field[i], limits[i]) (i == count ? "" : us)
        print output
      }
      index($0, rs) == 1 {
        flush()
        record = $0
        have = 1
        bad = (split(substr($0, 2), fields, us) != 12)
        next
      }
      { if (have) bad = 1 }
      END { flush() }
    '
) |
  if [ "$group_mode" = "1" ]; then
    sort -t "$(printf '\t')" -k1,1 -k2,2n -k3,3n | cut -f4-
  else
    sort -t "$(printf '\t')" -k1,1n -k2,2n | cut -f3-
  fi
