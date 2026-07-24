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
  home="$BATS_TEST_TMPDIR/home"
  xdg_data="$BATS_TEST_TMPDIR/xdg-data"
  xdg_config="$BATS_TEST_TMPDIR/xdg-config"
  xdg_cache="$BATS_TEST_TMPDIR/xdg-cache"
  private_tmp="$BATS_TEST_TMPDIR/private/tmp"
  mkdir -p "$home" "$xdg_data" "$xdg_config" "$xdg_cache" "$private_tmp"
  : > "$home/sentinel"; : > "$xdg_data/sentinel"; : > "$xdg_config/sentinel"; : > "$xdg_cache/sentinel"
}

base_env() {
  env HOME="$home" XDG_DATA_HOME="$xdg_data" XDG_CONFIG_HOME="$xdg_config" XDG_CACHE_HOME="$xdg_cache" \
    TMPDIR="$private_tmp" PATH="$work/bin:$PATH" FAKE_NODE="$work/bin/node" FAKE_NPM="$work/bin/npm" "$@"
}

descriptor_value() { awk -F= -v key="$1" '$1 == key { print $2 }' "$work/.cortexkit/v0.1-release/node20.env"; }

assert_pid_reaped() {
  local pid=$1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}

write_descriptor() {
  local root=$1 mise node npm
  mise=${2:-$work/bin/mise}
  node=${3:-$root/mise/data/installs/node/20.0.0/bin/node}
  npm=${4:-$root/mise/data/installs/node/20.0.0/lib/node_modules/npm/bin/npm-cli.js}
  mkdir -p "$(dirname "$node")" "$(dirname "$npm")"
  cp "$work/bin/node" "$node"; cp "$work/bin/npm" "$npm"; chmod +x "$node" "$npm"
  cat > "$work/.cortexkit/v0.1-release/node20.env" <<EOF
SCHEMA=1
ROOT=$root
MISE=$mise
NODE_20_BIN=$node
NPM_20_CLI=$npm
EOF
  chmod 600 "$work/.cortexkit/v0.1-release/node20.env"
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

@test "fails closed while a live creator has not yet recorded its lock identity" {
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
  env PAUSED_LOCK_MKDIR="$paused" PANE_DASH_TEST_LOCK_ATTEMPTS=2 PANE_DASH_TEST_LOCK_SLEEP=0 PROVISION_LOG="$provision_log" TMPDIR="$private_tmp" PATH="$work/bin:$PATH" FAKE_NODE="$work/bin/node" FAKE_NPM="$work/bin/npm" "$work/tests/release/with-node20.sh" -- true >"$BATS_TEST_TMPDIR/contender.log" 2>&1 &
  contender=$!
  contender_status=0
  wait "$contender" || contender_status=$?
  [ "$contender_status" -eq 64 ]
  [ -d "$work/.cortexkit/v0.1-release/node20.lock" ]
  wait "$owner"
  owner_status=$?
  [ "$owner_status" -eq 0 ]
  [ "$(wc -l < "$provision_log" | tr -d ' ')" -eq 1 ]
  [ "$(wc -l < "$work/.cortexkit/v0.1-release/node20.env" | tr -d ' ')" -eq 5 ]
}

@test "fails closed for a malformed lock owner record" {
  mkdir -p "$work/.cortexkit/v0.1-release/node20.lock"
  printf 'not-a-pid missing-token extra\n' > "$work/.cortexkit/v0.1-release/node20.lock/owner"
  run base_env PANE_DASH_TEST_LOCK_ATTEMPTS=2 PANE_DASH_TEST_LOCK_SLEEP=0 "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 64 ]
  [ -d "$work/.cortexkit/v0.1-release/node20.lock" ]
}

@test "runs under the system Bash 3.2 without associative arrays" {
  run /bin/bash -n "$work/tests/release/with-node20.sh"
  [ "$status" -eq 0 ]
  run /bin/bash -n "$repo_root/scripts/release/clean-room.sh"
  [ "$status" -eq 0 ]
  run /bin/bash -c '! grep -Eq "declare[[:space:]]+-A|declare[[:space:]]+--[[:space:]]+.*-A" "$1" "$2"' bash "$work/tests/release/with-node20.sh" "$repo_root/scripts/release/clean-room.sh"
  [ "$status" -eq 0 ]
  run base_env PANE_DASH_NODE20_PREPROVIDED=1 NODE_20_BIN="$work/bin/node" NPM_20_CLI="$work/bin/npm" /bin/bash "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 0 ]
}

@test "cleans every tracked provision resource after post-creation failures" {
  write_fake_mise
  for round in 1 2 3 4 5; do
    for step in root-mkdir gpg-link descriptor-write descriptor-chmod descriptor-mv; do
      rm -rf "$work/.cortexkit/v0.1-release"
      fault_log="$BATS_TEST_TMPDIR/fault-$round-$step"
      run base_env PROVISION_LOG="$BATS_TEST_TMPDIR/provisions-$round-$step" PANE_DASH_TEST_FAULT_STEP="$step" PANE_DASH_TEST_FAULT_LOG="$fault_log" "$work/tests/release/with-node20.sh" -- true
      [ "$status" -eq 64 ] || { printf 'round=%s step=%s output=%s\n' "$round" "$step" "$output" >&3; false; }
      [ ! -e "$work/.cortexkit/v0.1-release/node20.env" ]
      [ ! -d "$work/.cortexkit/v0.1-release/node20.lock" ]
      [ -f "$fault_log" ]
      while IFS='=' read -r kind path; do
        [ -z "$path" ] && continue
        [ ! -e "$path" ] || { printf 'round=%s step=%s leaked %s=%s\n' "$round" "$step" "$kind" "$path" >&3; false; }
      done < "$fault_log"
      ! compgen -G "$private_tmp/tmux-pane-dash-node20.*" >/dev/null
    done
  done
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

@test "reuses one exact descriptor and physical tool paths across fresh processes without mutation" {
  write_fake_mise
  provision_log="$BATS_TEST_TMPDIR/provisions"
  run base_env PROVISION_LOG="$provision_log" "$work/tests/release/with-node20.sh" -- sh -c 'printf "%s|%s|%s\n" "$NODE_20_BIN" "$NPM_20_CLI" "$(command -v node)"'
  [ "$status" -eq 0 ]
  first="$output"; descriptor_before="$(cat "$work/.cortexkit/v0.1-release/node20.env")"
  run base_env PROVISION_LOG="$provision_log" "$work/tests/release/with-node20.sh" -- sh -c 'printf "%s|%s|%s\n" "$NODE_20_BIN" "$NPM_20_CLI" "$(command -v node)"'
  [ "$status" -eq 0 ]; [ "$output" = "$first" ]
  [ "$(wc -l < "$provision_log" | tr -d ' ')" -eq 1 ]
  [ "$(cat "$work/.cortexkit/v0.1-release/node20.env")" = "$descriptor_before" ]
}

@test "does not remove a bounded live lock with a valid owner token" {
  mkdir -p "$work/.cortexkit/v0.1-release/node20.lock"
  printf '%s %s\n' "$$" "$(ps -o lstart= -p "$$" | tr -d ' ')" > "$work/.cortexkit/v0.1-release/node20.lock/owner"
  run base_env PANE_DASH_TEST_LOCK_ATTEMPTS=2 PANE_DASH_TEST_LOCK_SLEEP=0 "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 64 ]; [[ "$output" == *"lock is held"* ]]
  [ -d "$work/.cortexkit/v0.1-release/node20.lock" ]
}

@test "recovers a dead lock owner with a valid start-token record" {
  write_fake_mise
  mkdir -p "$work/.cortexkit/v0.1-release/node20.lock"
  printf '999999 dead-token\n' > "$work/.cortexkit/v0.1-release/node20.lock/owner"
  run base_env PROVISION_LOG="$BATS_TEST_TMPDIR/provisions" "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 0 ]; [ ! -d "$work/.cortexkit/v0.1-release/node20.lock" ]
}

@test "eight stale-lock contenders serialize recovery and provision exactly once across ten barrier rounds" {
  write_fake_mise
  for round in 1 2 3 4 5 6 7 8 9 10; do
    rm -rf "$work/.cortexkit/v0.1-release"
    mkdir -p "$work/.cortexkit/v0.1-release/node20.lock"
    printf '999999 dead-token\n' > "$work/.cortexkit/v0.1-release/node20.lock/owner"
    provision_log="$BATS_TEST_TMPDIR/stale-provisions-$round"
    ready="$BATS_TEST_TMPDIR/stale-ready-$round"
    started="$BATS_TEST_TMPDIR/stale-started-$round"
    for contender in 1 2 3 4 5 6 7 8; do
      (
        : > "$started-$contender"
        while [ ! -e "$ready" ]; do sleep 0.01; done
        base_env PROVISION_LOG="$provision_log" "$work/tests/release/with-node20.sh" -- true
      ) >"$BATS_TEST_TMPDIR/stale-$round-$contender.log" 2>&1 &
    done
    for contender in 1 2 3 4 5 6 7 8; do
      for _ in 1 2 3 4 5 6 7 8 9 10; do [ -e "$started-$contender" ] && break; sleep 1; done
      [ -e "$started-$contender" ]
    done
    : > "$ready"
    failures=0
    for pid in $(jobs -p); do wait "$pid" || failures=$((failures + 1)); done
    [ "$failures" -eq 0 ] || { printf 'stale round=%s failures=%s\n' "$round" "$failures" >&3; for log in "$BATS_TEST_TMPDIR"/stale-"$round"-*.log; do printf '%s: ' "$log" >&3; cat "$log" >&3; done; false; }
    [ "$(wc -l < "$provision_log" | tr -d ' ')" -eq 1 ]
    [ "$(wc -l < "$work/.cortexkit/v0.1-release/node20.env" | tr -d ' ')" -eq 5 ]
    [ ! -d "$work/.cortexkit/v0.1-release/node20.lock" ]
    [ ! -e "$work/.cortexkit/v0.1-release/node20.recovery.lock" ]
  done
}

@test "refuses a live lock whose PID has a mismatched or reused start token" {
  mkdir -p "$work/.cortexkit/v0.1-release/node20.lock"
  printf '%s stale-token\n' "$$" > "$work/.cortexkit/v0.1-release/node20.lock/owner"
  run base_env PANE_DASH_TEST_LOCK_ATTEMPTS=2 PANE_DASH_TEST_LOCK_SLEEP=0 "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 64 ]; [[ "$output" == *"owner changed"* ]]
  [ -d "$work/.cortexkit/v0.1-release/node20.lock" ]
}

@test "stress contenders five times create one provision and atomic descriptor" {
  write_fake_mise
  for round in 1 2 3 4 5; do
    rm -rf "$work/.cortexkit/v0.1-release"; provision_log="$BATS_TEST_TMPDIR/provisions-$round"
    for contender in 1 2 3 4 5; do
      base_env PROVISION_LOG="$provision_log" "$work/tests/release/with-node20.sh" -- true >"$BATS_TEST_TMPDIR/$round-$contender.log" 2>&1 &
    done
    failures=0
    for pid in $(jobs -p); do wait "$pid" || failures=$((failures + 1)); done
    [ "$failures" -eq 0 ] || { printf 'round=%s failures=%s\n' "$round" "$failures" >&3; for log in "$BATS_TEST_TMPDIR"/"$round"-*.log; do printf '%s: ' "$log" >&3; cat "$log" >&3; done; false; }
    [ "$(wc -l < "$provision_log" | tr -d ' ')" -eq 1 ]
    [ "$(wc -l < "$work/.cortexkit/v0.1-release/node20.env" | tr -d ' ')" -eq 5 ]
  done
}

@test "normal and cleanup runs fail closed for a wrong-mode descriptor" {
  write_fake_mise
  physical_tmp="$(cd "$private_tmp" && pwd -P)"
  root="$physical_tmp/tmux-pane-dash-node20.stale"; write_descriptor "$root"
  chmod 644 "$work/.cortexkit/v0.1-release/node20.env"
  run base_env PROVISION_LOG="$BATS_TEST_TMPDIR/provisions" "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 64 ]; [ ! -e "$BATS_TEST_TMPDIR/provisions" ]; [ -d "$root" ]; [ -e "$work/.cortexkit/v0.1-release/node20.env" ]
  run base_env "$work/tests/release/with-node20.sh" --cleanup
  [ "$status" -eq 64 ]; [ -e "$work/.cortexkit/v0.1-release/node20.env" ]
}

@test "normal run removes a safely owned invalid root, but fails closed for unsafe descriptor ownership" {
  write_fake_mise
  physical_tmp="$(cd "$private_tmp" && pwd -P)"
  root="$physical_tmp/tmux-pane-dash-node20.invalid-tools"
  write_descriptor "$root"
  chmod -x "$root/mise/data/installs/node/20.0.0/bin/node"
  run base_env PROVISION_LOG="$BATS_TEST_TMPDIR/invalid-tools-provisions" "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 0 ]
  [ ! -e "$root" ]
  [ "$(wc -l < "$BATS_TEST_TMPDIR/invalid-tools-provisions" | tr -d ' ')" -eq 1 ]

  for label in malformed duplicate-root descriptor-symlink wrong-mode outside-root; do
    rm -rf "$work/.cortexkit/v0.1-release"
    mkdir -p "$work/.cortexkit/v0.1-release"
    suspect="$physical_tmp/tmux-pane-dash-node20.suspect-$label"
    write_descriptor "$suspect"
    case "$label" in
      malformed) printf 'not-an-assignment\n' >> "$work/.cortexkit/v0.1-release/node20.env" ;;
      duplicate-root) printf 'ROOT=%s\n' "$suspect" >> "$work/.cortexkit/v0.1-release/node20.env" ;;
      descriptor-symlink)
        mv "$work/.cortexkit/v0.1-release/node20.env" "$work/.cortexkit/v0.1-release/real.env"
        ln -s real.env "$work/.cortexkit/v0.1-release/node20.env"
        ;;
      wrong-mode) chmod 644 "$work/.cortexkit/v0.1-release/node20.env" ;;
      outside-root)
        outside="$work/outside-$label"; mkdir -p "$outside"
        sed -i.bak "s#ROOT=$suspect#ROOT=$outside#" "$work/.cortexkit/v0.1-release/node20.env"
        suspect="$outside"
        ;;
    esac
    run base_env PROVISION_LOG="$BATS_TEST_TMPDIR/unsafe-$label-provisions" "$work/tests/release/with-node20.sh" -- true
    [ "$status" -eq 64 ] || { printf 'unsafe label=%s output=%s\n' "$label" "$output" >&3; false; }
    [ -e "$work/.cortexkit/v0.1-release/node20.env" ]
    [ -d "$suspect" ]
    [ ! -e "$BATS_TEST_TMPDIR/unsafe-$label-provisions" ]
  done
}

@test "rejects malformed descriptor schema keys and unsafe roots without cleanup" {
  for label in bad-schema duplicate missing unknown relative wrong-basename outside-repo under-home under-xdg; do
    rm -rf "$work/.cortexkit/v0.1-release"; mkdir -p "$work/.cortexkit/v0.1-release"
    root="$private_tmp/tmux-pane-dash-node20.$label"; write_descriptor "$root"
    case "$label" in
      bad-schema) sed -i.bak 's/SCHEMA=1/SCHEMA=2/' "$work/.cortexkit/v0.1-release/node20.env" ;;
      duplicate) printf 'ROOT=%s\n' "$root" >> "$work/.cortexkit/v0.1-release/node20.env" ;;
      missing) head -n 4 "$work/.cortexkit/v0.1-release/node20.env" > "$work/a"; mv "$work/a" "$work/.cortexkit/v0.1-release/node20.env" ;;
      unknown) printf 'UNKNOWN=1\n' >> "$work/.cortexkit/v0.1-release/node20.env" ;;
      relative) sed -i.bak "s#ROOT=$root#ROOT=relative#" "$work/.cortexkit/v0.1-release/node20.env" ;;
      wrong-basename) sed -i.bak "s#ROOT=$root#ROOT=$private_tmp/not-node#" "$work/.cortexkit/v0.1-release/node20.env" ; mkdir -p "$private_tmp/not-node" ;;
      outside-repo) sed -i.bak "s#ROOT=$root#ROOT=$work/outside#" "$work/.cortexkit/v0.1-release/node20.env" ; mkdir -p "$work/outside" ;;
      under-home) sed -i.bak "s#ROOT=$root#ROOT=$home/tmux-pane-dash-node20.home#" "$work/.cortexkit/v0.1-release/node20.env" ; mkdir -p "$home/tmux-pane-dash-node20.home" ;;
      under-xdg) sed -i.bak "s#ROOT=$root#ROOT=$xdg_cache/tmux-pane-dash-node20.xdg#" "$work/.cortexkit/v0.1-release/node20.env" ; mkdir -p "$xdg_cache/tmux-pane-dash-node20.xdg" ;;
    esac
    chmod 600 "$work/.cortexkit/v0.1-release/node20.env"
    run base_env "$work/tests/release/with-node20.sh" --cleanup
    [ "$status" -eq 64 ] || { echo "$label"; false; }
    [ -e "$work/.cortexkit/v0.1-release/node20.env" ] || { echo "$label"; false; }
  done
}

@test "stores a physical lexical TMPDIR symlink root and cleanup preserves prefix sentinels" {
  write_fake_mise
  mkdir -p "$BATS_TEST_TMPDIR/private/var/tmp" "$BATS_TEST_TMPDIR/var"; : > "$BATS_TEST_TMPDIR/private/var/tmp/sentinel"; : > "$BATS_TEST_TMPDIR/var/sentinel"
  ln -s "$BATS_TEST_TMPDIR/private/var/tmp" "$BATS_TEST_TMPDIR/var/tmp"
  run base_env TMPDIR="$BATS_TEST_TMPDIR/var/tmp" PROVISION_LOG="$BATS_TEST_TMPDIR/provisions" "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 0 ]; root="$(descriptor_value ROOT)"
  physical_private="$(cd "$BATS_TEST_TMPDIR/private" && pwd -P)"
  [[ "$root" == "$physical_private/var/tmp/"* ]] || { printf 'stored root: %s\n' "$root" >&3; false; }
  [ ! -L "$root" ]
  run base_env TMPDIR="$BATS_TEST_TMPDIR/var/tmp" "$work/tests/release/with-node20.sh" --cleanup
  [ "$status" -eq 0 ]; [ ! -e "$root" ]; [ -e "$BATS_TEST_TMPDIR/private/var/tmp/sentinel" ]; [ -e "$BATS_TEST_TMPDIR/var/sentinel" ]
}

@test "rejects wrong descriptor owner and every unsafe executable form while preserving suspect state" {
  for label in wrong-owner outside nonregular nonexec mise-relative; do
    rm -rf "$work/.cortexkit/v0.1-release"; mkdir -p "$work/.cortexkit/v0.1-release"
    root="$private_tmp/tmux-pane-dash-node20.unsafe-$label"
    write_descriptor "$root"
    case "$label" in
      wrong-owner) test_owner=987654 ;;
      outside) cp "$work/bin/node" "$BATS_TEST_TMPDIR/outside-node"; chmod +x "$BATS_TEST_TMPDIR/outside-node"; sed -i.bak "s#NODE_20_BIN=.*#NODE_20_BIN=$BATS_TEST_TMPDIR/outside-node#" "$work/.cortexkit/v0.1-release/node20.env"; test_owner='' ;;
      nonregular) rm "$root/mise/data/installs/node/20.0.0/bin/node"; mkdir "$root/mise/data/installs/node/20.0.0/bin/node"; test_owner='' ;;
      nonexec) chmod -x "$root/mise/data/installs/node/20.0.0/bin/node"; test_owner='' ;;
      mise-relative) sed -i.bak 's#MISE=.*#MISE=relative/mise#' "$work/.cortexkit/v0.1-release/node20.env"; test_owner='' ;;
    esac
    run base_env PANE_DASH_TEST_OWNER_UID="$test_owner" "$work/tests/release/with-node20.sh" --cleanup
    [ "$status" -eq 64 ] || { echo "$label"; false; }
    [ -d "$root" ]; [ -e "$work/.cortexkit/v0.1-release/node20.env" ]
  done
}

@test "test-only owner seam proves a descriptor owned by another UID is refused" {
  write_fake_mise
  run base_env PROVISION_LOG="$BATS_TEST_TMPDIR/provisions" "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 0 ]
  root="$(descriptor_value ROOT)"
  run base_env PANE_DASH_TEST_OWNER_UID=987654 "$work/tests/release/with-node20.sh" --cleanup
  [ "$status" -eq 64 ]; [ -d "$root" ]; [ -e "$work/.cortexkit/v0.1-release/node20.env" ]
}

@test "preprovided mode rejects relative missing nonexec wrong-version and bad npm paths, but leads PATH exactly" {
  for label in relative missing nonexec wrong-version bad-npm; do
    node="$work/bin/node"; npm="$work/bin/npm"
    case "$label" in
      relative) node=bin/node ;;
      missing) node="$work/bin/missing" ;;
      nonexec) chmod -x "$work/bin/node" ;;
      wrong-version) printf '#!/bin/sh\nprintf "v20.1.0\\n"\n' > "$work/bin/node"; chmod +x "$work/bin/node" ;;
      bad-npm) printf '#!/bin/sh\nexit 1\n' > "$work/bin/npm"; chmod +x "$work/bin/npm" ;;
    esac
    run base_env PANE_DASH_NODE20_PREPROVIDED=1 NODE_20_BIN="$node" NPM_20_CLI="$npm" "$work/tests/release/with-node20.sh" -- true
    [ "$status" -eq 64 ] || { echo "$label"; false; }
  done
  setup
  run base_env PANE_DASH_NODE20_PREPROVIDED=1 NODE_20_BIN="$work/bin/node" NPM_20_CLI="$work/bin/npm" "$work/tests/release/with-node20.sh" -- sh -c 'test "$(command -v node)" = "$NODE_20_BIN"'
  [ "$status" -eq 0 ]
}

@test "provision timeout terminates and reaps mise descendants with no descriptor or transient state" {
  cat > "$work/bin/mise" <<'EOF'
#!/bin/sh
[ "$1" = install ] || exit 1
sleep 30 &
printf '%s %s\n' "$$" "$!" > "$HANG_PIDS"
wait
EOF
  chmod +x "$work/bin/mise"
  run base_env HANG_PIDS="$BATS_TEST_TMPDIR/hang-pids" PANE_DASH_TEST_PROVISION_TIMEOUT=1 PANE_DASH_TEST_KILL_GRACE=0 "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 64 ]; [[ "$output" == *"timed out"* ]]
  [ ! -e "$work/.cortexkit/v0.1-release/node20.env" ]; [ ! -d "$work/.cortexkit/v0.1-release/node20.lock" ]
  read -r mise_pid child_pid < "$BATS_TEST_TMPDIR/hang-pids"
  assert_pid_reaped "$mise_pid"; assert_pid_reaped "$child_pid"
}

@test "successful mise leader drains TERM-ignoring descendants before committing its descriptor" {
  cat > "$work/bin/mise" <<'EOF'
#!/bin/sh
[ "$1" = install ] || exit 1
bin="$MISE_DATA_DIR/installs/node/20.0.0/bin"
cli="$MISE_DATA_DIR/installs/node/20.0.0/lib/node_modules/npm/bin"
mkdir -p "$bin" "$cli"
cp "$FAKE_NODE" "$bin/node"
cp "$FAKE_NPM" "$cli/npm-cli.js"
chmod +x "$bin/node" "$cli/npm-cli.js"
(trap '' TERM; printf '%s\n' "$$" > "$SUCCESS_DESCENDANT_PID"; : > "$SUCCESS_DESCENDANT_MARKER"; while :; do sleep 1; done) &
exit 0
EOF
  chmod +x "$work/bin/mise"
  marker="$BATS_TEST_TMPDIR/success-descendant-marker"
  pid_file="$BATS_TEST_TMPDIR/success-descendant-pid"
  run base_env SUCCESS_DESCENDANT_MARKER="$marker" SUCCESS_DESCENDANT_PID="$pid_file" PANE_DASH_TEST_KILL_GRACE=0 "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 0 ]
  [ -e "$marker" ]; [ -f "$pid_file" ]
  read -r child_pid < "$pid_file"
  assert_pid_reaped "$child_pid"
  run base_env "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$work/.cortexkit/v0.1-release/node20.env" | tr -d ' ')" -eq 5 ]
}

@test "HUP and TERM during provision return signal statuses and reap their owned process group" {
  for signal in HUP TERM; do
    rm -rf "$work/.cortexkit/v0.1-release"
    cat > "$work/bin/mise" <<'EOF'
#!/bin/sh
[ "$1" = install ] || exit 1
sleep 30 &
printf '%s %s %s %s\n' "$PPID" "$$" "$!" "$GNUPGHOME" > "$SIGNAL_PIDS"
wait
EOF
    chmod +x "$work/bin/mise"
    marker="$BATS_TEST_TMPDIR/$signal-pids"
    base_env SIGNAL_PIDS="$marker" sh -c 'trap - HUP INT TERM; exec "$@"' signal-shell "$work/tests/release/with-node20.sh" -- true >"$BATS_TEST_TMPDIR/$signal.log" 2>&1 & wrapper=$!
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -e "$marker" ] && break; sleep 1; done
    [ -e "$marker" ]; read -r script_pid mise_pid child_pid gpg_link < "$marker"
    status=0; kill -"$signal" "$script_pid"; wait "$wrapper" || status=$?
    case "$signal" in HUP) [ "$status" -eq 129 ] ;; INT) [ "$status" -eq 130 ] ;; TERM) [ "$status" -eq 143 ] ;; esac || { printf '%s status=%s log=' "$signal" "$status" >&3; cat "$BATS_TEST_TMPDIR/$signal.log" >&3; false; }
    assert_pid_reaped "$mise_pid"; assert_pid_reaped "$child_pid"
    [ ! -e "$gpg_link" ] || { printf '%s gpg remains: %s\n' "$signal" "$gpg_link" >&3; false; }
    [ ! -e "$work/.cortexkit/v0.1-release/node20.env" ]; [ ! -d "$work/.cortexkit/v0.1-release/node20.lock" ]
  done
}

@test "INT during provisioning returns 130 and removes transient state" {
  [ -n "$(command -v perl)" ]
  cat > "$work/bin/mise" <<'EOF'
#!/bin/sh
[ "$1" = install ] || exit 1
sleep 30 &
root=${MISE_DATA_DIR%/mise/data}
printf '%s %s %s %s %s\n' "$PPID" "$$" "$!" "$GNUPGHOME" "$root" > "$SIGNAL_PIDS"
wait
EOF
  chmod +x "$work/bin/mise"
  supervisor="$BATS_TEST_TMPDIR/int-supervisor.pl"
  cat > "$supervisor" <<'PERL'
#!/usr/bin/env perl
use strict;
use warnings;
use POSIX qw(WNOHANG);
use Time::HiRes qw(sleep time);

my ($marker, @command) = @ARGV;
die "usage: int-supervisor.pl MARKER COMMAND...\n" unless defined $marker && @command;
my $script_pid = fork();
my $mise_pid;
die "fork: $!\n" unless defined $script_pid;
if ($script_pid == 0) {
  $SIG{INT} = 'DEFAULT';
  exec @command;
  die "exec $command[0]: $!\n";
}

my $waited = 0;
sub stop_child {
  return if $waited;
  kill 'TERM', $script_pid;
  kill 'TERM', -$mise_pid if defined $mise_pid;
  my $deadline = time + 5;
  my $reaped = 0;
  while (time < $deadline) {
    my $result = waitpid($script_pid, WNOHANG);
    if ($result == $script_pid || $result == -1) {
      $waited = 1;
      $reaped = 1;
      last;
    }
    sleep 0.05;
  }
  if (!$reaped) {
    kill 'KILL', $script_pid;
    waitpid($script_pid, 0);
    $waited = 1;
  }
  return unless defined $mise_pid;
  $deadline = time + 5;
  while (kill 0, -$mise_pid) {
    last if time >= $deadline;
    sleep 0.05;
  }
  kill 'KILL', -$mise_pid if kill 0, -$mise_pid;
}

my $deadline = time + 10;
while (!-e $marker && time < $deadline) {
  sleep 0.05;
}
if (!-e $marker) {
  stop_child();
  die "timed out waiting for SIGNAL_PIDS\n";
}
open my $fh, '<', $marker or do { stop_child(); die "open $marker: $!\n"; };
my $line = <$fh>;
close $fh;
my @fields = defined $line ? split(/\s+/, $line) : ();
if (@fields != 5 || $fields[0] ne "$script_pid" || grep { !/^[1-9][0-9]*\z/ } @fields[0..2] || !defined $fields[3] || $fields[3] !~ m{^/} || !defined $fields[4] || $fields[4] !~ m{^/}) {
  stop_child();
  die "invalid SIGNAL_PIDS\n";
}
$mise_pid = $fields[1];
kill 'INT', $script_pid or do { stop_child(); die "INT $script_pid: $!\n"; };
my $status;
$deadline = time + 10;
while (time < $deadline) {
  my $result = waitpid($script_pid, WNOHANG);
  if ($result == $script_pid) {
    $status = $?;
    $waited = 1;
    last;
  }
  sleep 0.05;
}
if (!defined $status) {
  stop_child();
  die "timed out waiting for $script_pid\n";
}
die "expected exit 130, got status $status\n" unless ($status >> 8) == 130 && ($status & 127) == 0;
print join(' ', @fields), "\n";
PERL
  chmod +x "$supervisor"
  marker="$BATS_TEST_TMPDIR/int-pids"
  run base_env SIGNAL_PIDS="$marker" "$supervisor" "$marker" "$work/tests/release/with-node20.sh" -- true
  [ "$status" -eq 0 ]
  read -r script_pid mise_pid child_pid gpg_link root < <(printf '%s\n' "$output")
  [[ "$script_pid" =~ ^[1-9][0-9]*$ ]]; [[ "$mise_pid" =~ ^[1-9][0-9]*$ ]]; [[ "$child_pid" =~ ^[1-9][0-9]*$ ]]
  assert_pid_reaped "$mise_pid"; assert_pid_reaped "$child_pid"
  [ ! -e "$gpg_link" ]; [ ! -e "$root" ]
  [ ! -d "$work/.cortexkit/v0.1-release/node20.lock" ]; [ ! -e "$work/.cortexkit/v0.1-release/node20.env" ]
}

@test "successful provisioning preserves child status and child signal behavior, and cleanup is idempotent" {
  write_fake_mise
  run base_env PROVISION_LOG="$BATS_TEST_TMPDIR/provisions" "$work/tests/release/with-node20.sh" -- sh -c 'exit 42'
  [ "$status" -eq 42 ]
  run base_env "$work/tests/release/with-node20.sh" -- sh -c 'kill -TERM $$'
  [ "$status" -eq 143 ]
  root="$(descriptor_value ROOT)"; : > "$private_tmp/unrelated-sentinel"
  run base_env "$work/tests/release/with-node20.sh" --cleanup
  [ "$status" -eq 0 ]; [ ! -e "$root" ]; [ -e "$private_tmp/unrelated-sentinel" ]
  run base_env "$work/tests/release/with-node20.sh" --cleanup
  [ "$status" -eq 0 ]; [ -e "$private_tmp/unrelated-sentinel" ]
}
