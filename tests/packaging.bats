setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  SCRATCH="$BATS_TEST_TMPDIR/source"
  mkdir -p "$SCRATCH/pane-dash"
  cp "$ROOT/Makefile" "$SCRATCH/Makefile"
  cp "$ROOT/pane-dash/Cargo.toml" "$ROOT/pane-dash/Cargo.lock" "$SCRATCH/pane-dash/"

  FAKE_BIN="$BATS_TEST_TMPDIR/fake-bin"
  mkdir -p "$FAKE_BIN"
  export FAKE_LOG="$BATS_TEST_TMPDIR/fake.log"
  : > "$FAKE_LOG"

  cat > "$FAKE_BIN/cargo" <<'EOF'
#!/bin/sh
printf 'cargo\037%s\n' "$*" >> "$FAKE_LOG"
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
printf 'install\037%s\n' "$*" >> "$FAKE_LOG"
if [ "${FAIL_INSTALL:-}" = 1 ]; then
  exit 73
fi
if [ "$1" = -m ]; then
  mode=$2
  shift 2
fi
cp "$1" "$2"
chmod "$mode" "$2"
EOF
  chmod +x "$FAKE_BIN/cargo" "$FAKE_BIN/install"
}

fingerprint() {
  (cd "$1" && tar -cf - . | shasum -a 256 | awk '{print $1}')
}

source_fingerprint() {
  (cd "$1" && cat Makefile pane-dash/Cargo.toml pane-dash/Cargo.lock | shasum -a 256 | awk '{print $1}')
}

assert_mode_755() {
  [ "$(stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1")" = 755 ]
}

@test "bare make and build use the exact locked release cargo command and atomically create mode 0755 local binary" {
  run make -C "$SCRATCH" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -eq 0 ]
  grep -Fx $'cargo\037build --locked --release --manifest-path pane-dash/Cargo.toml' "$FAKE_LOG"
  grep -E '^install.*\.pane-dash\.[0-9]+$' "$FAKE_LOG"
  [ -x "$SCRATCH/bin/pane-dash" ]
  assert_mode_755 "$SCRATCH/bin/pane-dash"
  ! compgen -G "$SCRATCH/bin/.pane-dash.*" >/dev/null

  : > "$FAKE_LOG"
  run make -C "$SCRATCH" build CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"
  [ "$status" -eq 0 ]
  grep -Fx $'cargo\037build --locked --release --manifest-path pane-dash/Cargo.toml' "$FAKE_LOG"
}

@test "failed local staging preserves the old binary and removes its same-directory temporary file" {
  mkdir -p "$SCRATCH/bin"
  printf 'old binary\n' > "$SCRATCH/bin/pane-dash"
  chmod 755 "$SCRATCH/bin/pane-dash"

  run env FAIL_INSTALL=1 make -C "$SCRATCH" build CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -ne 0 ]
  [ "$(<"$SCRATCH/bin/pane-dash")" = 'old binary' ]
  ! compgen -G "$SCRATCH/bin/.pane-dash.*" >/dev/null
}

@test "install builds first and atomically installs mode 0755 to DESTDIR+BINDIR" {
  stage="$BATS_TEST_TMPDIR/stage root"
  bindir='/usr/local/custom bin'

  run make -C "$SCRATCH" install DESTDIR="$stage" BINDIR="$bindir" CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -eq 0 ]
  [ -x "$SCRATCH/bin/pane-dash" ]
  [ -x "$stage$bindir/pane-dash" ]
  [ "$(grep -Ec '^install.*\.pane-dash\.[0-9]+$' "$FAKE_LOG")" -eq 2 ]
  assert_mode_755 "$stage$bindir/pane-dash"
  ! compgen -G "$stage$bindir/.pane-dash.*" >/dev/null
}

@test "install staging failure preserves old destination and removes its temporary file" {
  stage="$BATS_TEST_TMPDIR/stage"
  destination="$stage/usr/local/bin/pane-dash"
  mkdir -p "${destination%/*}"
  printf 'old installed binary\n' > "$destination"
  chmod 755 "$destination"

  run env FAIL_INSTALL=1 make -C "$SCRATCH" install DESTDIR="$stage" PREFIX=/usr/local CARGO="$FAKE_BIN/cargo" INSTALL="$FAKE_BIN/install"

  [ "$status" -ne 0 ]
  [ "$(<"$destination")" = 'old installed binary' ]
  ! compgen -G "${destination%/*}/.pane-dash.*" >/dev/null
}

@test "CARGO and INSTALL honor environment defaults and command-line overrides" {
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
  [ "$(grep -c '^cargo' "$FAKE_LOG")" -eq 1 ]
  [ "$(grep -c '^install' "$FAKE_LOG")" -eq 2 ]

  : > "$FAKE_LOG"
  run env CARGO="$env_cargo" INSTALL="$env_install" make -C "$SCRATCH" install DESTDIR="$BATS_TEST_TMPDIR/stage-cli" CARGO="$cli_cargo" INSTALL="$cli_install"
  [ "$status" -eq 0 ]
  [ "$(grep -c '^cargo' "$FAKE_LOG")" -eq 1 ]
  [ "$(grep -c '^install' "$FAKE_LOG")" -eq 2 ]
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
    [ "$outside_before" = "$(fingerprint "$outside")" ]
  done

  run make -C "$SCRATCH" help
  [ "$status" -eq 0 ]
  [ "$before" = "$(fingerprint "$SCRATCH")" ]
  [ "$output" = $'Targets:\n  build      Build pane-dash locally.\n  install    Build and install pane-dash.\n  uninstall  Remove the installed pane-dash binary.\n  clean      Remove local build outputs.\n\nVariables:\n  CARGO      Cargo command (default: cargo).\n  INSTALL    Install command (default: install).\n  PREFIX     Installation prefix (default: $(HOME)/.local).\n  BINDIR     Binary directory (default: $(PREFIX)/bin).\n  DESTDIR    Staging prefix (default: empty).\n\nInstall destination: $(DESTDIR)$(BINDIR)/pane-dash\nExamples:\n  make install\n  make install PREFIX=/usr/local\n  make install DESTDIR=/tmp/package PREFIX=/usr/local' ]
}
