setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  SCRATCH="$BATS_TEST_TMPDIR/source"
  mkdir -p "$SCRATCH/pane-dash/src" "$SCRATCH/scripts" "$SCRATCH/docs"
  cp "$ROOT/Makefile" "$SCRATCH/Makefile"
  cp "$ROOT/pane-dash/Cargo.toml" "$ROOT/pane-dash/Cargo.lock" "$SCRATCH/pane-dash/"
  cp "$ROOT/pane-dash/src/main.rs" "$SCRATCH/pane-dash/src/"
  cp "$ROOT/README.md" "$SCRATCH/README.md"
  cp "$ROOT/pane_dash.tmux" "$SCRATCH/"
  cp "$ROOT/scripts/open.sh" "$ROOT/scripts/tag.sh" "$SCRATCH/scripts/"
  cp "$ROOT/docs/superpowers/specs/2026-07-22-v2-phase7-packaging-design.md" "$SCRATCH/docs/"

  FAKE_BIN="$BATS_TEST_TMPDIR/fake-bin"
  mkdir -p "$FAKE_BIN"
  export FAKE_LOG="$BATS_TEST_TMPDIR/fake.log"
  : > "$FAKE_LOG"

  cat > "$FAKE_BIN/cargo" <<'EOF'
#!/bin/sh
printf 'cargo\037%s\037%s\n' "$0" "$*" >> "$FAKE_LOG"
if [ "${1:-}" = clean ]; then
  rm -rf pane-dash/target
  exit 0
fi
mkdir -p pane-dash/target/release
printf '#!/bin/sh\nexit 0\n' > pane-dash/target/release/pane-dash
chmod 755 pane-dash/target/release/pane-dash
EOF
  cat > "$FAKE_BIN/install" <<'EOF'
#!/bin/sh
set -eu
mode=
if [ "${1:-}" = -m ]; then
  mode=$2
  shift 2
fi
source=$1
destination=$2
printf 'install\037%s\037%s\037%s\n' "$0" "$source" "$destination" >> "$FAKE_LOG"

stage=
case "$source" in
  pane-dash/target/release/pane-dash) stage=build ;;
  bin/pane-dash) stage=destination ;;
  *) stage=unknown ;;
esac

case "$stage" in
  build)
    fail=${FAIL_BUILD_STAGE:-}
    block=${BLOCK_BUILD_STAGE:-}
    ;;
  destination)
    fail=${FAIL_DEST_STAGE:-}
    block=${BLOCK_DEST_STAGE:-}
    ;;
  *)
    fail=
    block=
    ;;
esac

if [ "$fail" = 1 ]; then
  printf 'partial %s\n' "$stage" > "$destination"
  chmod "${mode:-755}" "$destination"
  [ "$stage" = build ] && exit 73
  [ "$stage" = destination ] && exit 74
fi

if [ "$block" = 1 ]; then
  : "${READY_MARKER:?READY_MARKER is required while blocking}"
  : "${RELEASE_MARKER:?RELEASE_MARKER is required while blocking}"
  printf 'partial %s\n' "$stage" > "$destination"
  chmod "${mode:-755}" "$destination"
  printf 'fake_pid=%s recipe_pid=%s stage=%s\n' "$$" "$PPID" "$stage" > "$READY_MARKER.$$.ready"
  while [ ! -e "$RELEASE_MARKER" ]; do
    sleep 0.01
  done
fi

cp "$source" "$destination"
chmod "$mode" "$destination"
EOF
  chmod +x "$FAKE_BIN/cargo" "$FAKE_BIN/install"
}

fingerprint() {
  (cd "$1" && tar -cf - . | shasum -a 256 | awk '{print $1}')
}

source_fingerprint() {
  (
    cd "$1" || return
    find . -type f ! -path './pane-dash/target/*' ! -path './bin/*' -exec shasum -a 256 {} \; \
      | LC_ALL=C sort \
      | shasum -a 256 \
      | awk '{print $1}'
  )
}

assert_mode() {
  [ "$(stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1")" = "$2" ]
}

assert_no_temporary() {
  ! compgen -G "$1/.pane-dash.tmp.*" >/dev/null
}

wait_for_count() {
  local pattern=$1 expected=$2 deadline=$((SECONDS + 5)) count
  while :; do
    count=$(compgen -G "$pattern" | wc -l | tr -d ' ')
    [ "$count" -ge "$expected" ] && return 0
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.01
  done
}

wait_for_exit() {
  local pid=$1 deadline=$((SECONDS + 5)) state
  while :; do
    state=$(ps -p "$pid" -o stat= 2>/dev/null || :)
    [ -z "$state" ] || [[ "$state" == Z* ]] && return 0
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.01
  done
}

wait_for_no_temporary() {
  local directory=$1 deadline=$((SECONDS + 5))
  while :; do
    compgen -G "$directory/.pane-dash.tmp.*" >/dev/null || return 0
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.01
  done
}

wait_for_signal_effect() {
  local temporary_directory=$1 command=$2 attempt current
  for attempt in {1..50}; do
    current=$(ps -p "$RECIPE_PID" -o command= 2>/dev/null || :)
    if ! compgen -G "$temporary_directory/.pane-dash.tmp.*" >/dev/null \
      && { [ -z "$current" ] || [ "$current" != "$command" ]; }; then
      return 0
    fi
    sleep 0.01
  done
  return 1
}

start_make() {
  local target=$1 output=$2
  shift 2
  (cd "$SCRATCH" && exec python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' env "$@" make "$target") >"$output" 2>&1 &
  MAKE_PID=$!
}

read_ready_processes() {
  local marker=$1 line
  line=$(<"$marker")
  BLOCKER_PID=${line#fake_pid=}
  BLOCKER_PID=${BLOCKER_PID%% *}
  RECIPE_PID=${line#*recipe_pid=}
  RECIPE_PID=${RECIPE_PID%% *}
}

assert_recipe_shell() {
  local command
  command=$(ps -p "$RECIPE_PID" -o command=)
  [[ "$command" == *'.pane-dash.tmp.'* ]]
  RECIPE_COMMAND=$command
}

stop_blocked_make() {
  local signal=$1 temporary_directory=$2 release_marker=$3
  assert_recipe_shell
  kill "-$signal" "$RECIPE_PID"
  if wait_for_signal_effect "$temporary_directory" "$RECIPE_COMMAND"; then
    [ -n "$(ps -p "$BLOCKER_PID" -o stat= 2>/dev/null || :)" ]
  fi
  touch "$release_marker"
  if ! wait_for_exit "$RECIPE_PID" || ! wait_for_no_temporary "$temporary_directory"; then
    ps -p "$MAKE_PID,$RECIPE_PID,$BLOCKER_PID" -o pid,ppid,pgid,stat,command >&2 || :
    touch "$release_marker"
    wait "$MAKE_PID" 2>/dev/null || :
    return 1
  fi
  if ! wait_for_exit "$MAKE_PID"; then
    ps -p "$MAKE_PID,$RECIPE_PID,$BLOCKER_PID" -o pid,ppid,pgid,stat,command >&2 || :
    kill -KILL "$BLOCKER_PID" 2>/dev/null || :
    kill -KILL "$MAKE_PID" 2>/dev/null || :
    wait "$MAKE_PID" 2>/dev/null || :
    return 1
  fi
  if wait "$MAKE_PID"; then
    MAKE_STATUS=0
  else
    MAKE_STATUS=$?
  fi
}

@test "bare make and build use the exact locked release cargo command and atomically create mode 0755 local binary" {
  run make -C "$SCRATCH" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -eq 0 ]
  grep -Fx $'cargo\037'"$FAKE_BIN/cargo"$'\037build --locked --release --manifest-path pane-dash/Cargo.toml' "$FAKE_LOG"
  grep -E $'^install\037.*\037pane-dash/target/release/pane-dash\037bin/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG"
  [ -x "$SCRATCH/bin/pane-dash" ]
  assert_mode "$SCRATCH/bin/pane-dash" 755
  assert_no_temporary "$SCRATCH/bin"

  : > "$FAKE_LOG"
  run make -C "$SCRATCH" build CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"
  [ "$status" -eq 0 ]
  grep -Fx $'cargo\037'"$FAKE_BIN/cargo"$'\037build --locked --release --manifest-path pane-dash/Cargo.toml' "$FAKE_LOG"
}

@test "build staging failure preserves exact old content and mode without exposing the partial temporary" {
  mkdir -p "$SCRATCH/bin"
  printf 'old local binary\n' > "$SCRATCH/bin/pane-dash"
  chmod 711 "$SCRATCH/bin/pane-dash"

  run env FAIL_BUILD_STAGE=1 make -C "$SCRATCH" build CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -ne 0 ]
  [ "$(<"$SCRATCH/bin/pane-dash")" = 'old local binary' ]
  assert_mode "$SCRATCH/bin/pane-dash" 711
  assert_no_temporary "$SCRATCH/bin"
  ! grep -F $'\037bin/pane-dash' "$FAKE_LOG"
}

@test "destination staging failure logs a successful build copy then preserves exact old destination content and mode" {
  stage="$BATS_TEST_TMPDIR/stage"
  destination="$stage/usr/local/bin/pane-dash"
  mkdir -p "${destination%/*}"
  printf 'old installed binary\n' > "$destination"
  chmod 711 "$destination"

  run env FAIL_DEST_STAGE=1 make -C "$SCRATCH" install DESTDIR="$stage" PREFIX=/usr/local CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -eq 2 ]
  [ "$(<"$destination")" = 'old installed binary' ]
  assert_mode "$destination" 711
  assert_no_temporary "$SCRATCH/bin"
  assert_no_temporary "${destination%/*}"
  [ "$(grep -Ec $'^install\037.*\037pane-dash/target/release/pane-dash\037bin/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG")" -eq 1 ]
  [ "$(grep -Ec $'^install\037.*\037bin/pane-dash\037.*/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG")" -eq 1 ]
}

@test "TERM ends blocked build recipe shell, preserves the old local binary, and never resumes to mv" {
  ready="$BATS_TEST_TMPDIR/build-ready"
  release="$BATS_TEST_TMPDIR/build-release"
  output="$BATS_TEST_TMPDIR/build-output"
  mkdir -p "$SCRATCH/bin"
  printf 'old local binary\n' > "$SCRATCH/bin/pane-dash"
  chmod 711 "$SCRATCH/bin/pane-dash"

  start_make build "$output" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install" BLOCK_BUILD_STAGE=1 READY_MARKER="$ready" RELEASE_MARKER="$release"
  wait_for_count "$ready.*.ready" 1
  marker=$(compgen -G "$ready.*.ready")
  read_ready_processes "$marker"
  stop_blocked_make TERM "$SCRATCH/bin" "$release"

  [ "$MAKE_STATUS" -eq 143 ] || grep -F 'Error 143' "$output"
  [ "$(<"$SCRATCH/bin/pane-dash")" = 'old local binary' ]
  assert_mode "$SCRATCH/bin/pane-dash" 711
  assert_no_temporary "$SCRATCH/bin"
}

@test "INT ends blocked destination recipe shell after build, preserves the old install, and never resumes to mv" {
  ready="$BATS_TEST_TMPDIR/destination-ready"
  release="$BATS_TEST_TMPDIR/destination-release"
  output="$BATS_TEST_TMPDIR/destination-output"
  stage="$BATS_TEST_TMPDIR/stage"
  destination="$stage/usr/local/bin/pane-dash"
  mkdir -p "${destination%/*}"
  printf 'old installed binary\n' > "$destination"
  chmod 711 "$destination"

  start_make install "$output" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install" BLOCK_DEST_STAGE=1 READY_MARKER="$ready" RELEASE_MARKER="$release" DESTDIR="$stage" PREFIX=/usr/local
  wait_for_count "$ready.*.ready" 1
  marker=$(compgen -G "$ready.*.ready")
  read_ready_processes "$marker"
  stop_blocked_make INT "${destination%/*}" "$release"

  [ "$MAKE_STATUS" -eq 2 ]
  grep -F 'Error 130' "$output"
  [ "$(<"$destination")" = 'old installed binary' ]
  assert_mode "$destination" 711
  assert_no_temporary "${destination%/*}"
  [ "$(grep -Ec $'^install\037.*\037pane-dash/target/release/pane-dash\037bin/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG")" -eq 1 ]
  [ "$(grep -Ec $'^install\037.*\037bin/pane-dash\037.*/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG")" -eq 1 ]
}

@test "TERM ends blocked destination recipe shell after build and preserves the old install" {
  ready="$BATS_TEST_TMPDIR/destination-term-ready"
  release="$BATS_TEST_TMPDIR/destination-term-release"
  output="$BATS_TEST_TMPDIR/destination-term-output"
  stage="$BATS_TEST_TMPDIR/stage-term"
  destination="$stage/usr/local/bin/pane-dash"
  mkdir -p "${destination%/*}"
  printf 'old installed binary\n' > "$destination"
  chmod 711 "$destination"

  start_make install "$output" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install" BLOCK_DEST_STAGE=1 READY_MARKER="$ready" RELEASE_MARKER="$release" DESTDIR="$stage" PREFIX=/usr/local
  wait_for_count "$ready.*.ready" 1
  marker=$(compgen -G "$ready.*.ready")
  read_ready_processes "$marker"
  stop_blocked_make TERM "${destination%/*}" "$release"

  [ "$MAKE_STATUS" -eq 143 ] || grep -F 'Error 143' "$output"
  [ "$(<"$destination")" = 'old installed binary' ]
  assert_mode "$destination" 711
  assert_no_temporary "${destination%/*}"
  [ "$(grep -Ec $'^install\037.*\037pane-dash/target/release/pane-dash\037bin/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG")" -eq 1 ]
  [ "$(grep -Ec $'^install\037.*\037bin/pane-dash\037.*/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG")" -eq 1 ]
}

@test "install builds first and atomically installs mode 0755 to DESTDIR+BINDIR" {
  stage="$BATS_TEST_TMPDIR/stage root"
  bindir='/usr/local/custom bin'

  run make -C "$SCRATCH" install DESTDIR="$stage" BINDIR="$bindir" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -eq 0 ]
  [ -x "$SCRATCH/bin/pane-dash" ]
  [ -x "$stage$bindir/pane-dash" ]
  [ "$(grep -c '^install' "$FAKE_LOG")" -eq 2 ]
  assert_mode "$stage$bindir/pane-dash" 755
  assert_no_temporary "$stage$bindir"
}

@test "CARGO and INSTALL use distinct executable identities for environment defaults and command-line overrides" {
  env_cargo="$FAKE_BIN/environment-cargo"
  cli_cargo="$FAKE_BIN/command-cargo"
  env_install="$FAKE_BIN/environment-install"
  cli_install="$FAKE_BIN/command-install"
  cp "$FAKE_BIN/cargo" "$env_cargo"
  cp "$FAKE_BIN/cargo" "$cli_cargo"
  cp "$FAKE_BIN/install" "$env_install"
  cp "$FAKE_BIN/install" "$cli_install"
  chmod +x "$env_cargo" "$cli_cargo" "$env_install" "$cli_install"

  run env CARGO="$env_cargo" INSTALL="$env_install" make -C "$SCRATCH" install DESTDIR="$BATS_TEST_TMPDIR/stage-env"
  [ "$status" -eq 0 ]
  grep -F $'cargo\037'"$env_cargo"$'\037' "$FAKE_LOG"
  [ "$(grep -Fc $'install\037'"$env_install"$'\037' "$FAKE_LOG")" -eq 2 ]
  ! grep -F $'cargo\037'"$cli_cargo"$'\037' "$FAKE_LOG"
  ! grep -F $'install\037'"$cli_install"$'\037' "$FAKE_LOG"

  : > "$FAKE_LOG"
  run env CARGO="$env_cargo" INSTALL="$env_install" make -C "$SCRATCH" install DESTDIR="$BATS_TEST_TMPDIR/stage-cli" CARGO="$cli_cargo" INSTALL="$cli_install"
  [ "$status" -eq 0 ]
  grep -F $'cargo\037'"$cli_cargo"$'\037' "$FAKE_LOG"
  [ "$(grep -Fc $'install\037'"$cli_install"$'\037' "$FAKE_LOG")" -eq 2 ]
  ! grep -F $'cargo\037'"$env_cargo"$'\037' "$FAKE_LOG"
  ! grep -F $'install\037'"$env_install"$'\037' "$FAKE_LOG"
}

@test "explicitly empty CARGO and INSTALL overrides fail instead of using defaults" {
  run env PATH="$FAKE_BIN:$PATH" make -C "$SCRATCH" build CARGO= INSTALL="$FAKE_BIN/install"
  [ "$status" -ne 0 ]
  ! grep -F $'cargo\037' "$FAKE_LOG"

  : > "$FAKE_LOG"
  run env PATH="$FAKE_BIN:$PATH" make -C "$SCRATCH" build CARGO="$FAKE_BIN/cargo" INSTALL=
  [ "$status" -ne 0 ]
  grep -F $'cargo\037'"$FAKE_BIN/cargo"$'\037' "$FAKE_LOG"
  ! grep -F $'install\037' "$FAKE_LOG"
}

@test "explicit empty PREFIX uses /bin beneath DESTDIR" {
  stage="$BATS_TEST_TMPDIR/empty-prefix-stage"

  run make -C "$SCRATCH" install DESTDIR="$stage" PREFIX= CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -eq 0 ]
  [ -x "$stage/bin/pane-dash" ]
}

@test "explicit empty BINDIR installs directly beneath DESTDIR" {
  stage="$BATS_TEST_TMPDIR/empty-bindir-stage"

  run make -C "$SCRATCH" install DESTDIR="$stage" BINDIR= CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -eq 0 ]
  [ -x "$stage/pane-dash" ]
}

@test "explicit empty DESTDIR leaves an absolute BINDIR unstaged" {
  bindir="$BATS_TEST_TMPDIR/absolute-bindir"

  run make -C "$SCRATCH" install DESTDIR= BINDIR="$bindir" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -eq 0 ]
  [ -x "$bindir/pane-dash" ]
}

@test "two concurrent builds use distinct temporaries and leave one complete mode 0755 local binary" {
  ready="$BATS_TEST_TMPDIR/build-ready"
  release="$BATS_TEST_TMPDIR/build-release"
  start_make build "$BATS_TEST_TMPDIR/build-one" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install" BLOCK_BUILD_STAGE=1 READY_MARKER="$ready" RELEASE_MARKER="$release"
  first_pid=$MAKE_PID
  start_make build "$BATS_TEST_TMPDIR/build-two" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install" BLOCK_BUILD_STAGE=1 READY_MARKER="$ready" RELEASE_MARKER="$release"
  second_pid=$MAKE_PID
  wait_for_count "$ready.*.ready" 2
  touch "$release"
  wait_for_exit "$first_pid"
  wait_for_exit "$second_pid"
  wait "$first_pid"
  wait "$second_pid"

  [ "$(grep -Ec $'^install\037.*\037pane-dash/target/release/pane-dash\037bin/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG")" -eq 2 ]
  [ "$(grep -E $'^install\037.*\037pane-dash/target/release/pane-dash\037bin/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG" | awk -F '\037' '{print $4}' | sort -u | wc -l | tr -d ' ')" -eq 2 ]
  [ "$(<"$SCRATCH/bin/pane-dash")" = $'#!/bin/sh\nexit 0' ]
  assert_mode "$SCRATCH/bin/pane-dash" 755
  assert_no_temporary "$SCRATCH/bin"
}

@test "two concurrent installs use distinct temporaries and leave one complete mode 0755 destination binary" {
  ready="$BATS_TEST_TMPDIR/destination-ready"
  release="$BATS_TEST_TMPDIR/destination-release"
  stage="$BATS_TEST_TMPDIR/stage"
  start_make install "$BATS_TEST_TMPDIR/install-one" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install" BLOCK_DEST_STAGE=1 READY_MARKER="$ready" RELEASE_MARKER="$release" DESTDIR="$stage" PREFIX=/usr/local
  first_pid=$MAKE_PID
  start_make install "$BATS_TEST_TMPDIR/install-two" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install" BLOCK_DEST_STAGE=1 READY_MARKER="$ready" RELEASE_MARKER="$release" DESTDIR="$stage" PREFIX=/usr/local
  second_pid=$MAKE_PID
  wait_for_count "$ready.*.ready" 2
  touch "$release"
  wait_for_exit "$first_pid"
  wait_for_exit "$second_pid"
  wait "$first_pid"
  wait "$second_pid"

  destination="$stage/usr/local/bin/pane-dash"
  [ "$(grep -Ec $'^install\037.*\037bin/pane-dash\037.*/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG")" -eq 2 ]
  [ "$(grep -E $'^install\037.*\037bin/pane-dash\037.*/\.pane-dash\.tmp\.[0-9]+$' "$FAKE_LOG" | awk -F '\037' '{print $4}' | sort -u | wc -l | tr -d ' ')" -eq 2 ]
  [ "$(<"$destination")" = $'#!/bin/sh\nexit 0' ]
  assert_mode "$destination" 755
  assert_no_temporary "${destination%/*}"
}

@test "quoted recipes support hostile source, destination, prefix, and bindir paths" {
  hostile_root="$BATS_TEST_TMPDIR/source space'\$dollar;semi#hash\`tick\`"
  cp -R "$SCRATCH" "$hostile_root"
  stage="$BATS_TEST_TMPDIR/stage space'\$dollar;semi#hash\`tick\`"
  prefix="/prefix space'\$dollar;semi#hash\`tick\`"
  bindir="/bin space'\$dollar;semi#hash\`tick\`"

  run env DESTDIR="$stage" PREFIX="$prefix" BINDIR="$bindir" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install" make -C "$hostile_root" install

  [ "$status" -eq 0 ]
  [ -x "$hostile_root/bin/pane-dash" ]
  [ -x "$stage$bindir/pane-dash" ]
}

@test "uninstall is idempotent and preserves destination directory and siblings" {
  destination="$BATS_TEST_TMPDIR/stage/usr/local/bin"
  mkdir -p "$destination"
  printf binary > "$destination/pane-dash"
  printf sibling > "$destination/keep"

  run make -C "$SCRATCH" uninstall DESTDIR="$BATS_TEST_TMPDIR/stage" PREFIX=/usr/local
  [ "$status" -eq 0 ]
  [ ! -e "$destination/pane-dash" ]
  [ -f "$destination/keep" ]
  [ -d "$destination" ]

  run make -C "$SCRATCH" uninstall DESTDIR="$BATS_TEST_TMPDIR/stage" PREFIX=/usr/local
  [ "$status" -eq 0 ]
  [ -f "$destination/keep" ]
}

@test "clean removes only generated local outputs and empty bin while preserving siblings and staged installs" {
  mkdir -p "$SCRATCH/pane-dash/target/keep" "$SCRATCH/bin" "$BATS_TEST_TMPDIR/stage/bin"
  printf generated > "$SCRATCH/bin/pane-dash"
  printf sibling > "$SCRATCH/bin/keep"
  printf installed > "$BATS_TEST_TMPDIR/stage/bin/pane-dash"
  before="$(source_fingerprint "$SCRATCH")"

  run make -C "$SCRATCH" clean CARGO="$FAKE_BIN/cargo"
  [ "$status" -eq 0 ]
  [ ! -e "$SCRATCH/pane-dash/target" ]
  [ ! -e "$SCRATCH/bin/pane-dash" ]
  [ -f "$SCRATCH/bin/keep" ]
  [ -f "$BATS_TEST_TMPDIR/stage/bin/pane-dash" ]
  [ -f "$SCRATCH/pane-dash/Cargo.lock" ]
  [ "$before" = "$(source_fingerprint "$SCRATCH")" ]

  rm "$SCRATCH/bin/keep"
  run make -C "$SCRATCH" clean CARGO="$FAKE_BIN/cargo"
  [ "$status" -eq 0 ]
  [ ! -d "$SCRATCH/bin" ]
}

@test "dry runs and help do not mutate checkout or invoke unsafe commands" {
  before="$(fingerprint "$SCRATCH")"
  outside="$BATS_TEST_TMPDIR/outside"
  mkdir -p "$outside"
  printf sentinel > "$outside/keep"
  outside_before="$(fingerprint "$outside")"
  for target in build install uninstall clean; do
    run make -C "$SCRATCH" -n "$target" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"
    [ "$status" -eq 0 ]
    [ "$before" = "$(fingerprint "$SCRATCH")" ]
    [[ "$output" != *sudo* ]]
    [[ "$output" != *git* ]]
    [[ "$output" != *curl* ]]
    [[ "$output" != *wget* ]]
    [[ "$output" != *'rm -rf'* ]]
    if [ "$target" = build ] || [ "$target" = install ] || [ "$target" = clean ]; then
      [[ "$output" == *cargo* ]]
    fi
    if [ "$target" = build ] || [ "$target" = install ]; then
      [[ "$output" == *install* ]]
      [[ "$output" == *mv* ]]
    fi
    [ "$outside_before" = "$(fingerprint "$outside")" ]
  done

  run make -C "$SCRATCH" help
  [ "$status" -eq 0 ]
  [ "$before" = "$(fingerprint "$SCRATCH")" ]
  [[ "$output" == *'CARGO      Cargo command (default: cargo).'* ]]
  [[ "$output" == *'Install executable (default: install; no embedded arguments).'* ]]
  [[ "$output" == *'PREFIX     Installation prefix (default: $(HOME)/.local).'* ]]
  [[ "$output" == *'BINDIR     Binary directory (default: $(PREFIX)/bin).'* ]]
  [[ "$output" == *'DESTDIR    Staging prefix (default: empty).'* ]]
  [[ "$output" == *'Install destination: $(DESTDIR)$(BINDIR)/pane-dash'* ]]
  [[ "$output" == *'make install'* ]]
  [[ "$output" == *'make install PREFIX=/usr/local'* ]]
  [[ "$output" == *'make install DESTDIR=/tmp/package PREFIX=/usr/local'* ]]
}

@test "Makefile uses POSIX shell defaults instead of GNU export and default HOME destination" {
  run grep -E '^export |\$\(shell|\.ONESHELL' "$SCRATCH/Makefile"
  [ "$status" -eq 1 ]

  home="$BATS_TEST_TMPDIR/home"
  run env HOME="$home" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install" make -C "$SCRATCH" install
  [ "$status" -eq 0 ]
  [ -x "$home/.local/bin/pane-dash" ]
}

@test "INSTALL executable path with spaces is treated as data" {
  spaced="$BATS_TEST_TMPDIR/install tool"
  cp "$FAKE_BIN/install" "$spaced"
  chmod +x "$spaced"

  run env CARGO="$FAKE_BIN/cargo" INSTALL="$spaced" make -C "$SCRATCH" build
  [ "$status" -eq 0 ]
  [ -x "$SCRATCH/bin/pane-dash" ]
}

@test "signal tests reject a cleanup-only TERM trap" {
  mutated="$BATS_TEST_TMPDIR/mutated-source"
  cp -R "$SCRATCH" "$mutated"
  python3 - "$mutated/Makefile" <<'PY'
from pathlib import Path
path = Path(__import__('sys').argv[1])
path.write_text(path.read_text().replace("trap 'exit 143' TERM", "trap ':' TERM"))
PY
  ready="$BATS_TEST_TMPDIR/mutated-ready"
  release="$BATS_TEST_TMPDIR/mutated-release"
  output="$BATS_TEST_TMPDIR/mutated-output"
  mkdir -p "$mutated/bin"
  printf 'old local binary\n' > "$mutated/bin/pane-dash"

  SCRATCH="$mutated"
  start_make build "$output" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install" BLOCK_BUILD_STAGE=1 READY_MARKER="$ready" RELEASE_MARKER="$release"
  wait_for_count "$ready.*.ready" 1
  marker=$(compgen -G "$ready.*.ready")
  read_ready_processes "$marker"
  assert_recipe_shell
  kill -TERM "$RECIPE_PID"
  touch "$release"
  wait_for_exit "$MAKE_PID"
  wait "$MAKE_PID" 2>/dev/null || :

  [ "$(<"$mutated/bin/pane-dash")" != 'old local binary' ]
}

@test "Makefile signal traps exit with conventional signal statuses" {
  run grep -F "trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM;" "$SCRATCH/Makefile"

  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 2 ]
}
