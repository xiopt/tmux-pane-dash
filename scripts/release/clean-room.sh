#!/usr/bin/env bash
# Run one command with all stateful user-tool locations rooted in a disposable directory.
set -euo pipefail

usage() {
  printf '%s\n' 'usage: clean-room.sh -- command [arg ...]' >&2
  exit 64
}

[ "${1:-}" = '--' ] || usage
shift
[ "$#" -gt 0 ] || { printf '%s\n' 'clean-room: command required' >&2; exit 64; }

tool_names=(NODE_20_BIN NPM_20_CLI OPENCODE_1_17_20_BIN OPENCODE_LATEST_BIN TMUX_BIN)
declare -A tools=()
for tool in "${tool_names[@]}"; do
  value=${!tool:-}
  [ -z "$value" ] && continue
  case "$value" in
    /*) [ -x "$value" ] || { printf 'clean-room: %s is not executable: %s\n' "$tool" "$value" >&2; exit 64; } ;;
    *) printf 'clean-room: %s must be an absolute executable path\n' "$tool" >&2; exit 64 ;;
  esac
  tools["$tool"]=$value
done

root=$(mktemp -d "${TMPDIR:-/tmp}/tmux-pane-dash-clean.XXXXXX")
root=$(cd "$root" && pwd -P)
socket="pane-dash-clean-$$-$RANDOM"
child_pid=''

# shellcheck disable=SC2329 # Called by the EXIT-trapped cleanup function.
terminate_group() {
  local signal=$1
  [ -n "$child_pid" ] || return 0
  kill -"$signal" -- "-$child_pid" 2>/dev/null || kill -"$signal" "$child_pid" 2>/dev/null || true
}

# shellcheck disable=SC2329 # Invoked by EXIT/HUP/INT/TERM traps.
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    terminate_group TERM
    for _ in 1 2 3 4 5; do
      kill -0 "$child_pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$child_pid" 2>/dev/null && terminate_group KILL
    wait "$child_pid" 2>/dev/null || true
  fi
  if [ -n "${tools[TMUX_BIN]:-}" ]; then
    TMUX='' TMUX_PANE='' TMUX_TMPDIR="$root/tmux" "${tools[TMUX_BIN]}" -L "$socket" kill-server 2>/dev/null || true
  fi
  rm -rf -- "$root"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

unset TMUX TMUX_PANE TMUX_TMPDIR TMUX_PLUGIN_MANAGER_PATH SSH_AUTH_SOCK SSH_AGENT_PID
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy
unset npm_config_userconfig npm_config_globalconfig npm_config_prefix npm_config_cache
unset BUN_INSTALL BUN_INSTALL_CACHE_DIR
for tool in "${tool_names[@]}"; do unset "$tool"; done
for tool in "${!tools[@]}"; do export "$tool=${tools[$tool]}"; done

export HOME="$root/home"
export XDG_DATA_HOME="$root/xdg-data"
export XDG_CONFIG_HOME="$root/xdg-config"
export XDG_CACHE_HOME="$root/xdg-cache"
export npm_config_cache="$root/npm-cache"
export npm_config_userconfig="$root/npmrc"
export BUN_INSTALL_CACHE_DIR="$root/bun-cache"
export TMPDIR="$root/tmp"
export TMUX_TMPDIR="$root/tmux"
export PANE_DASH_TMUX_SOCKET="$socket"
mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$npm_config_cache" "$BUN_INSTALL_CACHE_DIR" "$TMPDIR" "$TMUX_TMPDIR"

# Job control gives the child its own process group, including descendants.
set -m
"$@" &
child_pid=$!
set +m
set +e
wait "$child_pid"
status=$?
set -e
child_pid=''
exit "$status"
