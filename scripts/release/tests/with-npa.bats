#!/usr/bin/env bats

make_fake_bun() {
  local bin=$1
  mkdir -p "$bin"
  cat > "$bin/bun" <<'SH'
#!/bin/sh
set -eu
test "$1" = --version && { echo 1.3.14; exit 0; }
root=
while [ "$#" -gt 0 ]; do if [ "$1" = --cwd ]; then root=$2; shift 2; continue; fi; shift; done
printf 'install\n' >> "$root/fixture.log"
mkdir -p "$root/node_modules/npm-package-arg/lib"
printf '{"name":"npm-package-arg","version":"13.0.2"}\n' > "$root/node_modules/npm-package-arg/package.json"
printf 'module.exports = function () {}\n' > "$root/node_modules/npm-package-arg/lib/npa.js"
SH
  chmod +x "$bin/bun"
}

setup() {
  repo_root="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd -P)"
  wrapper="$repo_root/tests/release/with-npa.sh"
}

@test "provisions the exact locked parser outside the checkout and exposes only its validated root" {
  run "$wrapper" -- sh -c '
    test -n "$PANE_DASH_NPA_ROOT"
    case "$PANE_DASH_NPA_ROOT" in "$PWD"/*) exit 1 ;; esac
    test -d "$PANE_DASH_NPA_ROOT/node_modules/npm-package-arg"
    test ! -e "$PWD/node_modules"
    env | grep -E "^(NPM_TOKEN|NODE_AUTH_TOKEN|GH_TOKEN|HTTPS_PROXY)=" && exit 1 || true
  '
  [ "$status" -eq 0 ]
}

@test "reuses a validated parser root across fresh processes" {
  run "$wrapper" -- sh -c 'printf "%s\n" "$PANE_DASH_NPA_ROOT"'
  [ "$status" -eq 0 ]
  first="$output"
  run "$wrapper" -- sh -c 'printf "%s\n" "$PANE_DASH_NPA_ROOT"'
  [ "$status" -eq 0 ]
  [ "$output" = "$first" ]
}

@test "cleanup is idempotent and removes the validated parser state" {
  run "$wrapper" -- sh -c 'printf "%s\n" "$PANE_DASH_NPA_ROOT"'
  [ "$status" -eq 0 ]
  root="$output"
  run "$wrapper" --cleanup
  [ "$status" -eq 0 ]
  [ ! -e "$root" ]
  run "$wrapper" --cleanup
  [ "$status" -eq 0 ]
}

@test "rejects a forged descriptor root outside the OS temporary parser namespace" {
  state="$BATS_TEST_TMPDIR/tmux-pane-dash-release-$(id -u)"
  mkdir -p "$state"
  printf 'SCHEMA=1\nROOT=%s\n' "$BATS_TEST_TMPDIR/not-npa" > "$state/npa13.env"
  chmod 600 "$state/npa13.env"
  run env TMPDIR="$BATS_TEST_TMPDIR" "$wrapper" -- true
  [ "$status" -eq 64 ]
  [[ "$output" == *"invalid descriptor"* ]]
}

@test "serializes concurrent fresh parser users through the physical script lock" {
  tmp="$BATS_TEST_TMPDIR/concurrent"
  mkdir -p "$tmp"
  env TMPDIR="$tmp" "$wrapper" -- sh -c 'sleep 1; printf "%s\n" "$PANE_DASH_NPA_ROOT"' > "$tmp/one" &
  first=$!
  env TMPDIR="$tmp" "$wrapper" -- sh -c 'printf "%s\n" "$PANE_DASH_NPA_ROOT"' > "$tmp/two" &
  second=$!
  wait "$first"
  wait "$second"
  [ "$(tail -n 1 "$tmp/one")" = "$(tail -n 1 "$tmp/two")" ]
}

@test "uses only the explicit Bun bootstrap seam for a validated fixture install" {
  tmp="$BATS_TEST_TMPDIR/npa-temp"
  bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$tmp" "$bin"
  tmp="$(cd "$tmp" && pwd -P)"
  cat > "$bin/bun" <<'SH'
#!/bin/sh
set -eu
test "$1" = --version && { echo 1.3.14; exit 0; }
root=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --cwd ]; then root=$2; shift 2; continue; fi
  shift
done
mkdir -p "$root/node_modules/npm-package-arg/lib"
printf '{"name":"npm-package-arg","version":"13.0.2"}\n' > "$root/node_modules/npm-package-arg/package.json"
printf 'module.exports = function () {}\n' > "$root/node_modules/npm-package-arg/lib/npa.js"
SH
  chmod +x "$bin/bun"
  run env TMPDIR="$tmp" BUN_BOOTSTRAP="$bin/bun" "$wrapper" -- true
  [ "$status" -eq 0 ]
}

@test "with-npa replaces a safe owned descriptor whose schema is invalid" {
  tmp="$BATS_TEST_TMPDIR/npa-temp"
  bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$tmp" "$bin"
  tmp="$(cd "$tmp" && pwd -P)"
  cat > "$bin/bun" <<'SH'
#!/bin/sh
set -eu
test "$1" = --version && { echo 1.3.14; exit 0; }
while [ "$#" -gt 0 ]; do
  if [ "$1" = --cwd ]; then root=$2; shift 2; continue; fi
  shift
done
mkdir -p "$root/node_modules/npm-package-arg/lib"
printf '{"name":"npm-package-arg","version":"13.0.2"}\n' > "$root/node_modules/npm-package-arg/package.json"
printf 'module.exports = function () {}\n' > "$root/node_modules/npm-package-arg/lib/npa.js"
SH
  chmod +x "$bin/bun"
  state="$tmp/tmux-pane-dash-release-$(id -u)"
  stale="$tmp/tmux-pane-dash-npa.stale"
  mkdir -p "$state" "$stale"
  printf 'SCHEMA=0\nROOT=%s\n' "$stale" > "$state/npa13.env"
  chmod 600 "$state/npa13.env"
  run env TMPDIR="$tmp" BUN_BOOTSTRAP="$bin/bun" "$wrapper" -- true
  [ "$status" -eq 0 ]
  [ ! -e "$stale" ]
}

@test "with-npa first and fresh reuse install exactly once without credentials or proxies" {
  tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"; mkdir -p "$tmp"; tmp="$(cd "$tmp" && pwd -P)"; make_fake_bun "$bin"
  run env TMPDIR="$tmp" BUN_BOOTSTRAP="$bin/bun" NPM_TOKEN=x HTTPS_PROXY=x npm_config_registry=x "$wrapper" -- sh -c 'test -z "${NPM_TOKEN+x}${HTTPS_PROXY+x}${npm_config_registry+x}"; printf %s "$PANE_DASH_NPA_ROOT"'
  [ "$status" -eq 0 ]; first="${output##*$'\n'}"
  run env TMPDIR="$tmp" BUN_BOOTSTRAP="$bin/bun" "$wrapper" -- sh -c 'printf %s "$PANE_DASH_NPA_ROOT"'
  [ "$status" -eq 0 ]; [ "$output" = "$first" ]; [ "$(grep -c '^install$' "$first/fixture.log")" -eq 1 ]
}

@test "with-npa eight contenders install once and execute overlapping children after unlock" {
  tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"; marks="$BATS_TEST_TMPDIR/marks"; mkdir -p "$tmp" "$marks"; tmp="$(cd "$tmp" && pwd -P)"; make_fake_bun "$bin"
  for n in 1 2 3 4 5 6 7 8; do env TMPDIR="$tmp" BUN_BOOTSTRAP="$bin/bun" MARKS="$marks" N="$n" "$wrapper" -- sh -c 'touch "$MARKS/$N"; while [ ! -e "$MARKS/release" ]; do sleep .05; done' & done
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ "$(ls "$marks" | wc -l | tr -d ' ')" -eq 8 ] && break; sleep .1; done
  [ "$(ls "$marks" | wc -l | tr -d ' ')" -eq 8 ]; touch "$marks/release"; wait
  state="$tmp/tmux-pane-dash-release-$(id -u)"; result_root="$(awk -F= '/^ROOT=/{print $2}' "$state/npa13.env")"; [ "$(grep -c '^install$' "$result_root/fixture.log")" -eq 1 ]
}

@test "with-npa rejects unsafe descriptors and reprovisions a safe invalid parser root" {
  tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"; mkdir -p "$tmp"; tmp="$(cd "$tmp" && pwd -P)"; make_fake_bun "$bin"; state="$tmp/tmux-pane-dash-release-$(id -u)"; mkdir -p "$state"
  for case_name in wrong-mode duplicate unknown outside-root descriptor-symlink; do
    rm -f "$state/npa13.env"; safe="$tmp/tmux-pane-dash-npa.$case_name"; mkdir -p "$safe"
    case "$case_name" in
      wrong-mode) printf 'SCHEMA=1\nROOT=%s\n' "$safe" > "$state/npa13.env"; chmod 644 "$state/npa13.env" ;;
      duplicate) printf 'SCHEMA=1\nROOT=%s\nROOT=%s\n' "$safe" "$safe" > "$state/npa13.env"; chmod 600 "$state/npa13.env" ;;
      unknown) printf 'SCHEMA=1\nROOT=%s\nEXTRA=x\n' "$safe" > "$state/npa13.env"; chmod 600 "$state/npa13.env" ;;
      outside-root) printf 'SCHEMA=1\nROOT=%s\n' "$BATS_TEST_TMPDIR/outside" > "$state/npa13.env"; chmod 600 "$state/npa13.env" ;;
      descriptor-symlink) printf 'SCHEMA=1\nROOT=%s\n' "$safe" > "$state/target"; ln -s "$state/target" "$state/npa13.env" ;;
    esac
    run env TMPDIR="$tmp" BUN_BOOTSTRAP="$bin/bun" "$wrapper" -- true; [ "$status" -eq 64 ]
  done
  rm -f "$state/npa13.env"; safe="$tmp/tmux-pane-dash-npa.invalid"; mkdir -p "$safe/node_modules/npm-package-arg/lib"; printf '{"version":"0.0.0"}\n' > "$safe/node_modules/npm-package-arg/package.json"; : > "$safe/node_modules/npm-package-arg/lib/npa.js"; printf 'SCHEMA=1\nROOT=%s\n' "$safe" > "$state/npa13.env"; chmod 600 "$state/npa13.env"
  run env TMPDIR="$tmp" BUN_BOOTSTRAP="$bin/bun" "$wrapper" -- true; [ "$status" -eq 0 ]; [ ! -e "$safe" ]
}

@test "with-npa forwards child status and cleanup is idempotent while preserving a sentinel" {
  tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"; mkdir -p "$tmp"; tmp="$(cd "$tmp" && pwd -P)"; make_fake_bun "$bin"
  run env TMPDIR="$tmp" BUN_BOOTSTRAP="$bin/bun" "$wrapper" -- sh -c 'exit 42'; [ "$status" -eq 42 ]
  run env TMPDIR="$tmp" BUN_BOOTSTRAP="$bin/bun" "$wrapper" -- sh -c 'kill -TERM $$'; [ "$status" -eq 143 ]
  state="$tmp/tmux-pane-dash-release-$(id -u)"; : > "$state/sentinel"
  run env TMPDIR="$tmp" "$wrapper" --cleanup; [ "$status" -eq 0 ]; [ -e "$state/sentinel" ]
  run env TMPDIR="$tmp" "$wrapper" --cleanup; [ "$status" -eq 0 ]; [ -e "$state/sentinel" ]
}
