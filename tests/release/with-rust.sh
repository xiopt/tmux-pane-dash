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
root='' toolchain_bin=''

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
  [ -x "$candidate/rustc" ] && [ -x "$candidate/cargo" ] || return 1
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
provision() {
  local bootstrap rustc cargo root_tmp
  bootstrap=${RUSTUP_BOOTSTRAP:-$(command -v rustup || true)}
  case "$bootstrap" in /*) [ -x "$bootstrap" ] || fail 'RUSTUP_BOOTSTRAP is not executable' ;; *) fail 'RUSTUP_BOOTSTRAP must be an absolute executable path' ;; esac
  root_tmp=$(mktemp -d "$tmp_prefix/tmux-pane-dash-rust.XXXXXX")
  root=$(canonical_dir "$root_tmp") || fail 'cannot canonicalize Rust root'
  valid_root "$root" || { rm -rf -- "$root_tmp"; fail 'unsafe Rust root'; }
  mkdir -p "$root/rustup" "$root/cargo" "$root/home" "$root/data" "$root/config" "$root/cache"
  env -i PATH="$(dirname "$bootstrap"):/usr/bin:/bin" HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" RUSTUP_NO_SELF_UPDATE=1 "$bootstrap" toolchain install 1.96.1 --profile minimal --no-self-update
  rustc=$(env -i PATH="$(dirname "$bootstrap"):/usr/bin:/bin" HOME="$root/home" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" "$bootstrap" which rustc --toolchain 1.96.1)
  cargo=$(env -i PATH="$(dirname "$bootstrap"):/usr/bin:/bin" HOME="$root/home" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" "$bootstrap" which cargo --toolchain 1.96.1)
  toolchain_bin=$(dirname "$rustc")
  if [ "$(dirname "$cargo")" != "$toolchain_bin" ] || ! valid_toolchain "$toolchain_bin"; then
    rm -rf -- "$root"
    fail 'Rust 1.96.1 toolchain unavailable'
  fi
  env -i PATH="$toolchain_bin:/usr/bin:/bin" HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" "$toolchain_bin/cargo" fetch --locked --manifest-path "$repo_root/pane-dash/Cargo.toml"
  (umask 077; printf 'SCHEMA=1\nROOT=%s\nTOOLCHAIN_BIN=%s\n' "$root" "$toolchain_bin" > "$descriptor.$$")
  chmod 600 "$descriptor.$$" && mv -f "$descriptor.$$" "$descriptor"
}
write_result() {
  local result=$1
  (umask 077; printf 'SCHEMA=1\nROOT=%s\nTOOLCHAIN_BIN=%s\n' "$root" "$toolchain_bin" > "$result.$$.tmp")
  chmod 600 "$result.$$.tmp" && mv -f "$result.$$.tmp" "$result"
}
locked() {
  case "$1" in
    prepare) read_descriptor || { [ ! -e "$descriptor" ] || fail 'invalid descriptor refuses replacement'; provision; }; write_result "$2" ;;
    cleanup) if [ -e "$descriptor" ]; then read_descriptor || fail 'invalid descriptor refuses cleanup'; rm -rf -- "$root"; rm -f -- "$descriptor"; fi; rmdir "$state_dir" 2>/dev/null || true ;;
    *) fail 'invalid private action' ;;
  esac
}
with_lock() {
  local action=$1 result=${2:-} script
  mkdir -p "$state_dir"
  script="$(canonical_dir "$(dirname "${BASH_SOURCE[0]}")")/$(basename "${BASH_SOURCE[0]}")"
  /usr/bin/perl -MFcntl=:flock,F_SETFD -e 'open my $f, q{<}, $ARGV[0] or die "$!\n"; flock($f, LOCK_EX) or die "$!\n"; fcntl($f, F_SETFD, 0) or die "$!\n"; exec @ARGV[1..$#ARGV] or die "$!\n"' "$script" "$script" --locked "$action" "$result"
}
if [ "${1:-}" = --locked ]; then shift; locked "$@"; exit; fi
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
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy RUSTUP_TOOLCHAIN CARGO_BUILD_TARGET CARGO_TARGET_DIR CARGO_NET_OFFLINE CARGO_HOME RUSTUP_HOME
for variable in $(env | cut -d= -f1); do case "$variable" in *_TOKEN|*_PASSWORD|*_SECRET|*_API_KEY|AWS_*|AZURE_*|CARGO_REGISTRIES_*|CARGO_REGISTRY_*|CARGO_CONFIG_*|RUSTUP_*|npm_config_*) unset "$variable" ;; esac; done
export PANE_DASH_ISOLATED_RUST_ROOT="$root" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" PATH="$toolchain_bin:${PATH:-/usr/bin:/bin}"
exec "$@"
