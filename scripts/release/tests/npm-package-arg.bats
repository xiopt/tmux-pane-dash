#!/usr/bin/env bats

@test "locks npm-package-arg 13.0.2 and records its Bun integrity" {
  root="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd -P)"
  run bun -e 'const lock = await Bun.file(process.argv[1]).text(); if (!lock.includes("npm-package-arg@13.0.2") || !lock.includes("sha512-")) process.exit(1)' "$root/scripts/release/fixtures/npm-package-arg-13/bun.lock"
  [ "$status" -eq 0 ]
}
