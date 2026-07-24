#!/usr/bin/env bats

setup() {
  repo_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd -P)"
  work="$BATS_TEST_TMPDIR/project"
  mkdir -p "$work/.cortexkit/v0.1-release" "$work/bin" "$work/tests/release"
  cp "$repo_root/tests/release/with-node20.sh" "$work/tests/release/with-node20.sh"
  chmod +x "$work/tests/release/with-node20.sh"
  cat > "$work/bin/node" <<'EOF'
#!/bin/sh
[ "$1" = --version ] && { printf 'v20.0.0\n'; exit 0; }
exec /usr/bin/env false
EOF
  cat > "$work/bin/npm" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$work/bin/node" "$work/bin/npm"
}

@test "uses validated exact preprovided Node without creating persistent state" {
  run env PANE_DASH_NODE20_PREPROVIDED=1 NODE_20_BIN="$work/bin/node" NPM_20_CLI="$work/bin/npm" "$work/tests/release/with-node20.sh" -- node --version
  [ "$status" -eq 0 ]
  [ "$output" = "v20.0.0" ]
  [ ! -e "$work/.cortexkit/v0.1-release/node20.env" ]
}

@test "rejects a nonexact preprovided Node" {
  printf '#!/bin/sh\nprintf "v20.1.0\\n"\n' > "$work/bin/node"
  chmod +x "$work/bin/node"
  run env PANE_DASH_NODE20_PREPROVIDED=1 NODE_20_BIN="$work/bin/node" NPM_20_CLI="$work/bin/npm" "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 64 ]
  [[ "$output" == *"v20.0.0"* ]]
}

@test "provisions and cleans a physical temporary root with isolated fake mise" {
  cat > "$work/bin/mise" <<'EOF'
#!/bin/sh
[ "$1" = install ] || exit 1
bin="$MISE_DATA_DIR/installs/node/20.0.0/bin"
mkdir -p "$bin"
cp "$FAKE_NODE" "$bin/node"
cp "$FAKE_NPM" "$bin/npm"
chmod +x "$bin/node" "$bin/npm"
EOF
  chmod +x "$work/bin/mise"
  mkdir -p "$BATS_TEST_TMPDIR/private/var/tmp" "$work/home"
  run env \
    HOME="$work/home" \
    TMPDIR="$BATS_TEST_TMPDIR/private/var/tmp" \
    PATH="$work/bin:$PATH" \
    FAKE_NODE="$work/bin/node" \
    FAKE_NPM="$work/bin/npm" \
    "$work/tests/release/with-node20.sh" -- node --version
  [ "$status" -eq 0 ]
  [ "$output" = "v20.0.0" ]
  descriptor="$work/.cortexkit/v0.1-release/node20.env"
  [ "$(stat -f '%Lp' "$descriptor" 2>/dev/null || stat -c '%a' "$descriptor")" = 600 ]
  root="$(awk -F= '$1 == "ROOT" { print $2 }' "$descriptor")"
  physical_tmp="$(cd "$BATS_TEST_TMPDIR/private/var/tmp" && pwd -P)"
  [[ "$root" == "$physical_tmp/tmux-pane-dash-node20."* ]]
  run env TMPDIR="$BATS_TEST_TMPDIR/private/var/tmp" "$work/tests/release/with-node20.sh" --cleanup
  [ "$status" -eq 0 ]
  [ ! -e "$root" ]
}
