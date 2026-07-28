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

make_fake_rustup() {
  local bin=$1
  mkdir -p "$bin"
  cat > "$bin/rustup" <<'SH'
#!/bin/sh
set -eu
root=${RUSTUP_HOME%/rustup}
case "$1" in
  toolchain)
    printf '%s\n' "$0" > "$root/bootstrap-marker"
    mkdir -p "$RUSTUP_HOME/toolchains/1.96.1/bin"
    cat > "$RUSTUP_HOME/toolchains/1.96.1/bin/rustc" <<'EOF'
#!/bin/sh
echo 'rustc 1.96.1 (31fca3adb 2026-06-26)'
EOF
    cat > "$RUSTUP_HOME/toolchains/1.96.1/bin/cargo" <<'EOF'
#!/bin/sh
case "${1:-}" in --version) echo 'cargo 1.96.1 (fixture)' ;; esac
EOF
    for tool in cargo-clippy rustfmt rustdoc clippy-driver; do printf '#!/bin/sh\nexit 0\n' > "$RUSTUP_HOME/toolchains/1.96.1/bin/$tool"; chmod +x "$RUSTUP_HOME/toolchains/1.96.1/bin/$tool"; done
    chmod +x "$RUSTUP_HOME/toolchains/1.96.1/bin/rustc" "$RUSTUP_HOME/toolchains/1.96.1/bin/cargo" ;;
  which) echo "$RUSTUP_HOME/toolchains/1.96.1/bin/$2" ;;
esac
SH
  chmod +x "$bin/rustup"
}

make_fake_bun() {
  local bin=$1
  mkdir -p "$bin"
  cat > "$bin/bun" <<'SH'
#!/bin/sh
set -eu
test "$1" = --version && { echo 1.3.14; exit 0; }
root=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --cwd ]; then root=$2; shift 2; continue; fi
  shift
done
printf '%s\n' "$0" > "$root/bootstrap-marker"
mkdir -p "$root/node_modules/npm-package-arg/lib"
printf '{"name":"npm-package-arg","version":"13.0.2"}\n' > "$root/node_modules/npm-package-arg/package.json"
printf 'module.exports = function () {}\n' > "$root/node_modules/npm-package-arg/lib/npa.js"
SH
  chmod +x "$bin/bun"
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

@test "preserves validated bootstrap executables for nested isolated wrappers" {
  tmp="$BATS_TEST_TMPDIR/tmp"
  bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$tmp"
  tmp="$(cd "$tmp" && pwd -P)"
  make_fake_rustup "$bin"
  make_fake_bun "$bin"
  run env \
    TMPDIR="$tmp" \
    REPO_ROOT="$repo_root" \
    EXPECTED_RUSTUP="$bin/rustup" \
    EXPECTED_BUN="$bin/bun" \
    RUSTUP_BOOTSTRAP="$bin/rustup" \
    BUN_BOOTSTRAP="$bin/bun" \
    BUN_INSTALL_CACHE_DIR="$ambient/bun" \
    "$repo_root/scripts/release/clean-room.sh" -- sh -c '
      test "$RUSTUP_BOOTSTRAP" = "$EXPECTED_RUSTUP"
      test "$BUN_BOOTSTRAP" = "$EXPECTED_BUN"
      test "$BUN_INSTALL_CACHE_DIR" != "'"$ambient/bun"'"
      exec "$REPO_ROOT/tests/release/with-rust.sh" -- "$REPO_ROOT/tests/release/with-npa.sh" -- sh -c '\''
        test "$(cat "$PANE_DASH_ISOLATED_RUST_ROOT/rustup/bootstrap-marker")" = "$EXPECTED_RUSTUP"
        test "$(cat "$PANE_DASH_NPA_ROOT/bootstrap-marker")" = "$EXPECTED_BUN"
      '\''
    '
  [ "$status" -eq 0 ]
}

@test "fails closed without explicit bootstrap executables under a controlled PATH" {
  tmp="$BATS_TEST_TMPDIR/tmp"
  mkdir -p "$tmp"
  run env -u RUSTUP_BOOTSTRAP PATH=/usr/bin:/bin TMPDIR="$tmp" "$repo_root/scripts/release/clean-room.sh" -- "$repo_root/tests/release/with-rust.sh" -- true
  [ "$status" -eq 64 ]
  [[ "$output" == *"RUSTUP_BOOTSTRAP must be an absolute executable path"* ]]
  run env -u BUN_BOOTSTRAP PATH=/usr/bin:/bin TMPDIR="$tmp" "$repo_root/scripts/release/clean-room.sh" -- "$repo_root/tests/release/with-npa.sh" -- true
  [ "$status" -eq 64 ]
  [[ "$output" == *"BUN_BOOTSTRAP must be an absolute executable path"* ]]
}

@test "rejects relative and nonexecutable bootstrap paths before sanitization" {
  nonexecutable="$BATS_TEST_TMPDIR/nonexecutable"
  : > "$nonexecutable"
  for bootstrap in RUSTUP_BOOTSTRAP BUN_BOOTSTRAP; do
    run env "$bootstrap=relative" "$repo_root/scripts/release/clean-room.sh" -- true
    [ "$status" -eq 64 ]
    [[ "$output" == *"$bootstrap must be an absolute executable path"* ]]
    run env "$bootstrap=$nonexecutable" "$repo_root/scripts/release/clean-room.sh" -- true
    [ "$status" -eq 64 ]
    [[ "$output" == *"$bootstrap is not executable"* ]]
  done
}

@test "requires the pinned Bun bootstrap version before preserving it" {
  bun="$BATS_TEST_TMPDIR/bun"
  printf '#!/bin/sh\nprintf "1.3.13\\n"\n' > "$bun"
  chmod +x "$bun"

  run env BUN_BOOTSTRAP="$bun" "$repo_root/scripts/release/clean-room.sh" -- true
  [ "$status" -eq 64 ]
  [[ "$output" == *"BUN_BOOTSTRAP must be an exact Bun 1.3.14 executable"* ]]
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

@test "accepts valid isolated roots outside HOME and XDG state and rejects forbidden roots" {
  run env PANE_DASH_ISOLATED_RUST_ROOT="$ambient/home" RUSTUP_HOME="$ambient/home/rustup" CARGO_HOME="$ambient/home/cargo" "$repo_root/scripts/release/clean-room.sh" -- true
  [ "$status" -eq 64 ]
  [[ "$output" == *"isolated Rust state"* ]]

  tmp="$BATS_TEST_TMPDIR/tmp"
  mkdir -p "$tmp"
  tmp="$(cd "$tmp" && pwd -P)"
  ambient_root="$(cd "$ambient" && pwd -P)"
  valid="$tmp/isolated"
  mkdir -p "$valid/node_modules/npm-package-arg" "$ambient_root/home" "$ambient_root/xdg-data" "$ambient_root/xdg-config" "$ambient_root/xdg-cache"
  printf '{}\n' > "$valid/node_modules/npm-package-arg/package.json"

  run env \
    HOME="$ambient_root/home" \
    XDG_DATA_HOME="$ambient_root/xdg-data" \
    XDG_CONFIG_HOME="$ambient_root/xdg-config" \
    XDG_CACHE_HOME="$ambient_root/xdg-cache" \
    PANE_DASH_NPA_ROOT="$valid" \
    PANE_DASH_NPA_TMP_PREFIX="$tmp" \
    "$repo_root/scripts/release/clean-room.sh" -- true
  [ "$status" -eq 0 ]

  for forbidden in "$ambient_root/home" "$ambient_root/xdg-data" "$ambient_root/xdg-config" "$ambient_root/xdg-cache"; do
    root="$forbidden/isolated"
    mkdir -p "$root/node_modules/npm-package-arg"
    printf '{}\n' > "$root/node_modules/npm-package-arg/package.json"
    run env \
      HOME="$ambient_root/home" \
      XDG_DATA_HOME="$ambient_root/xdg-data" \
      XDG_CONFIG_HOME="$ambient_root/xdg-config" \
      XDG_CACHE_HOME="$ambient_root/xdg-cache" \
      PANE_DASH_NPA_ROOT="$root" \
      PANE_DASH_NPA_TMP_PREFIX="$forbidden" \
      "$repo_root/scripts/release/clean-room.sh" -- true
    [ "$status" -eq 64 ]
    [[ "$output" == *"invalid isolated NPA state"* ]]
  done
}

@test "strips ambient credential, registry, and proxy variables" {
  observed="$BATS_TEST_TMPDIR/observed"
  run env OBSERVED="$observed" GH_TOKEN=sentinel NPM_TOKEN=sentinel SERVICE_PASSWORD=sentinel SERVICE_SECRET=sentinel SERVICE_API_KEY=sentinel AWS_PROFILE=sentinel GOOGLE_APPLICATION_CREDENTIALS=sentinel AZURE_TOKEN=sentinel DOCKER_CONFIG=sentinel DOCKER_AUTH_CONFIG=sentinel GIT_ASKPASS=sentinel SSH_ASKPASS=sentinel SSH_ASKPASS_REQUIRE=sentinel KUBECONFIG=sentinel NETRC=sentinel NPM_CONFIG_REGISTRY=sentinel NPM_CONFIG_USERCONFIG=sentinel npm_config_registry=sentinel npm_config_userconfig=sentinel NODE_AUTH_TOKEN=sentinel YARN_NPM_AUTH_TOKEN=sentinel YARN_RC_FILENAME=sentinel SERVICE_TOKEN=sentinel service_token=sentinel SERVICE_AUTH_CONFIG=sentinel service_auth_config=sentinel CARGO_REGISTRIES_X_INDEX=sentinel HTTPS_PROXY=sentinel SSH_AUTH_SOCK=sentinel "$repo_root/scripts/release/clean-room.sh" -- sh -c 'env | grep -E "^(GH_TOKEN|NPM_TOKEN|SERVICE_|AWS_|GOOGLE_APPLICATION_CREDENTIALS|AZURE_|DOCKER_|GIT_ASKPASS|SSH_|KUBECONFIG|NETRC|NPM_CONFIG_|npm_config_|NODE_AUTH_TOKEN|YARN_|CARGO_REGISTRIES_|HTTPS_PROXY)=" > "$OBSERVED" || true; test ! -s "$OBSERVED"'
  [ "$status" -eq 0 ]
}

@test "strips ambient Node, TLS, and Git configuration while restoring only the pinned Node binary" {
  node="$BATS_TEST_TMPDIR/node20"
  printf '#!/bin/sh\nexit 0\n' > "$node"
  chmod +x "$node"
  run env \
    EXPECTED_NODE="$node" NODE_20_BIN="$node" NODE_OPTIONS=sentinel NODE_PATH=sentinel NODE_EXTRA_CA_CERTS=sentinel NODE_REPL_HISTORY=sentinel NODE_CONFIG=sentinel node_config=sentinel \
    SSL_CERT_FILE=sentinel SSL_CERT_DIR=sentinel CURL_CA_BUNDLE=sentinel REQUESTS_CA_BUNDLE=sentinel \
    GIT_CONFIG_GLOBAL=sentinel GIT_CONFIG_SYSTEM=sentinel GIT_CONFIG_NOSYSTEM=sentinel GIT_SSH=sentinel GIT_SSH_COMMAND=sentinel \
    "$repo_root/scripts/release/clean-room.sh" -- sh -c '
      test "$NODE_20_BIN" = "$EXPECTED_NODE"
      test -n "$NODE_20_BIN"
      ! env | grep -Eq "^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_REPL_HISTORY|NODE_CONFIG|node_config|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|GIT_SSH|GIT_SSH_COMMAND)="
    '
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
