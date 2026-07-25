#!/usr/bin/env bats

setup() {
  repo_root="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd -P)"
  ambient="$BATS_TEST_TMPDIR/ambient"
  mkdir -p "$ambient/home" "$ambient/xdg" "$ambient/cache" "$ambient/npm" "$ambient/bun" "$ambient/tmux"
  printf 'unchanged\n' > "$ambient/home/sentinel"
  fake_tmux="$BATS_TEST_TMPDIR/tmux"
  printf '#!/bin/sh\nprintf "tmux 3.7\\n"\n' > "$fake_tmux"
  chmod +x "$fake_tmux"
  export TMUX_BIN="$fake_tmux"
}

@test "requires a command after --" {
  run "$repo_root/scripts/release/clean-room.sh" --
  [ "$status" -eq 64 ]
  [[ "$output" == *"command required"* ]]
}

@test "isolates synthetic ambient state and removes its root" {
  observed="$BATS_TEST_TMPDIR/observed"
  run env \
    HOME="$ambient/home" \
    XDG_DATA_HOME="$ambient/xdg" \
    XDG_CONFIG_HOME="$ambient/config" \
    XDG_CACHE_HOME="$ambient/cache" \
    npm_config_cache="$ambient/npm" \
    BUN_INSTALL_CACHE_DIR="$ambient/bun" \
    TMUX="${ambient}/tmux/default,1,0" \
    OBSERVED="$observed" \
    "$repo_root/scripts/release/clean-room.sh" -- sh -c 'printf "%s\\n%s\\n%s\\n" "$HOME" "$XDG_DATA_HOME" "${TMUX-unset}" > "$OBSERVED"'
  [ "$status" -eq 0 ]
  [ "$(sed -n '1p' "$observed")" != "$ambient/home" ]
  [ "$(sed -n '2p' "$observed")" != "$ambient/xdg" ]
  [ "$(sed -n '3p' "$observed")" = "unset" ]
  [ "$(cat "$ambient/home/sentinel")" = "unchanged" ]
  root="$(dirname "$(sed -n '1p' "$observed")")"
  [ ! -e "$root" ]
}

@test "rejects a nonabsolute pinned tool path" {
  run env TMUX_BIN=tmux "$repo_root/scripts/release/clean-room.sh" -- true
  [ "$status" -eq 64 ]
  [[ "$output" == *"absolute executable"* ]]
}

@test "requires an absolute tmux binary for every clean-room command" {
  run env -u TMUX_BIN "$repo_root/scripts/release/clean-room.sh" -- true
  [ "$status" -eq 64 ]
  [[ "$output" == *"TMUX_BIN required"* ]]
}

@test "preserves only absolute pinned tool paths" {
  fake="$BATS_TEST_TMPDIR/opencode"
  printf '#!/bin/sh\nexit 0\n' > "$fake"
  chmod +x "$fake"
  run env OPENCODE_1_17_20_BIN="$fake" "$repo_root/scripts/release/clean-room.sh" -- sh -c 'test "$OPENCODE_1_17_20_BIN" = "$EXPECTED"'
  [ "$status" -eq 1 ]
  run env EXPECTED="$fake" OPENCODE_1_17_20_BIN="$fake" "$repo_root/scripts/release/clean-room.sh" -- sh -c 'test "$OPENCODE_1_17_20_BIN" = "$EXPECTED"'
  [ "$status" -eq 0 ]
}

@test "uses a short unique tmux socket name for macOS unix-socket limits" {
  run "$repo_root/scripts/release/clean-room.sh" -- sh -c 'case "$PANE_DASH_TMUX_SOCKET" in pd-????????) [ "${#PANE_DASH_TMUX_SOCKET}" -le 11 ] ;; *) exit 1 ;; esac'
  [ "$status" -eq 0 ]
}

@test "removes ambient Rust state when replacing HOME" {
  mkdir -p "$ambient/home/.rustup" "$ambient/home/.cargo"
  run env -u RUSTUP_HOME -u CARGO_HOME \
    HOME="$ambient/home" \
    "$repo_root/scripts/release/clean-room.sh" -- sh -c 'test -z "${RUSTUP_HOME+x}" && test -z "${CARGO_HOME+x}"'
  [ "$status" -eq 0 ]
}

@test "rejects an explicit invalid isolated Rust root instead of preserving it" {
  run env PANE_DASH_ISOLATED_RUST_ROOT="$ambient/home" RUSTUP_HOME="$ambient/home/rustup" CARGO_HOME="$ambient/home/cargo" "$repo_root/scripts/release/clean-room.sh" -- true
  [ "$status" -eq 64 ]
  [[ "$output" == *"isolated Rust state"* ]]
}

@test "strips ambient credential, registry, and proxy variables" {
  observed="$BATS_TEST_TMPDIR/observed"
  run env OBSERVED="$observed" GH_TOKEN=sentinel NPM_TOKEN=sentinel SERVICE_PASSWORD=sentinel SERVICE_SECRET=sentinel SERVICE_API_KEY=sentinel AWS_PROFILE=sentinel GOOGLE_APPLICATION_CREDENTIALS=sentinel AZURE_TOKEN=sentinel DOCKER_CONFIG=sentinel DOCKER_AUTH_CONFIG=sentinel GIT_ASKPASS=sentinel SSH_ASKPASS=sentinel SSH_ASKPASS_REQUIRE=sentinel KUBECONFIG=sentinel NETRC=sentinel NPM_CONFIG_REGISTRY=sentinel NPM_CONFIG_USERCONFIG=sentinel npm_config_registry=sentinel npm_config_userconfig=sentinel NODE_AUTH_TOKEN=sentinel YARN_NPM_AUTH_TOKEN=sentinel YARN_RC_FILENAME=sentinel SERVICE_TOKEN=sentinel service_token=sentinel SERVICE_AUTH_CONFIG=sentinel service_auth_config=sentinel CARGO_REGISTRIES_X_INDEX=sentinel HTTPS_PROXY=sentinel SSH_AUTH_SOCK=sentinel "$repo_root/scripts/release/clean-room.sh" -- sh -c 'env | grep -E "^(GH_TOKEN|NPM_TOKEN|SERVICE_|AWS_|GOOGLE_APPLICATION_CREDENTIALS|AZURE_|DOCKER_|GIT_ASKPASS|SSH_|KUBECONFIG|NETRC|NPM_CONFIG_|npm_config_|NODE_AUTH_TOKEN|YARN_|CARGO_REGISTRIES_|HTTPS_PROXY)=" > "$OBSERVED" || true; test ! -s "$OBSERVED"'
  [ "$status" -eq 0 ]
}


@test "uses and removes a short isolated TMPDIR for tmux socket consumers" {
  observed="$BATS_TEST_TMPDIR/tmpdir"
  run env OBSERVED="$observed" "$repo_root/scripts/release/clean-room.sh" -- sh -c 'printf "%s\n" "$TMPDIR" > "$OBSERVED"'
  [ "$status" -eq 0 ]
  tmpdir="$(cat "$observed")"
  [[ "$(basename "$tmpdir")" == pd-tmp.* ]]
  [ "${#tmpdir}" -le 32 ]
  [ ! -e "$tmpdir" ]
}

@test "terminates descendants after the command leader exits successfully" {
  observed="$BATS_TEST_TMPDIR/clean-root"
  descendant="$BATS_TEST_TMPDIR/descendant-pid"
  run env OBSERVED="$observed" DESCENDANT="$descendant" "$repo_root/scripts/release/clean-room.sh" -- sh -c 'printf "%s\n" "$HOME" > "$OBSERVED"; sh -c "trap '\''exit 0'\'' TERM; printf '%s\\n' \"\$\$\" > \"\$DESCENDANT\"; while :; do sleep 1; done" >/dev/null 2>&1 & while [ ! -e "$DESCENDANT" ]; do sleep 1; done; exit 0'
  [ "$status" -eq 0 ]
  root="$(dirname "$(cat "$observed")")"
  [ ! -e "$root" ]
  descendant_pid="$(cat "$descendant")"
  for _ in 1 2 3 4 5; do ! kill -0 "$descendant_pid" 2>/dev/null && break; sleep 1; done
  ! kill -0 "$descendant_pid" 2>/dev/null
}

@test "kills a TERM-ignoring descendant after its leader exits before cleanup" {
  for round in 1 2 3 4 5; do
    descendant="$BATS_TEST_TMPDIR/fast-exit-descendant-pid-$round"
    run env DESCENDANT="$descendant" "$repo_root/scripts/release/clean-room.sh" -- sh -c '
      sh -c '\''trap "" TERM; printf "%s\\n" "$$" > "$DESCENDANT"; while :; do sleep 1; done'\'' &
      while [ ! -s "$DESCENDANT" ]; do sleep 0.01; done
      exit 37
    '
    [ "$status" -eq 37 ]
    descendant_pid="$(cat "$descendant")"
    for _ in 1 2 3 4 5 6; do ! kill -0 "$descendant_pid" 2>/dev/null && break; sleep 1; done
    ! kill -0 "$descendant_pid" || { printf 'round=%s leaked descendant=%s\n' "$round" "$descendant_pid" >&3; false; }
  done
}
