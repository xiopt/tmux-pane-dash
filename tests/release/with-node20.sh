#!/usr/bin/env bash
# Provision or reuse exactly Node 20.0.0 without reading user mise state.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
state_dir="$repo_root/.cortexkit/v0.1-release"
descriptor="$state_dir/node20.env"
lock="$state_dir/node20.lock"

fail() { printf 'with-node20: %s\n' "$*" >&2; exit 64; }
canonical_dir() { (cd "$1" && pwd -P); }
stat_mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
stat_uid() { stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1"; }
owner_uid() { id -u; }

temp_prefix=$(canonical_dir "${TMPDIR:-/tmp}") || fail 'TMPDIR must name an existing directory'

path_is_under() {
  local path=$1 base=$2
  [ "$path" = "$base" ] || [[ "$path" == "$base/"* ]]
}

validate_tools() {
  local node=$1 npm=$2
  case "$node:$npm" in /*:/*) ;; *) return 1 ;; esac
  [ -x "$node" ] && [ -x "$npm" ] || return 1
  [ "$("$node" --version 2>/dev/null)" = 'v20.0.0' ] || return 1
}

descriptor_root=''
descriptor_mise=''
descriptor_node=''
descriptor_npm=''
parse_descriptor() {
  local line key value count=0
  descriptor_root='' descriptor_mise='' descriptor_node='' descriptor_npm=''
  [ -f "$descriptor" ] || return 1
  [ "$(stat_mode "$descriptor")" = 600 ] || return 1
  [ "$(stat_uid "$descriptor")" = "$(owner_uid)" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    key=${line%%=*}
    value=${line#*=}
    [ "$key" != "$line" ] && [ -n "$value" ] || return 1
    count=$((count + 1))
    case "$key" in
      SCHEMA) [ "$value" = 1 ] || return 1 ;;
      ROOT) [ -z "$descriptor_root" ] || return 1; descriptor_root=$value ;;
      MISE) [ -z "$descriptor_mise" ] || return 1; descriptor_mise=$value ;;
      NODE_20_BIN) [ -z "$descriptor_node" ] || return 1; descriptor_node=$value ;;
      NPM_20_CLI) [ -z "$descriptor_npm" ] || return 1; descriptor_npm=$value ;;
      *) return 1 ;;
    esac
  done < "$descriptor"
  [ "$count" -eq 5 ] && [ -n "$descriptor_root" ] && [ -n "$descriptor_mise" ] && [ -n "$descriptor_node" ] && [ -n "$descriptor_npm" ]
}

validate_root() {
  local root=$1 forbidden
  case "$root" in /*) ;; *) return 1 ;; esac
  [ -d "$root" ] || return 1
  [ "$(basename "$root")" != "$root" ] || return 1
  [[ "$(basename "$root")" == tmux-pane-dash-node20.* ]] || return 1
  root=$(canonical_dir "$root") || return 1
  path_is_under "$root" "$temp_prefix" || return 1
  for forbidden in "$repo_root" "${HOME:-$repo_root}" "${XDG_DATA_HOME:-${HOME:-$repo_root}/.local/share}" "${XDG_CONFIG_HOME:-${HOME:-$repo_root}/.config}" "${XDG_CACHE_HOME:-${HOME:-$repo_root}/.cache}"; do
    [ -e "$forbidden" ] || continue
    forbidden=$(canonical_dir "$forbidden") || return 1
    path_is_under "$root" "$forbidden" && return 1
  done
  [ "$root" = "$1" ]
}

validate_descriptor() {
  parse_descriptor || return 1
  validate_root "$descriptor_root" || return 1
  case "$descriptor_mise:$descriptor_node:$descriptor_npm" in /*:/*:/*) ;; *) return 1 ;; esac
  [ -x "$descriptor_mise" ] || return 1
  path_is_under "$descriptor_node" "$descriptor_root" || return 1
  path_is_under "$descriptor_npm" "$descriptor_root" || return 1
  validate_tools "$descriptor_node" "$descriptor_npm"
}

pid_start_token() { ps -o lstart= -p "$1" 2>/dev/null | tr -d ' '; }
acquire_lock() {
  local tries=0 owner_pid owner_token current_token
  mkdir -p "$state_dir"
  while ! mkdir "$lock" 2>/dev/null; do
    owner_pid='' owner_token=''
    if [ -f "$lock/owner" ]; then
      IFS=' ' read -r owner_pid owner_token < "$lock/owner" || true
    fi
    if [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
      current_token=$(pid_start_token "$owner_pid")
      [ -n "$owner_token" ] && [ "$current_token" = "$owner_token" ] || fail 'Node 20 provisioning lock owner changed'
    else
      rm -rf -- "$lock"
      continue
    fi
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] || fail 'Node 20 provisioning lock is held'
    sleep 1
  done
  printf '%s %s\n' "$$" "$(pid_start_token "$$")" > "$lock/owner"
}
release_lock() { rm -rf -- "$lock"; }

write_descriptor() {
  local root=$1 mise=$2 node=$3 npm=$4 temporary
  temporary="$state_dir/node20.env.$$"
  (umask 077; printf 'SCHEMA=1\nROOT=%s\nMISE=%s\nNODE_20_BIN=%s\nNPM_20_CLI=%s\n' "$root" "$mise" "$node" "$npm" > "$temporary")
  chmod 600 "$temporary"
  sync "$temporary" 2>/dev/null || true
  mv -f "$temporary" "$descriptor"
}

provision() {
  local mise root node npm install_pid elapsed=0
  mise=$(command -v mise || true)
  case "$mise" in /*) [ -x "$mise" ] || fail 'mise is not executable' ;; *) fail 'mise is required to provision Node 20.0.0' ;; esac
  root=$(mktemp -d "${TMPDIR:-/tmp}/tmux-pane-dash-node20.XXXXXX")
  root=$(canonical_dir "$root") || fail 'cannot canonicalize Node root'
  validate_root "$root" || { rm -rf -- "$root"; fail 'unsafe Node root'; }
  export HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache"
  export MISE_DATA_DIR="$root/mise/data" MISE_CACHE_DIR="$root/mise/cache" MISE_CONFIG_DIR="$root/mise/config"
  export MISE_GLOBAL_CONFIG_FILE="$root/mise/config/global.toml" MISE_SYSTEM_CONFIG_FILE="$root/mise/config/system.toml"
  export MISE_DEFAULT_CONFIG_FILENAME="$root/mise/config/default-packages"
  mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$MISE_DATA_DIR" "$MISE_CACHE_DIR" "$MISE_CONFIG_DIR"
  set -m; "$mise" install node@20.0.0 & install_pid=$!; set +m
  while kill -0 "$install_pid" 2>/dev/null; do
    [ "$elapsed" -lt 600 ] || { kill -TERM -- "-$install_pid" 2>/dev/null || kill -TERM "$install_pid" 2>/dev/null || true; sleep 5; kill -KILL -- "-$install_pid" 2>/dev/null || true; wait "$install_pid" 2>/dev/null || true; rm -rf -- "$root"; fail 'Node provision timed out'; }
    sleep 1; elapsed=$((elapsed + 1))
  done
  wait "$install_pid" || { rm -rf -- "$root"; fail 'mise failed to install Node 20.0.0'; }
  node="$MISE_DATA_DIR/installs/node/20.0.0/bin/node"
  npm="$MISE_DATA_DIR/installs/node/20.0.0/bin/npm"
  validate_tools "$node" "$npm" || { rm -rf -- "$root"; fail 'mise did not provide exact Node 20.0.0 and npm'; }
  write_descriptor "$root" "$mise" "$node" "$npm"
}

if [ "${1:-}" = '--cleanup' ]; then
  [ "$#" -eq 1 ] || fail 'usage: with-node20.sh --cleanup'
  [ -d "$state_dir" ] || exit 0
  acquire_lock
  trap release_lock EXIT HUP INT TERM
  if [ -e "$descriptor" ]; then
    validate_descriptor || fail 'invalid descriptor refuses cleanup'
    rm -rf -- "$descriptor_root"
    rm -f -- "$descriptor"
  fi
  release_lock
  trap - EXIT HUP INT TERM
  rmdir "$state_dir" 2>/dev/null || true
  exit 0
fi
[ "${1:-}" = '--' ] && [ "$#" -gt 1 ] || fail 'usage: with-node20.sh -- command [arg ...]'
shift

if [ "${PANE_DASH_NODE20_PREPROVIDED:-}" = 1 ]; then
  validate_tools "${NODE_20_BIN:-}" "${NPM_20_CLI:-}" || fail 'preprovided Node must be exact v20.0.0 with executable npm'
  node_directory=$(dirname "$NODE_20_BIN")
  export PATH="$node_directory:$PATH"
  [ "$(command -v node)" = "$NODE_20_BIN" ] || fail 'preprovided Node must lead PATH'
  exec "$@"
fi

acquire_lock
trap release_lock EXIT HUP INT TERM
if ! validate_descriptor; then
  rm -f -- "$descriptor"
  provision
  validate_descriptor || fail 'new Node descriptor failed validation'
fi
node=$descriptor_node
npm=$descriptor_npm
release_lock
trap - EXIT HUP INT TERM
node_directory=$(dirname "$node")
export NODE_20_BIN="$node" NPM_20_CLI="$npm" PATH="$node_directory:$PATH"
exec "$@"
