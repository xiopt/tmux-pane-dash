#!/usr/bin/env bash
# Provision or reuse exactly Node 20.0.0 without reading user mise state.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
state_dir="$repo_root/.cortexkit/v0.1-release"
descriptor="$state_dir/node20.env"

fail() { printf 'with-node20: %s\n' "$*" >&2; exit 64; }
canonical_dir() { (cd "$1" && pwd -P); }
stat_numeric() {
  local gnu_format=$1 bsd_format=$2 pattern=$3 path=$4 value
  if value=$(stat -c "$gnu_format" "$path" 2>/dev/null) && [[ "$value" =~ $pattern ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  if value=$(stat -f "$bsd_format" "$path" 2>/dev/null) && [[ "$value" =~ $pattern ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  return 1
}
stat_mode() { stat_numeric '%a' '%Lp' '^[0-7]{3,4}$' "$1"; }
stat_uid() { stat_numeric '%u' '%u' '^[0-9]+$' "$1"; }
owner_uid() {
  if [ -n "${PANE_DASH_TEST_OWNER_UID:-}" ]; then
    [[ "$PANE_DASH_TEST_OWNER_UID" =~ ^[0-9]+$ ]] || fail 'invalid test owner UID'
    printf '%s\n' "$PANE_DASH_TEST_OWNER_UID"
  else
    id -u
  fi
}

temp_prefix=$(canonical_dir "${TMPDIR:-/tmp}") || fail 'TMPDIR must name an existing directory'

path_is_under() {
  local path=$1 base=$2
  [ "$path" = "$base" ] || [[ "$path" == "$base/"* ]]
}

has_parent_component() { [[ "/$1/" == *'/../'* ]]; }

validate_contained_executable() {
  local file=$1 root=$2 component candidate canonical
  case "$file" in /*) ;; *) return 1 ;; esac
  has_parent_component "$file" && return 1
  path_is_under "$file" "$root" || return 1
  candidate=$root
  IFS=/ read -r -a components <<< "${file#"$root"/}"
  for component in "${components[@]}"; do
    [ -n "$component" ] && [ "$component" != . ] || return 1
    candidate="$candidate/$component"
    [ ! -L "$candidate" ] || return 1
  done
  [ -f "$file" ] && [ -x "$file" ] || return 1
  canonical="$(canonical_dir "$(dirname "$file")")/$(basename "$file")" || return 1
  [ "$canonical" = "$file" ] && path_is_under "$canonical" "$root"
}

validate_tools() {
  local node=$1 npm=$2
  case "$node:$npm" in /*:/*) ;; *) return 1 ;; esac
  [ -x "$node" ] && [ -x "$npm" ] || return 1
  [ "$("$node" --version 2>/dev/null)" = 'v20.0.0' ] || return 1
  "$node" "$npm" --version >/dev/null 2>&1
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
  has_parent_component "$root" && return 1
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
  [ -f "$descriptor_mise" ] && [ -x "$descriptor_mise" ] || return 1
  validate_contained_executable "$descriptor_node" "$descriptor_root" || return 1
  validate_contained_executable "$descriptor_npm" "$descriptor_root" || return 1
  validate_tools "$descriptor_node" "$descriptor_npm"
}

safe_discard_root=''
parse_safe_discard_root() {
  local line key value root_count=0
  safe_discard_root=''
  [ -f "$descriptor" ] && [ ! -L "$descriptor" ] || return 1
  [ "$(stat_mode "$descriptor")" = 600 ] || return 1
  [ "$(stat_uid "$descriptor")" = "$(owner_uid)" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    key=${line%%=*}
    value=${line#*=}
    [ "$key" != "$line" ] && [ -n "$value" ] || return 1
    if [ "$key" = ROOT ]; then
      root_count=$((root_count + 1))
      [ "$root_count" -eq 1 ] || return 1
      safe_discard_root=$value
    fi
  done < "$descriptor"
  [ "$root_count" -eq 1 ] && validate_root "$safe_discard_root"
}

pid_start_token() { ps -o lstart= -p "$1" 2>/dev/null | tr -d ' '; }

acquire_lock() {
  :
}
release_lock() {
  :
}

incomplete_root=''
incomplete_gpg_link=''
incomplete_descriptor_temp=''
install_pgid=''
guard_fd=''

record_fault_resource() {
  [ -n "${PANE_DASH_TEST_FAULT_LOG:-}" ] || return 0
  printf '%s=%s\n' "$1" "$2" >> "$PANE_DASH_TEST_FAULT_LOG"
}

fault_after() {
  [ "${PANE_DASH_TEST_FAULT_STEP:-}" = "$1" ] || return 0
  fail "injected failure after $1"
}

stop_incomplete_provision() {
  terminate_install_group
  rm -f -- "$incomplete_descriptor_temp"
  rm -f -- "$incomplete_gpg_link"
  rm -rf -- "$incomplete_root"
  incomplete_descriptor_temp='' incomplete_gpg_link='' incomplete_root='' install_pgid=''
}

terminate_install_group() {
  local _ kill_grace=${PANE_DASH_TEST_KILL_GRACE:-5}
  if [ -n "$install_pgid" ]; then
    kill -TERM -- "-$install_pgid" 2>/dev/null || true
    [[ "$kill_grace" =~ ^[0-9]+$ ]] || fail 'invalid test kill grace'
    for ((_=0; _<kill_grace; _++)); do
      kill -0 -- "-$install_pgid" 2>/dev/null || break
      sleep 1
    done
    kill -KILL -- "-$install_pgid" 2>/dev/null || true
    wait "$install_pgid" 2>/dev/null || true
  fi
}

finish_owned_provision() {
  local status=$?
  trap - EXIT HUP INT TERM
  stop_incomplete_provision
  release_lock
  exit "$status"
}

write_descriptor() {
  local root=$1 mise=$2 node=$3 npm=$4 temporary
  temporary="$state_dir/node20.env.$$"
  incomplete_descriptor_temp=$temporary
  record_fault_resource descriptor-temp "$temporary"
  (umask 077; printf 'SCHEMA=1\nROOT=%s\nMISE=%s\nNODE_20_BIN=%s\nNPM_20_CLI=%s\n' "$root" "$mise" "$node" "$npm" > "$temporary")
  fault_after descriptor-write
  chmod 600 "$temporary"
  fault_after descriptor-chmod
  sync "$temporary" 2>/dev/null || true
  fault_after descriptor-mv
  mv -f "$temporary" "$descriptor"
  incomplete_descriptor_temp=''
}

provision() {
  local mise root node npm gpg_link install_pid elapsed=0 provision_timeout=${PANE_DASH_TEST_PROVISION_TIMEOUT:-600}
  local isolated_home isolated_xdg_data isolated_xdg_config isolated_xdg_cache mise_data mise_cache mise_config
  [[ "$provision_timeout" =~ ^[1-9][0-9]*$ ]] || fail 'invalid test provision timeout'
  mise=$(command -v mise || true)
  case "$mise" in /*) [ -x "$mise" ] || fail 'mise is not executable' ;; *) fail 'mise is required to provision Node 20.0.0' ;; esac
  root=$(mktemp -d "${TMPDIR:-/tmp}/tmux-pane-dash-node20.XXXXXX")
  root=$(canonical_dir "$root") || fail 'cannot canonicalize Node root'
  incomplete_root=$root
  record_fault_resource root "$root"
  validate_root "$root" || { rm -rf -- "$root"; fail 'unsafe Node root'; }
  isolated_home="$root/home"; isolated_xdg_data="$root/data"; isolated_xdg_config="$root/config"; isolated_xdg_cache="$root/cache"
  mise_data="$root/mise/data"; mise_cache="$root/mise/cache"; mise_config="$root/mise/config"
  mkdir -p "$isolated_home" "$isolated_xdg_data" "$isolated_xdg_config" "$isolated_xdg_cache" "$mise_data" "$mise_cache" "$mise_config" "$root/gnupg"
  fault_after root-mkdir
  chmod 700 "$root/gnupg"
  gpg_link=$(mktemp -d /tmp/tmux-pane-dash-node20-gpg.XXXXXX)
  rmdir "$gpg_link"
  ln -s "$root/gnupg" "$gpg_link"
  incomplete_gpg_link=$gpg_link
  record_fault_resource gpg-link "$gpg_link"
  fault_after gpg-link
  set -m
  (
    exec /usr/bin/perl -e 'use POSIX (); my $fd = shift @ARGV; POSIX::close($fd) or die "close guard fd: $!\n"; exec @ARGV or die "exec mise: $!\n"' "$guard_fd" env HOME="$isolated_home" XDG_DATA_HOME="$isolated_xdg_data" XDG_CONFIG_HOME="$isolated_xdg_config" XDG_CACHE_HOME="$isolated_xdg_cache" \
      MISE_DATA_DIR="$mise_data" MISE_CACHE_DIR="$mise_cache" MISE_CONFIG_DIR="$mise_config" \
      MISE_GLOBAL_CONFIG_FILE="$mise_config/global.toml" MISE_SYSTEM_CONFIG_FILE="$mise_config/system.toml" \
      MISE_DEFAULT_CONFIG_FILENAME="$mise_config/default-packages" GNUPGHOME="$gpg_link" \
      "$mise" install node@20.0.0
  ) & install_pid=$!
  set +m
  install_pgid=$install_pid
  while kill -0 "$install_pid" 2>/dev/null; do
    [ "$elapsed" -lt "$provision_timeout" ] || { stop_incomplete_provision; fail 'Node provision timed out'; }
    sleep 1; elapsed=$((elapsed + 1))
  done
  wait "$install_pid" || { stop_incomplete_provision; fail 'mise failed to install Node 20.0.0'; }
  terminate_install_group
  install_pgid=''
  rm -f -- "$gpg_link"
  incomplete_gpg_link=''
  node="$mise_data/installs/node/20.0.0/bin/node"
  npm="$mise_data/installs/node/20.0.0/lib/node_modules/npm/bin/npm-cli.js"
  validate_tools "$node" "$npm" || { stop_incomplete_provision; fail 'mise did not provide exact Node 20.0.0 and npm'; }
  write_descriptor "$root" "$mise" "$node" "$npm"
  incomplete_root=''
}

result_node=''
result_npm=''
result_cleanup=''
parse_result() {
  local line key value count=0 result=$1
  result_node='' result_npm=''
  [ -f "$result" ] && [ ! -L "$result" ] || return 1
  [ "$(stat_mode "$result")" = 600 ] && [ "$(stat_uid "$result")" = "$(owner_uid)" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    key=${line%%=*}; value=${line#*=}; [ "$key" != "$line" ] && [ -n "$value" ] || return 1
    count=$((count + 1))
    case "$key" in
      SCHEMA) [ "$value" = 1 ] || return 1 ;;
      NODE_20_BIN) [ -z "$result_node" ] || return 1; result_node=$value ;;
      NPM_20_CLI) [ -z "$result_npm" ] || return 1; result_npm=$value ;;
      *) return 1 ;;
    esac
  done < "$result"
  [ "$count" -eq 3 ] && validate_tools "$result_node" "$result_npm"
}

write_result() {
  local result=$1 temporary
  temporary="$result.$$.tmp"
  (umask 077; printf 'SCHEMA=1\nNODE_20_BIN=%s\nNPM_20_CLI=%s\n' "$descriptor_node" "$descriptor_npm" > "$temporary")
  chmod 600 "$temporary"
  mv -f "$temporary" "$result"
}

run_guarded_prepare() {
  local result status attempts=${PANE_DASH_TEST_LOCK_ATTEMPTS:-600} lock_sleep=${PANE_DASH_TEST_LOCK_SLEEP:-1}
  local perl=/usr/bin/perl script_path
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || fail 'invalid test lock attempt limit'
  [[ "$lock_sleep" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail 'invalid test lock sleep'
  [ -x "$perl" ] || fail 'required /usr/bin/perl is unavailable'
  [ "${PANE_DASH_TEST_PERL_UNSUPPORTED:-}" != 1 ] || fail 'required Perl flock capability is unavailable'
  "$perl" -MFcntl=:flock -e 'exit((defined(&LOCK_EX) && defined(&LOCK_NB)) ? 0 : 1)' || fail 'required Perl flock capability is unavailable'
  mkdir -p "$state_dir"
  script_path="$(canonical_dir "$(dirname "${BASH_SOURCE[0]}")")/$(basename "${BASH_SOURCE[0]}")"
  result=$(mktemp "$state_dir/.node20.result.XXXXXX") || fail 'cannot create Node result handshake'
  chmod 600 "$result"
  result_cleanup=$result
  trap 'rm -f -- "${result_cleanup:-}"' EXIT HUP INT TERM
  # shellcheck disable=SC2016 # Perl source intentionally contains $ expressions.
  "$perl" -e '
    use strict; use warnings; use Fcntl qw(:flock F_SETFD);
    my ($path, $attempts, $sleep, $script, @command) = @ARGV;
    open my $lock, q{<}, $path or die "with-node20: cannot open script lock: $!\n";
    for (my $try = 0; $try < $attempts; ++$try) {
      if (flock($lock, LOCK_EX | LOCK_NB)) {
        fcntl($lock, F_SETFD, 0) or die "with-node20: cannot inherit script lock: $!\n";
        $SIG{INT} = q{DEFAULT}; $SIG{HUP} = q{DEFAULT}; $SIG{TERM} = q{DEFAULT};
        exec {$script} $script, q{--private-guard}, fileno($lock), @command;
        die "with-node20: cannot exec guarded script: $!\n";
      }
      select undef, undef, undef, $sleep;
    }
    die "with-node20: Node 20 provisioning lock is held\n";
  ' "$script_path" "$attempts" "$lock_sleep" "$script_path" prepare "$result"
  status=$?
  [ "$status" -eq 0 ] || exit "$status"
  parse_result "$result" || fail 'invalid Node result handshake'
  rm -f -- "$result"
  result_cleanup=''
  trap - EXIT HUP INT TERM
}

run_guarded_cleanup() {
  local attempts=${PANE_DASH_TEST_LOCK_ATTEMPTS:-600} lock_sleep=${PANE_DASH_TEST_LOCK_SLEEP:-1}
  local perl=/usr/bin/perl script_path
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || fail 'invalid test lock attempt limit'
  [[ "$lock_sleep" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail 'invalid test lock sleep'
  [ -x "$perl" ] || fail 'required /usr/bin/perl is unavailable'
  [ "${PANE_DASH_TEST_PERL_UNSUPPORTED:-}" != 1 ] || fail 'required Perl flock capability is unavailable'
  "$perl" -MFcntl=:flock -e 'exit((defined(&LOCK_EX) && defined(&LOCK_NB)) ? 0 : 1)' || fail 'required Perl flock capability is unavailable'
  mkdir -p "$state_dir"
  script_path="$(canonical_dir "$(dirname "${BASH_SOURCE[0]}")")/$(basename "${BASH_SOURCE[0]}")"
  # shellcheck disable=SC2016 # Perl source intentionally contains $ expressions.
  "$perl" -e '
    use strict; use warnings; use Fcntl qw(:flock F_SETFD);
    my ($path, $attempts, $sleep, $script, @command) = @ARGV;
    open my $lock, q{<}, $path or die "with-node20: cannot open script lock: $!\n";
    for (my $try = 0; $try < $attempts; ++$try) {
      if (flock($lock, LOCK_EX | LOCK_NB)) {
        fcntl($lock, F_SETFD, 0) or die "with-node20: cannot inherit script lock: $!\n";
        $SIG{INT} = q{DEFAULT}; $SIG{HUP} = q{DEFAULT}; $SIG{TERM} = q{DEFAULT};
        exec {$script} $script, q{--private-guard}, fileno($lock), @command;
        die "with-node20: cannot exec guarded script: $!\n";
      }
      select undef, undef, undef, $sleep;
    }
    die "with-node20: Node 20 provisioning lock is held\n";
  ' "$script_path" "$attempts" "$lock_sleep" "$script_path" cleanup
}

if [ "${1:-}" = '--private-guard' ]; then
  guard_fd=${2:-}
  action=${3:-}
  [[ "$guard_fd" =~ ^[3-9][0-9]*$|^[3-9]$ ]] || fail 'invalid private guard invocation'
  case "$action:$#" in prepare:4|cleanup:3) ;; *) fail 'invalid private guard invocation' ;; esac
  trap finish_owned_provision EXIT
  trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
  if [ "$action" = cleanup ]; then
    if [ -e "$descriptor" ]; then
      validate_descriptor || fail 'invalid descriptor refuses cleanup'
      rm -rf -- "$descriptor_root"; rm -f -- "$descriptor"
    fi
    rmdir "$state_dir" 2>/dev/null || true
  else
    result=$4
    if ! validate_descriptor; then
      if [ -e "$descriptor" ] || [ -L "$descriptor" ]; then
        parse_safe_discard_root || fail 'invalid descriptor refuses replacement'
        rm -rf -- "$safe_discard_root"; rm -f -- "$descriptor"
      fi
      provision
      validate_descriptor || fail 'new Node descriptor failed validation'
    fi
    write_result "$result"
  fi
  trap - EXIT HUP INT TERM
  exit 0
fi

if [ "${1:-}" = '--cleanup' ]; then
  [ "$#" -eq 1 ] || fail 'usage: with-node20.sh --cleanup'
  [ -d "$state_dir" ] || exit 0
  run_guarded_cleanup
  exit 0
fi

[ "${1:-}" = '--' ] && [ "$#" -gt 1 ] || fail 'usage: with-node20.sh -- command [arg ...]'
shift
if [ "${PANE_DASH_NODE20_PREPROVIDED:-}" = 1 ]; then
  validate_tools "${NODE_20_BIN:-}" "${NPM_20_CLI:-}" || fail 'preprovided Node must be exact v20.0.0 with executable npm'
  node_directory=$(dirname "$NODE_20_BIN")
  unset MISE_DATA_DIR MISE_CACHE_DIR MISE_CONFIG_DIR MISE_GLOBAL_CONFIG_FILE MISE_SYSTEM_CONFIG_FILE MISE_DEFAULT_CONFIG_FILENAME GNUPGHOME
  export PATH="$node_directory:$PATH"
  [ "$(command -v node)" = "$NODE_20_BIN" ] || fail 'preprovided Node must lead PATH'
  exec "$@"
fi

run_guarded_prepare
node_directory=$(dirname "$result_node")
unset MISE_DATA_DIR MISE_CACHE_DIR MISE_CONFIG_DIR MISE_GLOBAL_CONFIG_FILE MISE_SYSTEM_CONFIG_FILE MISE_DEFAULT_CONFIG_FILENAME GNUPGHOME
export NODE_20_BIN="$result_node" NPM_20_CLI="$result_npm" PATH="$node_directory:$PATH"
exec "$@"
