#!/usr/bin/env bash
# Shared helpers for transport spike probes. Every probe sources this.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_BIN="${TMUX_BIN:-tmux}"
TMUX_VERSION="$("$TMUX_BIN" -V | tr ' ' '_')"   # e.g. tmux_3.5a
RESULTS_DIR="$SPIKE_DIR/results/$TMUX_VERSION"
mkdir -p "$RESULTS_DIR"

# Each probe gets its own throwaway server.
pd_server() { echo "pd_spike_$1"; }

pd_kill_server() {
  "$TMUX_BIN" -L "$1" kill-server 2>/dev/null || true
}

pd_new_server() {
  local sock="$1"
  pd_kill_server "$sock"
  "$TMUX_BIN" -L "$sock" -f /dev/null new-session -d -s base -x 200 -y 50
}

# Record a result line into the probe's artifact.
pd_record() {  # $1=artifact file (relative to RESULTS_DIR), rest=line
  local f="$RESULTS_DIR/$1"; shift
  printf '%s\n' "$*" >> "$f"
}

pd_artifact() { echo "$RESULTS_DIR/$1"; }

pd_reset_artifact() {
  local f="$RESULTS_DIR/$1"
  : > "$f"
  pd_record "$1" "# probe: $1  tmux: $($TMUX_BIN -V)  date: $(date -u +%FT%TZ)"
}

pd_posix_shell_quote() { # $1=argv element; Bash strings cannot contain NUL
  local value="$1"
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

pd_run_in_pty() { # command and argv; preserves caller stdin for the attached client
  local script_bin="${PD_SCRIPT_BIN:-script}"
  local term="${TERM:-}"

  if [[ -z "$term" || "$term" == dumb ]]; then
    term=xterm
  fi

  if "$script_bin" --version 2>&1 | grep -qi 'util-linux'; then
    local command="" quoted argument
    for argument in "$@"; do
      quoted="$(pd_posix_shell_quote "$argument")"
      command+="${command:+ }$quoted"
    done
    TERM="$term" "$script_bin" -q -c "$command" /dev/null
  else
    TERM="$term" "$script_bin" -q /dev/null "$@"
  fi
}
