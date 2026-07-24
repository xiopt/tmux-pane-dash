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
case "${1##*/}" in npm|npm-cli.js) printf '9.6.4\n'; exit 0 ;; esac
exec /usr/bin/env false
EOF
  cat > "$work/bin/npm" <<'EOF'
console.log("9.6.4")
EOF
  chmod +x "$work/bin/node" "$work/bin/npm"
}

write_fake_mise() {
  cat > "$work/bin/mise" <<'EOF'
#!/bin/sh
[ "$1" = install ] || exit 1
printf 'provision\n' >> "$PROVISION_LOG"
bin="$MISE_DATA_DIR/installs/node/20.0.0/bin"
cli="$MISE_DATA_DIR/installs/node/20.0.0/lib/node_modules/npm/bin"
mkdir -p "$bin" "$cli"
cp "$FAKE_NODE" "$bin/node"
cp "$FAKE_NPM" "$bin/npm"
cp "$FAKE_NPM" "$cli/npm-cli.js"
chmod +x "$bin/node" "$bin/npm" "$cli/npm-cli.js"
EOF
  chmod +x "$work/bin/mise"
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
cli="$MISE_DATA_DIR/installs/node/20.0.0/lib/node_modules/npm/bin"
mkdir -p "$bin" "$cli"
cp "$FAKE_NODE" "$bin/node"
cp "$FAKE_NPM" "$bin/npm"
cp "$FAKE_NPM" "$cli/npm-cli.js"
chmod +x "$bin/node" "$bin/npm" "$cli/npm-cli.js"
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
  npm_cli="$(awk -F= '$1 == "NPM_20_CLI" { print $2 }' "$descriptor")"
  physical_tmp="$(cd "$BATS_TEST_TMPDIR/private/var/tmp" && pwd -P)"
  [[ "$root" == "$physical_tmp/tmux-pane-dash-node20."* ]]
  [ "$npm_cli" = "$root/mise/data/installs/node/20.0.0/lib/node_modules/npm/bin/npm-cli.js" ]
  run env TMPDIR="$BATS_TEST_TMPDIR/private/var/tmp" "$work/tests/release/with-node20.sh" --cleanup
  [ "$status" -eq 0 ]
  [ ! -e "$root" ]
}

@test "provisioning gives mise a short GPG path resolved inside its isolated root" {
  cat > "$work/bin/mise" <<'EOF'
#!/bin/sh
[ "$1" = install ] || exit 1
[ -n "${GNUPGHOME:-}" ] || exit 91
printf '%s\n' "$GNUPGHOME" > "$GPG_HOME_SEEN"
cd "$GNUPGHOME"
pwd -P > "$GPG_HOME_RESOLVED"
bin="$MISE_DATA_DIR/installs/node/20.0.0/bin"
cli="$MISE_DATA_DIR/installs/node/20.0.0/lib/node_modules/npm/bin"
mkdir -p "$bin" "$cli"
cp "$FAKE_NODE" "$bin/node"
cp "$FAKE_NPM" "$bin/npm"
cp "$FAKE_NPM" "$cli/npm-cli.js"
chmod +x "$bin/node" "$bin/npm" "$cli/npm-cli.js"
EOF
  chmod +x "$work/bin/mise"
  mkdir -p "$BATS_TEST_TMPDIR/private/var/tmp" "$work/home"
  gpg_home_seen="$BATS_TEST_TMPDIR/gpg-home"
  gpg_home_resolved="$BATS_TEST_TMPDIR/gpg-home-resolved"
  run env -u GNUPGHOME \
    HOME="$work/home" \
    TMPDIR="$BATS_TEST_TMPDIR/private/var/tmp" \
    PATH="$work/bin:$PATH" \
    FAKE_NODE="$work/bin/node" \
    FAKE_NPM="$work/bin/npm" \
    GPG_HOME_SEEN="$gpg_home_seen" \
    GPG_HOME_RESOLVED="$gpg_home_resolved" \
    "$work/tests/release/with-node20.sh" -- node --version
  [ "$status" -eq 0 ]
  gpg_home="$(cat "$gpg_home_seen")"
  [[ "$gpg_home" == /tmp/tmux-pane-dash-node20-gpg.* ]]
  root="$(awk -F= '$1 == "ROOT" { print $2 }' "$work/.cortexkit/v0.1-release/node20.env")"
  [ "$(cat "$gpg_home_resolved")" = "$root/gnupg" ]
  [ ! -e "$gpg_home" ]
}

@test "does not steal an ownerless new lock before its owner records identity" {
  write_fake_mise
  real_mkdir="$(command -v mkdir)"
  cat > "$work/bin/mkdir" <<EOF
#!/bin/sh
"$real_mkdir" "\$@"
status=\$?
[ "\$status" -eq 0 ] || exit "\$status"
case "\$*" in *node20.lock) if [ ! -e "\$PAUSED_LOCK_MKDIR" ]; then : > "\$PAUSED_LOCK_MKDIR"; sleep 2; fi ;; esac
exit 0
EOF
  chmod +x "$work/bin/mkdir"
  private_tmp="$BATS_TEST_TMPDIR/private"
  "$real_mkdir" -p "$private_tmp"
  provision_log="$BATS_TEST_TMPDIR/provisions"
  paused="$BATS_TEST_TMPDIR/paused"
  env PAUSED_LOCK_MKDIR="$paused" PROVISION_LOG="$provision_log" TMPDIR="$private_tmp" PATH="$work/bin:$PATH" FAKE_NODE="$work/bin/node" FAKE_NPM="$work/bin/npm" "$work/tests/release/with-node20.sh" -- true >"$BATS_TEST_TMPDIR/owner.log" 2>&1 &
  owner=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -e "$paused" ] && break; sleep 1; done
  [ -e "$paused" ]
  env PAUSED_LOCK_MKDIR="$paused" PROVISION_LOG="$provision_log" TMPDIR="$private_tmp" PATH="$work/bin:$PATH" FAKE_NODE="$work/bin/node" FAKE_NPM="$work/bin/npm" "$work/tests/release/with-node20.sh" -- true >"$BATS_TEST_TMPDIR/contender.log" 2>&1 &
  contender=$!
  wait "$contender"
  contender_status=$?
  wait "$owner"
  owner_status=$?
  [ "$owner_status" -eq 0 ]
  [ "$contender_status" -eq 0 ]
  [ "$(wc -l < "$provision_log" | tr -d ' ')" -eq 1 ]
  [ "$(wc -l < "$work/.cortexkit/v0.1-release/node20.env" | tr -d ' ')" -eq 5 ]
}

@test "rejects descriptor node traversal and symlink escapes" {
  private_tmp="$BATS_TEST_TMPDIR/private"
  root="$private_tmp/tmux-pane-dash-node20.synthetic"
  mkdir -p "$root/mise/data/installs/node/20.0.0/bin" "$root/mise/data/installs/node/20.0.0/lib/node_modules/npm/bin" "$BATS_TEST_TMPDIR/outside"
  cp "$work/bin/node" "$root/mise/data/installs/node/20.0.0/bin/node"
  cp "$work/bin/npm" "$root/mise/data/installs/node/20.0.0/lib/node_modules/npm/bin/npm-cli.js"
  cp "$work/bin/npm" "$BATS_TEST_TMPDIR/outside/npm-cli.js"
  chmod +x "$root/mise/data/installs/node/20.0.0/bin/node" "$root/mise/data/installs/node/20.0.0/lib/node_modules/npm/bin/npm-cli.js" "$BATS_TEST_TMPDIR/outside/npm-cli.js"
  ln -s "$BATS_TEST_TMPDIR/outside" "$root/mise/data/escape"
  cat > "$work/.cortexkit/v0.1-release/node20.env" <<EOF
SCHEMA=1
ROOT=$root
MISE=$work/bin/node
NODE_20_BIN=$root/mise/data/../data/installs/node/20.0.0/bin/node
NPM_20_CLI=$root/mise/data/escape/npm-cli.js
EOF
  chmod 600 "$work/.cortexkit/v0.1-release/node20.env"
  run env TMPDIR="$private_tmp" "$work/tests/release/with-node20.sh" --cleanup
  [ "$status" -eq 64 ]
  [[ "$output" == *"invalid descriptor"* ]]
  [ -d "$root" ]
}
