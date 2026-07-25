#!/usr/bin/env bats

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
