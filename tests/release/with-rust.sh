#!/usr/bin/env bash
# Provision/reuse Rust 1.96.1 in a locked OS-temporary root.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
fail() { printf 'with-rust: %s\n' "$*" >&2; exit 64; }
canonical_dir() { (cd "$1" && pwd -P); }
stat_mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
stat_uid() { stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1"; }
tmp_prefix=$(canonical_dir "${TMPDIR:-/tmp}") || fail 'TMPDIR must exist'
for forbidden in "$repo_root" "${HOME:-}" "${XDG_DATA_HOME:-}" "${XDG_CONFIG_HOME:-}" "${XDG_CACHE_HOME:-}"; do
  [ -n "$forbidden" ] && [ -e "$forbidden" ] || continue
  forbidden=$(canonical_dir "$forbidden") || fail 'cannot canonicalize ambient directory'
  case "$tmp_prefix" in "$forbidden"|"$forbidden"/*) fail 'OS temporary root must be outside repository and ambient state' ;; esac
done
state_dir="$tmp_prefix/tmux-pane-dash-release-$(id -u)"
descriptor="$state_dir/rust1.96.1.env"
root='' toolchain_bin='' guard_fd='' incomplete_root='' install_pgid='' incomplete_descriptor_temp=''

path_under() { [ "$1" = "$2" ] || [[ "$1" == "$2/"* ]]; }
valid_root() {
  local candidate=$1
  case "$candidate" in "$tmp_prefix"/tmux-pane-dash-rust.*) ;; *) return 1 ;; esac
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(canonical_dir "$candidate")" = "$candidate" ] || return 1
  [ "$(stat_uid "$candidate")" = "$(id -u)" ] && path_under "$candidate" "$tmp_prefix"
}
valid_toolchain() {
  local candidate=$1 part path
  valid_root "$root" || return 1
  case "$candidate" in "$root"/rustup/toolchains/*/bin) ;; *) return 1 ;; esac
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  path="$root"
  IFS=/ read -r -a parts <<< "${candidate#"$root"/}"
  for part in "${parts[@]}"; do path="$path/$part"; [ ! -L "$path" ] || return 1; done
  [ -x "$candidate/rustc" ] && [ -x "$candidate/cargo" ] && [ -x "$candidate/rustdoc" ] && [ -x "$candidate/cargo-clippy" ] && [ -x "$candidate/clippy-driver" ] && [ -x "$candidate/rustfmt" ] || return 1
  [ "$("$candidate/rustc" --version 2>/dev/null)" = "rustc 1.96.1 (31fca3adb 2026-06-26)" ] || return 1
  "$candidate/cargo" --version 2>/dev/null | grep -Eq '^cargo 1\.96\.1 \(' || return 1
}
read_descriptor() {
  local key value count=0
  root='' toolchain_bin=''
  [ -f "$descriptor" ] && [ ! -L "$descriptor" ] || return 1
  [ "$(stat_mode "$descriptor")" = 600 ] && [ "$(stat_uid "$descriptor")" = "$(id -u)" ] || return 1
  while IFS='=' read -r key value || [ -n "$key" ]; do
    count=$((count + 1))
    case "$key" in SCHEMA) [ "$value" = 1 ] || return 1 ;; ROOT) [ -z "$root" ] || return 1; root=$value ;; TOOLCHAIN_BIN) [ -z "$toolchain_bin" ] || return 1; toolchain_bin=$value ;; *) return 1 ;; esac
  done < "$descriptor"
  [ "$count" -eq 3 ] && valid_toolchain "$toolchain_bin"
}
parse_safe_discard_root() {
  local key value count=0 schema_seen=0 root_seen=0 toolchain_seen=0 candidate=''
  [ -f "$descriptor" ] && [ ! -L "$descriptor" ] || return 1
  [ "$(stat_mode "$descriptor")" = 600 ] && [ "$(stat_uid "$descriptor")" = "$(id -u)" ] || return 1
  while IFS='=' read -r key value || [ -n "$key" ]; do
    count=$((count + 1))
    case "$key" in
      SCHEMA) [ "$schema_seen" -eq 0 ] || return 1; schema_seen=1 ;;
      ROOT) [ "$root_seen" -eq 0 ] || return 1; root_seen=1; candidate=$value ;;
      TOOLCHAIN_BIN) [ "$toolchain_seen" -eq 0 ] || return 1; toolchain_seen=1 ;;
      *) return 1 ;;
    esac
  done < "$descriptor"
  [ "$count" -eq 3 ] && [ "$schema_seen" -eq 1 ] && [ "$root_seen" -eq 1 ] && [ "$toolchain_seen" -eq 1 ] && valid_root "$candidate" && root=$candidate
}
provision() {
  local bootstrap rustc cargo root_tmp
  bootstrap=${RUSTUP_BOOTSTRAP:-$(command -v rustup || true)}
  case "$bootstrap" in /*) [ -x "$bootstrap" ] || fail 'RUSTUP_BOOTSTRAP is not executable' ;; *) fail 'RUSTUP_BOOTSTRAP must be an absolute executable path' ;; esac
  root_tmp=$(mktemp -d "$tmp_prefix/tmux-pane-dash-rust.XXXXXX")
  root=$(canonical_dir "$root_tmp") || fail 'cannot canonicalize Rust root'
  valid_root "$root" || { rm -rf -- "$root_tmp"; fail 'unsafe Rust root'; }
  mkdir -p "$root/rustup" "$root/cargo" "$root/home" "$root/data" "$root/config" "$root/cache"
  incomplete_root=$root
  run_owned env -i PATH="$(dirname "$bootstrap"):/usr/bin:/bin" HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" RUSTUP_NO_SELF_UPDATE=1 "$bootstrap" toolchain install 1.96.1 --profile minimal --component clippy --component rustfmt --no-self-update || fail 'Rust 1.96.1 installation failed'
  rustc=$(run_owned env -i PATH="$(dirname "$bootstrap"):/usr/bin:/bin" HOME="$root/home" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" "$bootstrap" which rustc --toolchain 1.96.1) || fail 'Rust 1.96.1 rustc path unavailable'
  cargo=$(run_owned env -i PATH="$(dirname "$bootstrap"):/usr/bin:/bin" HOME="$root/home" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" "$bootstrap" which cargo --toolchain 1.96.1) || fail 'Rust 1.96.1 cargo path unavailable'
  toolchain_bin=$(dirname "$rustc")
  if [ "$(dirname "$cargo")" != "$toolchain_bin" ] || ! valid_toolchain "$toolchain_bin"; then
    rm -rf -- "$root"
    fail 'Rust 1.96.1 toolchain unavailable'
  fi
  run_owned env -i PATH="$toolchain_bin:/usr/bin:/bin" HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" "$toolchain_bin/cargo" fetch --locked --manifest-path "$repo_root/pane-dash/Cargo.toml" || fail 'Rust dependency fetch failed'
  incomplete_descriptor_temp="$descriptor.$$"
  (umask 077; printf 'SCHEMA=1\nROOT=%s\nTOOLCHAIN_BIN=%s\n' "$root" "$toolchain_bin" > "$incomplete_descriptor_temp")
  chmod 600 "$incomplete_descriptor_temp" && mv -f "$incomplete_descriptor_temp" "$descriptor"
  incomplete_descriptor_temp='' incomplete_root=''
}
write_result() {
  local result=$1
  (umask 077; printf 'SCHEMA=1\nROOT=%s\nTOOLCHAIN_BIN=%s\n' "$root" "$toolchain_bin" > "$result.$$.tmp")
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
if [ "${1:-}" = --cleanup ]; then [ "$#" -eq 1 ] || fail 'usage: with-rust.sh --cleanup'; [ -d "$state_dir" ] || exit 0; with_lock cleanup; exit; fi
[ "${1:-}" = -- ] && [ "$#" -gt 1 ] || fail 'usage: with-rust.sh -- command [arg ...]'
shift
mkdir -p "$state_dir"
result=$(mktemp "$state_dir/.rust.result.XXXXXX")
chmod 600 "$result"
trap 'rm -f -- "$result"' EXIT HUP INT TERM
with_lock prepare "$result"
root=''; toolchain_bin=''; descriptor="$result"
read_descriptor || fail 'invalid Rust result handshake'
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
    AWS_*|aws_*|AZURE_*|azure_*|GOOGLE_*|google_*|GCP_*|gcp_*|OCI_*|VAULT_*|\
    CARGO_REGISTRIES_*|CARGO_REGISTRY_*|CARGO_CONFIG_*|RUSTUP_*|CARGO_TARGET_*_LINKER|CARGO_TARGET_*_RUSTFLAGS)
      unset "$variable"
      ;;
  esac
done
export PANE_DASH_ISOLATED_RUST_ROOT="$root" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo"
export CARGO="$toolchain_bin/cargo" RUSTC="$toolchain_bin/rustc" RUSTDOC="$toolchain_bin/rustdoc" RUSTFMT="$toolchain_bin/rustfmt" CLIPPY_DRIVER="$toolchain_bin/clippy-driver"
export PATH="$toolchain_bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$@"
