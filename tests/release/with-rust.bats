#!/usr/bin/env bats

@test "with-rust rejects ambient state and provides exact isolated Rust" {
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  run "$root/tests/release/with-rust.sh" -- sh -c 'test "$(cargo --version | awk "{print \$2}")" = 1.96.1 && test -n "$RUSTUP_HOME" && test -n "$CARGO_HOME"'
  [ "$status" -eq 0 ]
}
