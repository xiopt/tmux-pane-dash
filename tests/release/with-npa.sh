#!/usr/bin/env bash
# Provision/reuse npm-package-arg 13.0.2 in a locked OS-temporary root.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
fixture="$repo_root/scripts/release/fixtures/npm-package-arg-13"
fail() { printf 'with-npa: %s\n' "$*" >&2; exit 64; }
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

tmp_prefix=$(canonical_dir "${TMPDIR:-/tmp}") || fail 'TMPDIR must exist'
for forbidden in "$repo_root" "${HOME:-}" "${XDG_DATA_HOME:-}" "${XDG_CONFIG_HOME:-}" "${XDG_CACHE_HOME:-}"; do
  [ -n "$forbidden" ] && [ -e "$forbidden" ] || continue
  forbidden=$(canonical_dir "$forbidden") || fail 'cannot canonicalize ambient directory'
  case "$tmp_prefix" in "$forbidden"|"$forbidden"/*) fail 'OS temporary root must be outside repository and ambient state' ;; esac
done
state_dir="$tmp_prefix/tmux-pane-dash-release-$(id -u)"
descriptor="$state_dir/npa13.env"
root='' guard_fd='' incomplete_root='' install_pgid='' incomplete_descriptor_temp=''

path_under() { [ "$1" = "$2" ] || [[ "$1" == "$2/"* ]]; }
valid_root() {
  local candidate=$1
  case "$candidate" in "$tmp_prefix"/tmux-pane-dash-npa.*) ;; *) return 1 ;; esac
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(canonical_dir "$candidate")" = "$candidate" ] || return 1
  path_under "$candidate" "$tmp_prefix"
}
valid_file() {
  local file=$1 base=$2 resolved
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  resolved=$(canonical_dir "$(dirname "$file")")/$(basename "$file") || return 1
  [ "$resolved" = "$file" ] && path_under "$file" "$base"
}
validate_root() {
  local package
  valid_root "$root" || return 1
  package="$root/node_modules/npm-package-arg/package.json"
  valid_file "$package" "$root" || return 1
  [ "$(stat_mode "$package")" != 0 ] || return 1
  grep -Eq '"version"[[:space:]]*:[[:space:]]*"13\.0\.2"' "$package" || return 1
  valid_file "$root/node_modules/npm-package-arg/lib/npa.js" "$root"
}
read_descriptor() {
  local key value count=0
  root=''
  [ -f "$descriptor" ] && [ ! -L "$descriptor" ] || return 1
  [ "$(stat_mode "$descriptor")" = 600 ] && [ "$(stat_uid "$descriptor")" = "$(id -u)" ] || return 1
  while IFS='=' read -r key value || [ -n "$key" ]; do
    count=$((count + 1))
    case "$key" in SCHEMA) [ "$value" = 1 ] || return 1 ;; ROOT) [ -z "$root" ] || return 1; root=$value ;; *) return 1 ;; esac
  done < "$descriptor"
  [ "$count" -eq 2 ] && validate_root
}
parse_safe_discard_root() {
  local key value count=0 schema_seen=0 root_seen=0 candidate=''
  [ -f "$descriptor" ] && [ ! -L "$descriptor" ] || return 1
  [ "$(stat_mode "$descriptor")" = 600 ] && [ "$(stat_uid "$descriptor")" = "$(id -u)" ] || return 1
  while IFS='=' read -r key value || [ -n "$key" ]; do
    count=$((count + 1))
    case "$key" in
      SCHEMA) [ "$schema_seen" -eq 0 ] || return 1; schema_seen=1 ;;
      ROOT) [ "$root_seen" -eq 0 ] || return 1; root_seen=1; candidate=$value ;;
      *) return 1 ;;
    esac
  done < "$descriptor"
  [ "$count" -eq 2 ] && [ "$schema_seen" -eq 1 ] && [ "$root_seen" -eq 1 ] && valid_root "$candidate" && root=$candidate
}
provision() {
  local bun root_tmp
  bun=${BUN_BOOTSTRAP:-$(command -v bun || true)}
  case "$bun" in /*) [ -x "$bun" ] && [ "$("$bun" --version)" = 1.3.14 ] || fail 'BUN_BOOTSTRAP must be an exact Bun 1.3.14 executable' ;; *) fail 'BUN_BOOTSTRAP must be an absolute executable path' ;; esac
  root_tmp=$(mktemp -d "$tmp_prefix/tmux-pane-dash-npa.XXXXXX")
  root=$(canonical_dir "$root_tmp") || fail 'cannot canonicalize parser root'
  valid_root "$root" || { rm -rf -- "$root_tmp"; fail 'unsafe parser root'; }
  incomplete_root=$root
  mkdir -p "$root/home" "$root/data" "$root/config" "$root/cache" "$root/bun-cache"
  cp "$fixture/package.json" "$fixture/bun.lock" "$root/"
  run_owned env -i PATH="$(dirname "$bun"):/usr/bin:/bin" HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" BUN_INSTALL_CACHE_DIR="$root/bun-cache" "$bun" install --frozen-lockfile --ignore-scripts --cwd "$root" >&2 || fail 'locked npm-package-arg installation failed'
  validate_root || { rm -rf -- "$root"; fail 'locked npm-package-arg installation failed validation'; }
  incomplete_descriptor_temp="$descriptor.$$"
  (umask 077; printf 'SCHEMA=1\nROOT=%s\n' "$root" > "$incomplete_descriptor_temp")
  chmod 600 "$incomplete_descriptor_temp" && mv -f "$incomplete_descriptor_temp" "$descriptor"
  incomplete_descriptor_temp='' incomplete_root=''
}
write_result() {
  local result=$1
  (umask 077; printf 'SCHEMA=1\nROOT=%s\n' "$root" > "$result.$$.tmp")
  chmod 600 "$result.$$.tmp" && mv -f "$result.$$.tmp" "$result"
}
terminate_install_group() {
  local _ grace=${PANE_DASH_TEST_KILL_GRACE:-5}
  [ -n "$install_pgid" ] || return 0
  kill -TERM -- "-$install_pgid" 2>/dev/null || true
  [[ "$grace" =~ ^[0-9]+$ ]] || fail 'invalid test kill grace'
  for ((_=0; _<grace; _++)); do kill -0 -- "-$install_pgid" 2>/dev/null || break; sleep 1; done
  kill -KILL -- "-$install_pgid" 2>/dev/null || true
  wait "$install_pgid" 2>/dev/null || true
  install_pgid=''
}
stop_incomplete_provision() { terminate_install_group; rm -f -- "$incomplete_descriptor_temp"; rm -rf -- "$incomplete_root"; incomplete_descriptor_temp='' incomplete_root=''; }
finish_owned_provision() { local status=$?; trap - EXIT HUP INT TERM; stop_incomplete_provision; exit "$status"; }
run_owned() {
  local pid elapsed=0 timeout=${PANE_DASH_TEST_PROVISION_TIMEOUT:-600}
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || fail 'invalid test provision timeout'
  set -m
  (exec /usr/bin/perl -e 'use POSIX (); POSIX::close(shift @ARGV) or die "close guard fd: $!\n"; exec @ARGV or die "$!\n"' "$guard_fd" "$@") & pid=$!
  set +m
  install_pgid=$pid
  while kill -0 "$pid" 2>/dev/null; do [ "$elapsed" -lt "$timeout" ] || { terminate_install_group; return 124; }; sleep 1; elapsed=$((elapsed + 1)); done
  wait "$pid"; local status=$?; install_pgid=''; return "$status"
}
locked() {
  case "$1" in
    prepare)
      if ! read_descriptor; then
        if [ -e "$descriptor" ] || [ -L "$descriptor" ]; then
          parse_safe_discard_root || fail 'invalid descriptor refuses replacement'
          rm -rf -- "$root"
          rm -f -- "$descriptor"
        fi
        provision
      fi
      write_result "$2"
      ;;
    cleanup) if [ -e "$descriptor" ]; then read_descriptor || fail 'invalid descriptor refuses cleanup'; rm -rf -- "$root"; rm -f -- "$descriptor"; fi; rmdir "$state_dir" 2>/dev/null || true ;;
    *) fail 'invalid private action' ;;
  esac
}
with_lock() {
  local action=$1 result=${2:-} script
  mkdir -p "$state_dir"
  script="$(canonical_dir "$(dirname "${BASH_SOURCE[0]}")")/$(basename "${BASH_SOURCE[0]}")"
  /usr/bin/perl -MFcntl=:flock,F_SETFD -e 'open my $f, q{<}, $ARGV[0] or die "$!\n"; flock($f, LOCK_EX) or die "$!\n"; fcntl($f, F_SETFD, 0) or die "$!\n"; my $fd=fileno($f); exec $ARGV[1], q{--locked}, $fd, @ARGV[2..$#ARGV] or die "$!\n"' "$script" "$script" "$action" "$result"
}
if [ "${1:-}" = --locked ]; then
  guard_fd=${2:-}; action=${3:-}; [[ "$guard_fd" =~ ^[3-9][0-9]*$|^[3-9]$ ]] || fail 'invalid private guard invocation'
  case "$action:$#" in prepare:4|cleanup:4) ;; *) fail 'invalid private guard invocation' ;; esac
  trap finish_owned_provision EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
  locked "$action" "${4:-}"
  trap - EXIT HUP INT TERM; exit
fi
if [ "${1:-}" = --cleanup ]; then [ "$#" -eq 1 ] || fail 'usage: with-npa.sh --cleanup'; [ -d "$state_dir" ] || exit 0; with_lock cleanup; exit; fi
[ "${1:-}" = -- ] && [ "$#" -gt 1 ] || fail 'usage: with-npa.sh -- command [arg ...]'
shift
mkdir -p "$state_dir"
result=$(mktemp "$state_dir/.npa.result.XXXXXX")
chmod 600 "$result"
trap 'rm -f -- "$result"' EXIT HUP INT TERM
with_lock prepare "$result"
root=''; descriptor="$result"
read_descriptor || fail 'invalid parser result handshake'
rm -f -- "$result"; trap - EXIT HUP INT TERM
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy
unset CARGO RUSTC RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER RUSTDOC RUSTDOCFLAGS RUSTFLAGS CARGO_ENCODED_RUSTFLAGS RUSTUP_TOOLCHAIN CARGO_BUILD_TARGET CARGO_TARGET_DIR CARGO_NET_OFFLINE CARGO_HOME RUSTUP_HOME RUSTFMT CLIPPY_DRIVER CC CXX AR LD
for variable in $(env | cut -d= -f1); do
  case "$variable" in
    *_TOKEN|*_token|*_PASSWORD|*_password|*_SECRET|*_secret|*_API_KEY|*_api_key|*AUTH*|*auth*|\
    DOCKER_*|docker_*|GIT_ASKPASS|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|SSH_*|\
    GIT_CONFIG_*|git_config_*|GIT_SSH|git_ssh|GIT_SSH_COMMAND|git_ssh_command|\
    NODE_*|node_*|SSL_CERT_*|ssl_cert_*|CURL_CA_BUNDLE|curl_ca_bundle|REQUESTS_CA_BUNDLE|requests_ca_bundle|\
    NPM_CONFIG_*|npm_config_*|YARN_*|yarn_*|NETRC|KUBECONFIG|\
    AWS_*|aws_*|AZURE_*|azure_*|GOOGLE_*|google_*|GCP_*|gcp_*|OCI_*|VAULT_*|BUN_*|bun_*|CARGO_REGISTRIES_*|CARGO_REGISTRY_*|CARGO_CONFIG_*)
      unset "$variable"
      ;;
  esac
done
export PANE_DASH_NPA_ROOT="$root" PANE_DASH_NPA_TMP_PREFIX="$tmp_prefix"
exec "$@"
