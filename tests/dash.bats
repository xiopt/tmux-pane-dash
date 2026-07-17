@test "outer mode reports a useful error outside tmux" {
  SCRIPT="$BATS_TEST_DIRNAME/../scripts/dash.sh"

  run env -u TMUX "$SCRIPT"

  [ "$status" -eq 1 ]
  [ "$output" = "pane-dash: must be run inside tmux" ]
}

@test "inner mode reloads list.sh when scripts live in a path with spaces" {
  copy_root="$BATS_TEST_TMPDIR/with space"
  mkdir -p "$copy_root" "$BATS_TEST_TMPDIR/bin"
  cp -R "$BATS_TEST_DIRNAME/../scripts" "$copy_root/scripts"
  export FZF_LOG="$BATS_TEST_TMPDIR/fzf.log"

  cat > "$BATS_TEST_TMPDIR/bin/tmux" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  list-panes) exit 0 ;;
  show-option | display-message) exit 0 ;;
esac
EOF
  cat > "$BATS_TEST_TMPDIR/bin/fzf" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg; do
  case "$arg" in
    every\(1\):reload-sync\(*)
      command="${arg#every(1):reload-sync(}"
      command="${command%%)+refresh-preview}"
      bash -c "$command"
      printf 'reload succeeded\n' >> "$FZF_LOG"
      ;;
  esac
done
EOF
  chmod +x "$BATS_TEST_TMPDIR/bin/tmux" "$BATS_TEST_TMPDIR/bin/fzf"

  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" "$copy_root/scripts/dash.sh" --inner /dev/ttys001

  [ "$status" -eq 0 ]
  grep -Fx 'reload succeeded' "$FZF_LOG"
}

@test "inner mode pins fzf to bash and ignores a hostile defaults file" {
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  defaults_file="$BATS_TEST_TMPDIR/fzf-defaults"
  printf '%s\n' '--not-an-fzf-option' > "$defaults_file"
  export FZF_LOG="$BATS_TEST_TMPDIR/fzf.log"

  cat > "$BATS_TEST_TMPDIR/bin/tmux" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  list-panes) exit 0 ;;
  show-option | display-message) exit 0 ;;
esac
EOF
  cat > "$BATS_TEST_TMPDIR/bin/fzf" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
shell=""
transform=""
while [ $# -gt 0 ]; do
  case "$1" in
    --with-shell) shell="$2"; shift 2 ;;
    esc:transform:*) transform="${1#esc:transform:}"; shift ;;
    *) shift ;;
  esac
done
[ "$shell" = 'bash -c' ]
[ -z "${FZF_DEFAULT_OPTS_FILE:-}" ]
FZF_INPUT_STATE=enabled bash -c "$transform" >> "$FZF_LOG"
EOF
  chmod +x "$BATS_TEST_TMPDIR/bin/tmux" "$BATS_TEST_TMPDIR/bin/fzf"

  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" SHELL=/usr/bin/false \
    FZF_DEFAULT_OPTS_FILE="$defaults_file" "$BATS_TEST_DIRNAME/../scripts/dash.sh" --inner /dev/ttys001

  [ "$status" -eq 0 ]
  grep -Fx 'hide-input+rebind(j,k,g,G,q,/)' "$FZF_LOG"
}
