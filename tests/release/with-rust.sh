#!/usr/bin/env bash
# Provision/reuse Rust 1.96.1 only under a validated OS-temporary root.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
state_dir="$repo_root/.cortexkit/v0.1-release"
descriptor="$state_dir/rust1.96.1.env"
fail() { printf 'with-rust: %s\n' "$*" >&2; exit 64; }
canonical_dir() { (cd "$1" && pwd -P); }
mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
uid() { stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1"; }
tmp_prefix=$(canonical_dir "${TMPDIR:-/tmp}") || fail 'TMPDIR must exist'

root='' toolchain_bin=''
valid_root() {
  case "$1" in "$tmp_prefix"/tmux-pane-dash-rust.*) ;; *) return 1 ;; esac
  [ -d "$1" ] && [ ! -L "$1" ] && [ "$(canonical_dir "$1")" = "$1" ] && [ "$1" != "$repo_root" ]
}
read_descriptor() {
  root='' toolchain_bin=''; [ -f "$descriptor" ] && [ ! -L "$descriptor" ] || return 1
  [ "$(mode "$descriptor")" = 600 ] && [ "$(uid "$descriptor")" = "$(id -u)" ] || return 1
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in SCHEMA) [ "$value" = 1 ] || return 1 ;; ROOT) [ -z "$root" ] || return 1; root=$value ;; TOOLCHAIN_BIN) [ -z "$toolchain_bin" ] || return 1; toolchain_bin=$value ;; *) return 1 ;; esac
  done < "$descriptor"
  valid_root "$root" && case "$toolchain_bin" in "$root"/rustup/toolchains/*/bin) [ -x "$toolchain_bin/cargo" ] && [ -x "$toolchain_bin/rustc" ] ;; *) return 1 ;; esac
}
with_lock() {
  local action=$1; shift
  mkdir -p "$state_dir"
  /usr/bin/perl -MFcntl=:flock -e 'open my $f, q{<}, $ARGV[0] or die "$!\n"; flock($f, LOCK_EX) or die "$!\n"; exec @ARGV[1..$#ARGV] or die "$!\n"' "$0" "$0" --locked "$action" "$@"
}
provision() {
  local bootstrap
  bootstrap=${RUSTUP_BOOTSTRAP:-$(command -v rustup || true)}
  case "$bootstrap" in /*) [ -x "$bootstrap" ] || fail 'RUSTUP_BOOTSTRAP is not executable' ;; *) fail 'RUSTUP_BOOTSTRAP must be an absolute executable path' ;; esac
  root=$(mktemp -d "$tmp_prefix/tmux-pane-dash-rust.XXXXXX"); root=$(canonical_dir "$root") || fail 'cannot canonicalize Rust root'
  valid_root "$root" || fail 'unsafe Rust root'
  mkdir -p "$root/home" "$root/data" "$root/config" "$root/cache" "$root/rustup" "$root/cargo"
  env -i PATH="$(dirname "$bootstrap"):/usr/bin:/bin" HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" RUSTUP_NO_SELF_UPDATE=1 "$bootstrap" toolchain install 1.96.1 --profile minimal --no-self-update
  toolchain_bin="$(find "$root/rustup/toolchains" -path '*/bin/cargo' -print | head -n 1 | xargs dirname)"
  [ -x "$toolchain_bin/cargo" ] && [ -x "$toolchain_bin/rustc" ] || { rm -rf "$root"; fail 'Rust 1.96.1 toolchain unavailable'; }
  env -i PATH="$toolchain_bin:/usr/bin:/bin" HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" cargo fetch --locked --manifest-path "$repo_root/pane-dash/Cargo.toml"
  (umask 077; printf 'SCHEMA=1\nROOT=%s\nTOOLCHAIN_BIN=%s\n' "$root" "$toolchain_bin" > "$descriptor.$$")
  chmod 600 "$descriptor.$$"; mv -f "$descriptor.$$" "$descriptor"
}
locked() {
  case "$1" in
    cleanup) if [ -e "$descriptor" ]; then read_descriptor || fail 'invalid descriptor refuses cleanup'; rm -rf -- "$root"; rm -f -- "$descriptor"; fi; rmdir "$state_dir" 2>/dev/null || true ;;
    run) read_descriptor || { [ ! -e "$descriptor" ] || fail 'invalid descriptor refuses replacement'; provision; }; shift; env -i PATH="$toolchain_bin:/usr/bin:/bin" HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" RUSTUP_HOME="$root/rustup" CARGO_HOME="$root/cargo" "$@" ;;
    *) fail 'invalid lock action' ;;
  esac
}
if [ "${1:-}" = --locked ]; then shift; locked "$@"; exit; fi
if [ "${1:-}" = --cleanup ]; then [ "$#" = 1 ] || fail 'usage: with-rust.sh --cleanup'; [ -d "$state_dir" ] || exit 0; with_lock cleanup; exit; fi
[ "${1:-}" = -- ] && [ "$#" -gt 1 ] || fail 'usage: with-rust.sh -- command [arg ...]'
shift; with_lock run "$@"
