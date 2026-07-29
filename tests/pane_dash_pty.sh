#!/usr/bin/env bash

# Quote one argv element for the POSIX shell command form of util-linux script(1).
pane_dash_posix_shell_quote() { # $1=argv element; Bash strings cannot contain NUL
  local value="$1"
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

# Run one fixed executable/argv under script(1), preserving the caller's stdin.
pane_dash_run_in_pty() {
  local script_bin="${PD_SCRIPT_BIN:-script}"
  local term="${TERM:-}"

  if [[ -z "$term" || "$term" == dumb ]]; then
    term=xterm
  fi

  if "$script_bin" --version 2>&1 | grep -qi 'util-linux'; then
    local command="" quoted argument
    for argument in "$@"; do
      quoted="$(pane_dash_posix_shell_quote "$argument")"
      command+="${command:+ }$quoted"
    done
    TERM="$term" "$script_bin" -q -c "$command" /dev/null
  else
    TERM="$term" "$script_bin" -q /dev/null "$@"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if (( $# == 0 )); then
    printf 'usage: %s COMMAND [ARGUMENT...]\n' "$0" >&2
    exit 2
  fi
  pane_dash_run_in_pty "$@"
fi
