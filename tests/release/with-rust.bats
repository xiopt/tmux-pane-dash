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
