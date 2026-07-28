#!/usr/bin/env bash
# Provision the minimum tmux runtime required by clean-room CI jobs.
set -euo pipefail

readonly TMUX_URL='https://github.com/tmux/tmux/releases/download/3.6a/tmux-3.6a.tar.gz'
readonly TMUX_SHA256='b6d8d9c76585db8ef5fa00d4931902fa4b8cbe8166f528f44fc403961a3f3759'

fail() {
  printf 'ci-tmux: %s\n' "$*" >&2
  exit 64
}

absolute_path() {
  local candidate=$1 directory
  case "$candidate" in
    /*) ;;
    *) candidate=$(command -v "$candidate" 2>/dev/null || true) ;;
  esac
  [ -n "$candidate" ] && [ -x "$candidate" ] || return 1
  directory=$(cd "$(dirname "$candidate")" && pwd -P) || return 1
  printf '%s/%s\n' "$directory" "$(basename "$candidate")"
}

version_at_least_3_6() {
  local candidate=$1 version major minor
  version=$("$candidate" -V 2>/dev/null || true)
  [[ "$version" =~ ^tmux[[:space:]]+([0-9]+)\.([0-9]+) ]] || return 1
  major=${BASH_REMATCH[1]}
  minor=${BASH_REMATCH[2]}
  ((major > 3 || (major == 3 && minor >= 6)))
}

candidate=${TMUX_BIN:-}
if [ -z "$candidate" ]; then
  candidate=$(command -v tmux 2>/dev/null || true)
fi
if [ -n "$candidate" ]; then
  candidate=$(absolute_path "$candidate" 2>/dev/null || true)
  if [ -n "$candidate" ] && version_at_least_3_6 "$candidate"; then
    printf '%s\n' "$candidate"
    exit 0
  fi
fi

runner_temp=${RUNNER_TEMP:-}
case "$runner_temp" in
  /*) ;;
  *) fail 'RUNNER_TEMP must be an absolute directory' ;;
esac
[ -d "$runner_temp" ] || fail "RUNNER_TEMP does not exist: $runner_temp"
runner_temp=$(cd "$runner_temp" && pwd -P) || fail 'RUNNER_TEMP cannot be canonicalized'

build_root=$(mktemp -d "$runner_temp/tmux-3.6a.XXXXXX") || fail 'cannot create CI build directory'
install_root=$(mktemp -d "$runner_temp/tmux-3.6a-install.XXXXXX") || fail 'cannot create CI install directory'
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  rm -rf -- "$build_root"
  exit "$status"
}
trap cleanup EXIT
mkdir -p "$build_root/home" "$build_root/tmp" "$build_root/src"

if command -v apt-get >/dev/null 2>&1; then
  if [ "$(id -u)" -eq 0 ]; then
    apt=(apt-get)
  else
    apt=(sudo apt-get)
  fi
  "${apt[@]}" update >&2
  "${apt[@]}" install -y build-essential pkg-config libevent-dev libncurses-dev >&2
elif command -v brew >/dev/null 2>&1; then
  brew install libevent ncurses pkg-config >&2
  event_prefix=$(brew --prefix libevent)
  ncurses_prefix=$(brew --prefix ncurses)
  export CPPFLAGS="-I$event_prefix/include -I$ncurses_prefix/include ${CPPFLAGS:-}"
  export LDFLAGS="-L$event_prefix/lib -L$ncurses_prefix/lib ${LDFLAGS:-}"
  export PKG_CONFIG_PATH="$event_prefix/lib/pkgconfig:$ncurses_prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
else
  fail 'CI tmux build requires apt-get or brew'
fi

archive="$build_root/tmux-3.6a.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$TMUX_URL" --output "$archive"
if command -v shasum >/dev/null 2>&1; then
  actual_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
else
  actual_sha=$(sha256sum "$archive" | awk '{print $1}')
fi
[ "$actual_sha" = "$TMUX_SHA256" ] || fail "tmux source checksum mismatch: $actual_sha"

tar -xzf "$archive" -C "$build_root/src" >&2
source_dir="$build_root/src/tmux-3.6a"
[ -d "$source_dir" ] || fail 'tmux source archive has an unexpected root'
(
  cd -- "$source_dir"
  env HOME="$build_root/home" TMPDIR="$build_root/tmp" ./configure --prefix="$install_root" >&2
)
jobs=2
if command -v getconf >/dev/null 2>&1; then
  jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '2')
elif command -v sysctl >/dev/null 2>&1; then
  jobs=$(sysctl -n hw.ncpu 2>/dev/null || printf '2')
fi
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || jobs=2
env HOME="$build_root/home" TMPDIR="$build_root/tmp" make -C "$source_dir" -j"$jobs" >&2
env HOME="$build_root/home" TMPDIR="$build_root/tmp" make -C "$source_dir" install >&2

tmux_bin="$install_root/bin/tmux"
[ -x "$tmux_bin" ] || fail 'tmux build did not produce an executable'
[ "$($tmux_bin -V)" = 'tmux 3.6a' ] || fail 'built tmux is not exactly 3.6a'
printf '%s\n' "$tmux_bin"
