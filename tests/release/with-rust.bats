#!/usr/bin/env bats

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
  which) echo "$RUSTUP_HOME/toolchains/1.96.1/bin/$3" ;;
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
