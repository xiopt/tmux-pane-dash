@test "outer mode reports a useful error outside tmux" {
  SCRIPT="$BATS_TEST_DIRNAME/../scripts/dash.sh"

  run env -u TMUX "$SCRIPT"

  [ "$status" -eq 1 ]
  [ "$output" = "pane-dash: must be run inside tmux" ]
}

@test "outer mode targets explicitly supplied client and source pane" {
  install_outer_stubs

  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" TMUX=stub \
    "$BATS_TEST_DIRNAME/../scripts/dash.sh" /dev/ttys042 %42

  [ "$status" -eq 0 ]
  grep -F 'display-popup -c /dev/ttys042 -t %42 -E -w 80% -h 70%' "$FAKE_TMUX_LOG"
  grep -F -- '--inner /dev/ttys042' "$FAKE_TMUX_LOG"
}

@test "outer mode queries client and source pane when arguments are absent" {
  install_outer_stubs

  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" TMUX=stub "$BATS_TEST_DIRNAME/../scripts/dash.sh"

  [ "$status" -eq 0 ]
  grep -Fx 'display-message -p #{client_tty}' "$FAKE_TMUX_LOG"
  grep -Fx 'display-message -p #{pane_id}' "$FAKE_TMUX_LOG"
  grep -F 'display-popup -c /dev/fallback-client -t %fallback-pane -E' "$FAKE_TMUX_LOG"
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

@test "inner mode uses the default adaptive preview layout" {
  install_inner_option_stubs

  run "$SCRIPT" --inner /dev/ttys001

  [ "$status" -eq 0 ]
  [ "$(<"$FZF_LOG")" = 'right,55%,border-left,<100(down,55%,border-top)' ]
}

@test "inner mode binds s only in navigation mode and advertises grouping" {
  export TMUX_STUB_DIR="$BATS_TEST_TMPDIR/stub"
  export FZF_LOG="$BATS_TEST_TMPDIR/fzf.log"
  mkdir -p "$TMUX_STUB_DIR/global" "$BATS_TEST_TMPDIR/bin"
  export PATH="$BATS_TEST_DIRNAME/stubs:$BATS_TEST_TMPDIR/bin:$PATH"
  SCRIPT="$BATS_TEST_DIRNAME/../scripts/dash.sh"

  cat > "$BATS_TEST_TMPDIR/bin/fzf" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$FZF_LOG"
EOF
  chmod +x "$BATS_TEST_TMPDIR/bin/fzf"

  run "$SCRIPT" --inner /dev/ttys001

  [ "$status" -eq 0 ]
  grep -Fx 'enter:jump  /:filter  s:group  ctrl-s:send  ctrl-z:zoom  q:quit' "$FZF_LOG"
  grep -F 'j:down,k:up,g:first,G:last,s:execute-silent(' "$FZF_LOG"
  grep -Fx '/:show-input+unbind(j,k,g,G,q,s,/)' "$FZF_LOG"
  grep -F 'hide-input+rebind(j,k,g,G,q,s,/)' "$FZF_LOG"
}

@test "inner mode uses custom adaptive preview options" {
  install_inner_option_stubs
  printf '%s' 'right,40%,border-left' > "$TMUX_STUB_DIR/global/@pane-dash-preview-layout"
  printf '%s' '120' > "$TMUX_STUB_DIR/global/@pane-dash-preview-threshold"
  printf '%s' 'down,65%,border-top' > "$TMUX_STUB_DIR/global/@pane-dash-preview-alt-layout"

  run "$SCRIPT" --inner /dev/ttys001

  [ "$status" -eq 0 ]
  [ "$(<"$FZF_LOG")" = 'right,40%,border-left,<120(down,65%,border-top)' ]
}

@test "inner mode falls back to the default preview threshold when invalid" {
  install_inner_option_stubs
  printf '%s' '000' > "$TMUX_STUB_DIR/global/@pane-dash-preview-threshold"

  run "$SCRIPT" --inner /dev/ttys001

  [ "$status" -eq 0 ]
  [ "$(<"$FZF_LOG")" = 'right,55%,border-left,<100(down,55%,border-top)' ]
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
  grep -Fx 'hide-input+rebind(j,k,g,G,q,s,/)' "$FZF_LOG"
}
install_outer_stubs() {
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  export FAKE_TMUX_LOG="$BATS_TEST_TMPDIR/tmux.log"
  : > "$FAKE_TMUX_LOG"

  cat > "$BATS_TEST_TMPDIR/bin/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
log() { printf '%s\n' "$*" >> "$FAKE_TMUX_LOG"; }

case "${1:-}" in
  -V) printf 'tmux 3.7b\n' ;;
  show-option) exit 0 ;;
  display-message)
    log "$*"
    if [ "${2:-}" = '-p' ]; then
      case "${3:-}" in
        '#{client_tty}') printf '/dev/fallback-client' ;;
        '#{pane_id}') printf '%%fallback-pane' ;;
      esac
    fi
    ;;
  display-popup) log "$*" ;;
esac
EOF
  cat > "$BATS_TEST_TMPDIR/bin/fzf" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = '--version' ] && printf '0.73.1\n'
EOF
  chmod +x "$BATS_TEST_TMPDIR/bin/tmux" "$BATS_TEST_TMPDIR/bin/fzf"
}

install_inner_option_stubs() {
  export TMUX_STUB_DIR="$BATS_TEST_TMPDIR/stub"
  export FZF_LOG="$BATS_TEST_TMPDIR/fzf.log"
  mkdir -p "$TMUX_STUB_DIR/global" "$BATS_TEST_TMPDIR/bin"
  export PATH="$BATS_TEST_DIRNAME/stubs:$BATS_TEST_TMPDIR/bin:$PATH"
  SCRIPT="$BATS_TEST_DIRNAME/../scripts/dash.sh"

  cat > "$BATS_TEST_TMPDIR/bin/fzf" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while [ $# -gt 0 ]; do
  case "$1" in
    --preview-window)
      printf '%s' "$2" > "$FZF_LOG"
      shift 2
      ;;
    *) shift ;;
  esac
done
EOF
  chmod +x "$BATS_TEST_TMPDIR/bin/fzf"
}
