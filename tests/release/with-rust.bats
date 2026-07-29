#!/usr/bin/env bats

make_fake_rustup() {
  local bin=$1
  mkdir -p "$bin"
  cat > "$bin/rustup" <<'SH'
#!/bin/sh
set -eu
root=${RUSTUP_HOME%/rustup}
case "$1" in
  toolchain)
    printf 'provision\n' >> "$root/fixture.log"
    mkdir -p "$RUSTUP_HOME/toolchains/1.96.1/bin"
    cat > "$RUSTUP_HOME/toolchains/1.96.1/bin/rustc" <<'EOF'
#!/bin/sh
echo 'rustc 1.96.1 (31fca3adb 2026-06-26)'
EOF
    cat > "$RUSTUP_HOME/toolchains/1.96.1/bin/cargo" <<'EOF'
#!/bin/sh
case "${1:-}" in --version) echo 'cargo 1.96.1 (fixture)' ;; fetch) printf 'fetch\n' >> "${RUSTUP_HOME%/rustup}/fixture.log" ;; esac
EOF
    for tool in cargo-clippy rustfmt rustdoc clippy-driver; do printf '#!/bin/sh\nexit 0\n' > "$RUSTUP_HOME/toolchains/1.96.1/bin/$tool"; chmod +x "$RUSTUP_HOME/toolchains/1.96.1/bin/$tool"; done
    chmod +x "$RUSTUP_HOME/toolchains/1.96.1/bin/rustc" "$RUSTUP_HOME/toolchains/1.96.1/bin/cargo" ;;
  which) echo "$RUSTUP_HOME/toolchains/1.96.1/bin/$2" ;;
esac
SH
  chmod +x "$bin/rustup"
}

make_stat_stub() {
  local bin=$1
  cat > "$bin/stat" <<'SH'
#!/bin/sh
set -eu
uid=${STAT_STUB_UID:?STAT_STUB_UID is required}
case "$STAT_STUB_MODE:$1:$2" in
  gnu-partial:-c:*)
    printf 'GNU filesystem report from failed probe\n'
    exit 1
    ;;
  gnu-partial:-f:%Lp) printf '600\n' ;;
  gnu-partial:-f:%u) printf '%s\n' "$uid" ;;
  bsd-partial:-f:*)
    printf 'GNU filesystem report from failed probe\n'
    exit 1
    ;;
  bsd-partial:-c:%a) printf '600\n' ;;
  bsd-partial:-c:%u) printf '%s\n' "$uid" ;;
  *)
    printf 'unexpected stat invocation: %s %s\n' "$1" "$2" >&2
    exit 2
    ;;
esac
SH
  chmod +x "$bin/stat"
}

@test "stat probes discard partial output and accept one exact value from either backend" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$bin"
  make_fake_rustup "$bin"
  make_stat_stub "$bin"

  for mode in gnu-partial bsd-partial; do
    tmp="$BATS_TEST_TMPDIR/$mode"
    mkdir -p "$tmp"
    tmp="$(cd "$tmp" && pwd -P)"
    run env TMPDIR="$tmp" PATH="$bin:$PATH" STAT_STUB_MODE="$mode" STAT_STUB_UID="$(id -u)" RUSTUP_BOOTSTRAP="$bin/rustup" \
      "$root/tests/release/with-rust.sh" -- sh -c 'printf "%s\n" "$PANE_DASH_ISOLATED_RUST_ROOT"'
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 ]
    [[ "$output" == "$tmp/tmux-pane-dash-rust."* ]]
  done
}

@test "with-rust rejects ambient state and provides exact isolated Rust" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  run "$root/tests/release/with-rust.sh" -- sh -c 'test "$(cargo --version | awk "{print \$2}")" = 1.96.1 && test -n "$RUSTUP_HOME" && test -n "$CARGO_HOME"'
  [ "$status" -eq 0 ]
}

@test "with-rust provides the pinned Clippy and rustfmt components" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  run "$root/tests/release/with-rust.sh" -- sh -c 'cargo-clippy --version >/dev/null && rustfmt --version >/dev/null'
  [ "$status" -eq 0 ]
}

@test "with-rust preserves caller HOME and XDG while exporting only isolated Rust state" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  home="$BATS_TEST_TMPDIR/home"
  xdg="$BATS_TEST_TMPDIR/xdg"
  mkdir -p "$home" "$xdg"
  run env HOME="$home" XDG_CONFIG_HOME="$xdg" EXPECTED_HOME="$home" EXPECTED_XDG="$xdg" "$root/tests/release/with-rust.sh" -- sh -c 'test "$HOME" = "$EXPECTED_HOME" && test "$XDG_CONFIG_HOME" = "$EXPECTED_XDG" && case "$RUSTUP_HOME:$CARGO_HOME:$PATH" in /tmp/*:/tmp/*:/tmp/*|/private/tmp/*:/private/tmp/*:/private/tmp/*|/var/folders/*:/var/folders/*:/var/folders/*|/private/var/folders/*:/private/var/folders/*:/private/var/folders/*) ;; *) exit 1 ;; esac'
  [ "$status" -eq 0 ]
}

@test "with-rust accepts only an explicit bootstrap and releases its guard before fetch" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  tmp="$BATS_TEST_TMPDIR/rust-temp"
  bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$tmp" "$bin"
  tmp="$(cd "$tmp" && pwd -P)"
  cat > "$bin/rustup" <<'SH'
#!/bin/sh
set -eu
root=$RUSTUP_HOME/..
case "$1" in
  toolchain) mkdir -p "$RUSTUP_HOME/toolchains/1.96.1/bin"; for tool in rustc cargo cargo-clippy rustfmt rustdoc clippy-driver; do cat > "$RUSTUP_HOME/toolchains/1.96.1/bin/$tool" <<EOF
#!/bin/sh
test "\${1:-}" = --version || exit 0
echo '${tool} 1.96.1 (31fca3adb 2026-06-26)'
EOF
chmod +x "$RUSTUP_HOME/toolchains/1.96.1/bin/$tool"; done ;;
  which) echo "$RUSTUP_HOME/toolchains/1.96.1/bin/$2" ;;
esac
SH
  cat > "$bin/cargo" <<'SH'
#!/bin/sh
exit 0
SH
  chmod +x "$bin/rustup" "$bin/cargo"
  run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" "$root/tests/release/with-rust.sh" -- true
  [ "$status" -eq 0 ]
}

@test "with-rust replaces a safe owned descriptor whose schema is invalid" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  tmp="$BATS_TEST_TMPDIR/rust-temp"
  bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$tmp" "$bin"
  tmp="$(cd "$tmp" && pwd -P)"
  cat > "$bin/rustup" <<'SH'
#!/bin/sh
set -eu
case "$1" in
  toolchain)
    mkdir -p "$RUSTUP_HOME/toolchains/1.96.1/bin"
    cat > "$RUSTUP_HOME/toolchains/1.96.1/bin/rustc" <<'EOF'
#!/bin/sh
echo 'rustc 1.96.1 (31fca3adb 2026-06-26)'
EOF
    cat > "$RUSTUP_HOME/toolchains/1.96.1/bin/cargo" <<'EOF'
#!/bin/sh
echo 'cargo 1.96.1 (fixture)'
EOF
    for tool in cargo-clippy rustfmt rustdoc clippy-driver; do printf '#!/bin/sh\nexit 0\n' > "$RUSTUP_HOME/toolchains/1.96.1/bin/$tool"; chmod +x "$RUSTUP_HOME/toolchains/1.96.1/bin/$tool"; done
    chmod +x "$RUSTUP_HOME/toolchains/1.96.1/bin/rustc" "$RUSTUP_HOME/toolchains/1.96.1/bin/cargo" ;;
  which) echo "$RUSTUP_HOME/toolchains/1.96.1/bin/$2" ;;
esac
SH
  chmod +x "$bin/rustup"
  state="$tmp/tmux-pane-dash-release-$(id -u)"
  stale="$tmp/tmux-pane-dash-rust.stale"
  mkdir -p "$state" "$stale"
  printf 'SCHEMA=0\nROOT=%s\nTOOLCHAIN_BIN=%s/rustup/toolchains/1.96.1/bin\n' "$stale" "$stale" > "$state/rust1.96.1.env"
  chmod 600 "$state/rust1.96.1.env"
  run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" "$root/tests/release/with-rust.sh" -- true
  [ "$status" -eq 0 ]
  [ ! -e "$stale" ]
}

@test "with-rust first and fresh reuse provision and fetch exactly once" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"; tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$tmp"; tmp="$(cd "$tmp" && pwd -P)"; make_fake_rustup "$bin"
  run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" "$root/tests/release/with-rust.sh" -- sh -c 'printf %s "$PANE_DASH_ISOLATED_RUST_ROOT"'
  [ "$status" -eq 0 ]; first="$output"
  run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" "$root/tests/release/with-rust.sh" -- sh -c 'printf %s "$PANE_DASH_ISOLATED_RUST_ROOT"'
  [ "$status" -eq 0 ]; [ "$output" = "$first" ]
  [ "$(grep -c '^provision$' "$first/fixture.log")" -eq 1 ]
  [ "$(grep -c '^fetch$' "$first/fixture.log")" -eq 1 ]
}

@test "with-rust eight contenders provision once and execute overlapping children after unlock" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"; tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"; marks="$BATS_TEST_TMPDIR/marks"
  mkdir -p "$tmp" "$marks"; tmp="$(cd "$tmp" && pwd -P)"; make_fake_rustup "$bin"
  pids=()
  for n in 1 2 3 4 5 6 7 8; do env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" MARKS="$marks" N="$n" "$root/tests/release/with-rust.sh" -- sh -c 'touch "$MARKS/$N"; while [ ! -e "$MARKS/release" ]; do sleep .05; done' & pids+=("$!"); done
  for _ in $(seq 1 100); do [ "$(ls "$marks" | wc -l | tr -d ' ')" -eq 8 ] && break; sleep .1; done
  children="$(ls "$marks" | wc -l | tr -d ' ')"
  touch "$marks/release"
  for pid in "${pids[@]}"; do wait "$pid"; done
  [ "$children" -eq 8 ]
  state="$tmp/tmux-pane-dash-release-$(id -u)"; descriptor="$state/rust1.96.1.env"; result_root="$(awk -F= '/^ROOT=/{print $2}' "$descriptor")"
  [ "$(grep -c '^provision$' "$result_root/fixture.log")" -eq 1 ]
}

@test "with-rust rejects unsafe descriptors but reprovisions safe invalid toolchains" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"; tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"; state="$BATS_TEST_TMPDIR/state"
  mkdir -p "$tmp" "$state"; tmp="$(cd "$tmp" && pwd -P)"; make_fake_rustup "$bin"; state="$tmp/tmux-pane-dash-release-$(id -u)"; mkdir -p "$state"
  for case_name in wrong-mode duplicate unknown outside-root descriptor-symlink; do
    rm -f "$state/rust1.96.1.env"; safe="$tmp/tmux-pane-dash-rust.$case_name"; mkdir -p "$safe"
    case "$case_name" in
      wrong-mode) printf 'SCHEMA=1\nROOT=%s\nTOOLCHAIN_BIN=%s/x\n' "$safe" "$safe" > "$state/rust1.96.1.env"; chmod 644 "$state/rust1.96.1.env" ;;
      duplicate) printf 'SCHEMA=1\nROOT=%s\nROOT=%s\n' "$safe" "$safe" > "$state/rust1.96.1.env"; chmod 600 "$state/rust1.96.1.env" ;;
      unknown) printf 'SCHEMA=1\nROOT=%s\nTOOLCHAIN_BIN=x\nEXTRA=x\n' "$safe" > "$state/rust1.96.1.env"; chmod 600 "$state/rust1.96.1.env" ;;
      outside-root) printf 'SCHEMA=1\nROOT=%s\nTOOLCHAIN_BIN=x\n' "$BATS_TEST_TMPDIR/outside" > "$state/rust1.96.1.env"; chmod 600 "$state/rust1.96.1.env" ;;
      descriptor-symlink) printf 'SCHEMA=1\nROOT=%s\nTOOLCHAIN_BIN=x\n' "$safe" > "$state/target"; ln -s "$state/target" "$state/rust1.96.1.env" ;;
    esac
    run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" "$root/tests/release/with-rust.sh" -- true
    [ "$status" -eq 64 ]
  done
  rm -f "$state/rust1.96.1.env"; safe="$tmp/tmux-pane-dash-rust.invalid"; mkdir -p "$safe/rustup/toolchains/1.96.1/bin"; printf 'SCHEMA=1\nROOT=%s\nTOOLCHAIN_BIN=%s\n' "$safe" "$safe/rustup/toolchains/1.96.1/bin" > "$state/rust1.96.1.env"; chmod 600 "$state/rust1.96.1.env"
  run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" "$root/tests/release/with-rust.sh" -- true
  [ "$status" -eq 0 ]; [ ! -e "$safe" ]
}

assert_pid_reaped() {
  local pid=$1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}

make_hanging_rustup() {
  local bin=$1
  mkdir -p "$bin"
  cat > "$bin/rustup" <<'SH'
#!/bin/sh
set -eu
root=${RUSTUP_HOME%/rustup}
case "$1" in
  toolchain)
    sleep 30 &
    printf '%s %s\n' "$$" "$!" > "$root/hang-pids"
    wait ;;
  which) echo "no" ;;
esac
SH
  chmod +x "$bin/rustup"
}

@test "with-rust provision timeout terminates and reaps descendants with no descriptor or transient state" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$tmp"; tmp="$(cd "$tmp" && pwd -P)"
  make_hanging_rustup "$bin"
  # Use a 2s timeout with 0s kill-grace: wrapper must complete (which proves TERM→KILL/reap)
  run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" PANE_DASH_TEST_PROVISION_TIMEOUT=2 PANE_DASH_TEST_KILL_GRACE=0 "$root/tests/release/with-rust.sh" -- true
  [ "$status" -ne 0 ]
  state="$tmp/tmux-pane-dash-release-$(id -u)"
  # Descriptor must not exist (incomplete provision cleaned up)
  [ ! -e "$state/rust1.96.1.env" ]
  # No transient roots should survive (stop_incomplete_provision removes them)
  ! compgen -G "$tmp/tmux-pane-dash-rust.*" >/dev/null 2>&1 || [ "$(ls -d "$tmp"/tmux-pane-dash-rust.* 2>/dev/null | wc -l | tr -d ' ')" -eq 0 ]
}

@test "with-rust SIGKILL of guarded prepare releases the kernel flock and later contender succeeds" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$tmp" "$bin"; tmp="$(cd "$tmp" && pwd -P)"
  cat > "$bin/rustup" <<'SH'
#!/bin/sh
set -eu
root=${RUSTUP_HOME%/rustup}
case "$1" in
  toolchain)
    printf '%s %s\n' "$PPID" "$$" > "$root/guarded-pid"
    while :; do sleep 1; done ;;
  which) echo "no" ;;
esac
SH
  chmod +x "$bin/rustup"
  env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" "$root/tests/release/with-rust.sh" -- true >"$BATS_TEST_TMPDIR/killed.log" 2>&1 &
  outer_pid=$!
  # Wait for the guarded-pid file to appear under the provisioned root
  guarded_pid_file=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    guarded_pid_file="$(find "$tmp" -name guarded-pid -type f 2>/dev/null | head -1)"
    [ -n "$guarded_pid_file" ] && [ -s "$guarded_pid_file" ] && break
    guarded_pid_file=""
    sleep 1
  done
  [ -n "$guarded_pid_file" ] && [ -s "$guarded_pid_file" ]
  read -r guarded_pid rustup_pid < "$guarded_pid_file"
  kill -KILL "$guarded_pid"
  wait "$outer_pid" || true
  # Kill the orphaned rustup process (test cleanup only)
  kill -KILL "$rustup_pid" 2>/dev/null || true
  assert_pid_reaped "$rustup_pid"
  state="$tmp/tmux-pane-dash-release-$(id -u)"
  [ ! -e "$state/rust1.96.1.env" ]
  # Now a fresh contender with proper rustup must succeed (flock released)
  make_fake_rustup "$bin"
  run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" "$root/tests/release/with-rust.sh" -- true
  [ "$status" -eq 0 ]
}

@test "with-rust HUP and TERM during provision return signal statuses and reap process group" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$tmp"; tmp="$(cd "$tmp" && pwd -P)"
  for signal in HUP TERM; do
    rm -rf "$tmp/tmux-pane-dash-release-$(id -u)"
    rm -rf "$tmp"/tmux-pane-dash-rust.*
    mkdir -p "$bin"
    # The rustup child runs under env -i so can only see RUSTUP_HOME
    # Write PIDs to a file inside the root derived from RUSTUP_HOME
    cat > "$bin/rustup" <<'SH'
#!/bin/sh
set -eu
root=${RUSTUP_HOME%/rustup}
case "$1" in
  toolchain)
    sleep 30 &
    printf '%s %s %s\n' "$PPID" "$$" "$!" > "$root/signal-pids"
    wait ;;
  which) echo "no" ;;
esac
SH
    chmod +x "$bin/rustup"
    env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" sh -c 'trap - HUP INT TERM; exec "$@"' signal-shell "$root/tests/release/with-rust.sh" -- true >"$BATS_TEST_TMPDIR/$signal.log" 2>&1 & wrapper=$!
    # Wait for the signal-pids file to appear under the provisioned root
    marker=""
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      marker="$(find "$tmp" -name signal-pids -type f 2>/dev/null | head -1)"
      [ -n "$marker" ] && [ -s "$marker" ] && break
      marker=""
      sleep 1
    done
    [ -n "$marker" ] && [ -s "$marker" ]; read -r script_pid rustup_pid child_pid < "$marker"
    status=0; kill -"$signal" "$script_pid"; wait "$wrapper" || status=$?
    case "$signal" in HUP) [ "$status" -eq 129 ] ;; TERM) [ "$status" -eq 143 ] ;; esac || { printf '%s status=%s\n' "$signal" "$status" >&3; false; }
    # Clean up any orphaned test processes
    kill -KILL "$rustup_pid" 2>/dev/null || true
    kill -KILL "$child_pid" 2>/dev/null || true
    assert_pid_reaped "$rustup_pid"
    assert_pid_reaped "$child_pid"
    state="$tmp/tmux-pane-dash-release-$(id -u)"
    [ ! -e "$state/rust1.96.1.env" ]
  done
}

@test "with-rust exports validated absolute tools and rejects ambient compiler overrides" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"; tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"; trap_bin="$BATS_TEST_TMPDIR/trap-bin"; fake_tmux="$BATS_TEST_TMPDIR/tmux"
  mkdir -p "$tmp" "$trap_bin"; tmp="$(cd "$tmp" && pwd -P)"; make_fake_rustup "$bin"
  printf '#!/bin/sh\nprintf "tmux 3.7\\n"\n' > "$fake_tmux"; chmod +x "$fake_tmux"
  for tool in cargo rustc rustdoc rustfmt clippy-driver cc ld helper; do printf '#!/bin/sh\nprintf trapped >&2\nexit 97\n' > "$trap_bin/$tool"; chmod +x "$trap_bin/$tool"; done
  run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" TMUX_BIN="$fake_tmux" PATH="$trap_bin:$PATH" \
    CARGO="$trap_bin/cargo" RUSTC="$trap_bin/rustc" RUSTDOC="$trap_bin/rustdoc" RUSTFMT="$trap_bin/rustfmt" CLIPPY_DRIVER="$trap_bin/clippy-driver" \
    RUSTC_WRAPPER="$trap_bin/rustc" RUSTC_WORKSPACE_WRAPPER="$trap_bin/rustc" RUSTDOCFLAGS=bad RUSTFLAGS=bad CARGO_ENCODED_RUSTFLAGS=bad \
    CARGO_BUILD_TARGET=bad CARGO_TARGET_DIR=bad CC="$trap_bin/rustc" CXX="$trap_bin/rustc" AR="$trap_bin/rustc" LD="$trap_bin/rustc" CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="$trap_bin/rustc" CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=bad \
    NODE_OPTIONS=bad NODE_PATH=bad NODE_EXTRA_CA_CERTS=bad NODE_REPL_HISTORY=bad NODE_CONFIG=bad node_config=bad SSL_CERT_FILE=bad SSL_CERT_DIR=bad CURL_CA_BUNDLE=bad REQUESTS_CA_BUNDLE=bad GIT_CONFIG_GLOBAL=bad GIT_CONFIG_SYSTEM=bad GIT_CONFIG_NOSYSTEM=bad GIT_SSH=bad GIT_SSH_COMMAND=bad \
    DOCKER_AUTH_CONFIG=x GIT_ASKPASS=x SSH_ASKPASS=x SSH_ASKPASS_REQUIRE=x NPM_CONFIG_REGISTRY=x NPM_CONFIG_USERCONFIG=x npm_config_registry=x npm_config_userconfig=x NODE_AUTH_TOKEN=x YARN_NPM_AUTH_TOKEN=x YARN_RC_FILENAME=x NETRC=x KUBECONFIG=x AWS_ACCESS_KEY_ID=x SERVICE_TOKEN=x service_token=x SERVICE_PASSWORD=x SERVICE_SECRET=x SERVICE_API_KEY=x SERVICE_AUTH_CONFIG=x service_auth_config=x \
    "$root/tests/release/with-rust.sh" -- "$root/scripts/release/clean-room.sh" -- sh -c '
      set -e
      toolchain="$PANE_DASH_ISOLATED_RUST_ROOT/rustup/toolchains/1.96.1/bin"
      test -n "$PANE_DASH_ISOLATED_RUST_ROOT"
      test "$RUSTUP_HOME" = "$PANE_DASH_ISOLATED_RUST_ROOT/rustup"
      test "$CARGO_HOME" = "$PANE_DASH_ISOLATED_RUST_ROOT/cargo"
      test "$CARGO" = "$PANE_DASH_ISOLATED_RUST_ROOT/rustup/toolchains/1.96.1/bin/cargo"
      test "$RUSTC" = "$PANE_DASH_ISOLATED_RUST_ROOT/rustup/toolchains/1.96.1/bin/rustc"
      test "$RUSTDOC" = "$PANE_DASH_ISOLATED_RUST_ROOT/rustup/toolchains/1.96.1/bin/rustdoc"
      test "$RUSTFMT" = "$PANE_DASH_ISOLATED_RUST_ROOT/rustup/toolchains/1.96.1/bin/rustfmt"
      test "$CLIPPY_DRIVER" = "$PANE_DASH_ISOLATED_RUST_ROOT/rustup/toolchains/1.96.1/bin/clippy-driver"
      test "$PATH" = "$toolchain:/usr/bin:/bin:/usr/sbin:/sbin"
      test "$(command -v cc)" = /usr/bin/cc
      ! command -v helper
      ! env | grep -Eq "^(RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTDOCFLAGS|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_TARGET|CARGO_TARGET_DIR|CC|CXX|AR|LD|CARGO_TARGET_.*_(LINKER|RUSTFLAGS))="
      ! env | grep -Eq "^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_REPL_HISTORY|NODE_CONFIG|node_config|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|GIT_SSH|GIT_SSH_COMMAND)="
      ! env | grep -Eq "^(DOCKER_AUTH_CONFIG|GIT_ASKPASS|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|NPM_CONFIG_|npm_config_|NODE_AUTH_TOKEN|YARN_|NETRC|KUBECONFIG|AWS_ACCESS_KEY_ID|SERVICE_)="
      cargo --version >/dev/null
    '
  [ "$status" -eq 0 ]
}

@test "with-rust uses the system compiler for an isolated cargo check despite caller PATH traps" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"; trap_bin="$BATS_TEST_TMPDIR/trap-bin"; target_dir="$BATS_TEST_TMPDIR/cargo-target"
  mkdir -p "$trap_bin"
  for tool in cc ld helper; do printf '#!/bin/sh\nprintf trapped >&2\nexit 97\n' > "$trap_bin/$tool"; chmod +x "$trap_bin/$tool"; done
  run env PATH="$trap_bin:$PATH" CC="$trap_bin/cc" LD="$trap_bin/ld" "$root/tests/release/with-rust.sh" -- sh -c '
    test "$(command -v cc)" = /usr/bin/cc
    ! command -v helper
    exec cargo check --manifest-path "$1/pane-dash/Cargo.toml" --target-dir "$2"
  ' sh "$root" "$target_dir"
  [ "$status" -eq 0 ]
}
