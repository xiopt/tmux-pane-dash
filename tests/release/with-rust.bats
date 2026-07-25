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
    chmod +x "$RUSTUP_HOME/toolchains/1.96.1/bin/rustc" "$RUSTUP_HOME/toolchains/1.96.1/bin/cargo" ;;
  which) echo "$RUSTUP_HOME/toolchains/1.96.1/bin/$2" ;;
esac
SH
  chmod +x "$bin/rustup"
}

@test "with-rust rejects ambient state and provides exact isolated Rust" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  run "$root/tests/release/with-rust.sh" -- sh -c 'test "$(cargo --version | awk "{print \$2}")" = 1.96.1 && test -n "$RUSTUP_HOME" && test -n "$CARGO_HOME"'
  [ "$status" -eq 0 ]
}

@test "with-rust preserves caller HOME and XDG while exporting only isolated Rust state" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  home="$BATS_TEST_TMPDIR/home"
  xdg="$BATS_TEST_TMPDIR/xdg"
  mkdir -p "$home" "$xdg"
  run env HOME="$home" XDG_CONFIG_HOME="$xdg" EXPECTED_HOME="$home" EXPECTED_XDG="$xdg" "$root/tests/release/with-rust.sh" -- sh -c 'test "$HOME" = "$EXPECTED_HOME" && test "$XDG_CONFIG_HOME" = "$EXPECTED_XDG" && case "$RUSTUP_HOME:$CARGO_HOME:$PATH" in /tmp/*:/tmp/*:/tmp/*|/var/folders/*:/var/folders/*:/var/folders/*|/private/var/folders/*:/private/var/folders/*:/private/var/folders/*) ;; *) exit 1 ;; esac'
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
  toolchain) mkdir -p "$RUSTUP_HOME/toolchains/1.96.1/bin"; for tool in rustc cargo; do cat > "$RUSTUP_HOME/toolchains/1.96.1/bin/$tool" <<EOF
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

@test "with-rust strips credentials preserves caller home and forwards child status while cleanup keeps a sentinel" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"; tmp="$BATS_TEST_TMPDIR/tmp"; bin="$BATS_TEST_TMPDIR/bin"; home="$BATS_TEST_TMPDIR/home"
  mkdir -p "$tmp" "$home"; tmp="$(cd "$tmp" && pwd -P)"; make_fake_rustup "$bin"
  run env TMPDIR="$tmp" HOME="$home" EXPECTED_HOME="$home" RUSTUP_BOOTSTRAP="$bin/rustup" NPM_TOKEN=x HTTPS_PROXY=x CARGO_REGISTRIES_X_INDEX=x "$root/tests/release/with-rust.sh" -- sh -c 'test "$HOME" = "$EXPECTED_HOME"; test -z "${NPM_TOKEN+x}${HTTPS_PROXY+x}${CARGO_REGISTRIES_X_INDEX+x}"'
  [ "$status" -eq 0 ]
  run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" "$root/tests/release/with-rust.sh" -- sh -c 'exit 42'; [ "$status" -eq 42 ]
  run env TMPDIR="$tmp" RUSTUP_BOOTSTRAP="$bin/rustup" "$root/tests/release/with-rust.sh" -- sh -c 'kill -TERM $$'; [ "$status" -eq 143 ]
  state="$tmp/tmux-pane-dash-release-$(id -u)"; : > "$state/sentinel"
  run env TMPDIR="$tmp" "$root/tests/release/with-rust.sh" --cleanup; [ "$status" -eq 0 ]; [ -e "$state/sentinel" ]
  run env TMPDIR="$tmp" "$root/tests/release/with-rust.sh" --cleanup; [ "$status" -eq 0 ]; [ -e "$state/sentinel" ]
}
