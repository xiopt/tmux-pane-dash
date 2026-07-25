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
tool_values=()
tmux_bin=''
if [ -z "${TMUX_BIN:-}" ]; then
  printf '%s\n' 'clean-room: TMUX_BIN required' >&2
  exit 64
fi
for tool in "${tool_names[@]}"; do
  value=${!tool:-}
  tool_values+=("$value")
  [ -z "$value" ] && continue
  case "$value" in
    /*) [ -x "$value" ] || { printf 'clean-room: %s is not executable: %s\n' "$tool" "$value" >&2; exit 64; } ;;
    *) printf 'clean-room: %s must be an absolute executable path\n' "$tool" >&2; exit 64 ;;
  esac
  [ "$tool" = TMUX_BIN ] && tmux_bin=$value
done

tmux_version=$("$tmux_bin" -V 2>/dev/null || true)
if [[ ! "$tmux_version" =~ ^tmux\ 3\.([6-9]|[1-9][0-9])([^0-9].*)?$ ]]; then
  printf 'clean-room: TMUX_BIN must be tmux >= 3.6: %s\n' "$tmux_version" >&2
  exit 64
fi

root=$(mktemp -d "${TMPDIR:-/tmp}/tmux-pane-dash-clean.XXXXXX")
root=$(cd "$root" && pwd -P)
tmux_root=$(mktemp -d /tmp/pd-tmux.XXXXXX)
tmux_root=$(cd "$tmux_root" && pwd -P)
tmp_root=$(mktemp -d /tmp/pd-tmp.XXXXXX)
tmp_root=$(cd "$tmp_root" && pwd -P)
# macOS bounds Unix-domain socket paths; the clean-room root can already be long.
printf -v socket 'pd-%04x%04x' "$RANDOM" "$RANDOM"
child_pid=''
child_pgid=''
own_pgid=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')

# shellcheck disable=SC2329 # Called by the EXIT-trapped cleanup function.
terminate_group() {
  local signal=$1
  [ -n "$child_pgid" ] || return 0
  [[ "$child_pgid" =~ ^[1-9][0-9]*$ ]] || return 0
  [ "$child_pgid" != "$own_pgid" ] || return 0
  kill -"$signal" -- "-$child_pgid" 2>/dev/null || true
}

# shellcheck disable=SC2329 # Called by the EXIT-trapped cleanup function.
group_is_alive() {
  [ -n "$child_pgid" ] && [ "$child_pgid" != "$own_pgid" ] && kill -0 -- "-$child_pgid" 2>/dev/null
}

# shellcheck disable=SC2329 # Invoked by EXIT/HUP/INT/TERM traps.
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if group_is_alive; then
    terminate_group TERM
    for _ in 1 2 3 4 5; do
      group_is_alive || break
      sleep 1
    done
    group_is_alive && terminate_group KILL
  fi
  [ -n "$child_pid" ] && wait "$child_pid" 2>/dev/null || true
  if [ -n "$tmux_bin" ]; then
    TMUX='' TMUX_PANE='' TMUX_TMPDIR="$tmux_root" "$tmux_bin" -L "$socket" kill-server 2>/dev/null || true
  fi
  rm -rf -- "$tmux_root"
  rm -rf -- "$tmp_root"
  rm -rf -- "$root"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

unset TMUX TMUX_PANE TMUX_TMPDIR TMUX_PLUGIN_MANAGER_PATH SSH_AUTH_SOCK SSH_AGENT_PID
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy
unset npm_config_userconfig npm_config_globalconfig npm_config_prefix npm_config_cache npm_config_registry
unset BUN_INSTALL BUN_INSTALL_CACHE_DIR DOCKER_CONFIG KUBECONFIG NETRC GOOGLE_APPLICATION_CREDENTIALS
unset GH_TOKEN GITHUB_TOKEN NPM_TOKEN NODE_AUTH_TOKEN
for variable in $(env | cut -d= -f1); do
  case "$variable" in
    *_TOKEN|*_PASSWORD|*_SECRET|*_API_KEY|AWS_*|AZURE_*|CARGO_REGISTRIES_*|CARGO_REGISTRY_*|BUN_CONFIG_*|npm_config_*) unset "$variable" ;;
  esac
done
for tool in "${tool_names[@]}"; do unset "$tool"; done
for index in "${!tool_names[@]}"; do
  tool=${tool_names[$index]}
  value=${tool_values[$index]}
  [ -n "$value" ] && export "$tool=$value"
done

unset RUSTUP_HOME CARGO_HOME

export HOME="$root/home"
export XDG_DATA_HOME="$root/xdg-data"
export XDG_CONFIG_HOME="$root/xdg-config"
export XDG_CACHE_HOME="$root/xdg-cache"
export npm_config_cache="$root/npm-cache"
export npm_config_userconfig="$root/npmrc"
export BUN_INSTALL_CACHE_DIR="$root/bun-cache"
export TMPDIR="$tmp_root"
export TMUX_TMPDIR="$tmux_root"
export PANE_DASH_TMUX_SOCKET="$socket"
mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$npm_config_cache" "$BUN_INSTALL_CACHE_DIR" "$TMPDIR" "$TMUX_TMPDIR"

# Job control gives the child its own process group, including descendants.
set -m
"$@" &
child_pid=$!
# Under monitor mode, a simple asynchronous job is led by its PID.  Record it
# before the leader can exit; querying ps here races a fast-exiting leader.
child_pgid=$child_pid
set +m
set +e
wait "$child_pid"
status=$?
set -e
exit "$status"
