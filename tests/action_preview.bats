setup() {
  export FAKE_TMUX_VALUES="$BATS_TEST_TMPDIR/values"
  export FAKE_TMUX_LOG="$BATS_TEST_TMPDIR/tmux.log"
  mkdir -p "$FAKE_TMUX_VALUES/%5" "$BATS_TEST_TMPDIR/bin"
  : > "$FAKE_TMUX_LOG"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
  PREVIEW="$BATS_TEST_DIRNAME/../scripts/preview.sh"
  ACTION="$BATS_TEST_DIRNAME/../scripts/action.sh"

  cat > "$BATS_TEST_TMPDIR/bin/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
log() { printf '%s\n' "$*" >> "$FAKE_TMUX_LOG"; }

case "${1:-}" in
  display-message)
    [ "${2:-}" = "-p" ] || exit 1
    pane="$4"
    format="$5"
    key="${format#\#\{}"; key="${key%\}}"
    # tmux 3.7b returns success with no output for an unknown pane.
    if [[ "$format" == *'#{pane_id}'* ]] && [ "${FAKE_TMUX_VANISH_AFTER_FIRST_PROBE:-}" = "$pane" ]; then
      probes_file="$FAKE_TMUX_VALUES/$pane.probes"
      probes="$(cat "$probes_file" 2>/dev/null || echo 0)"
      probes=$((probes + 1))
      printf '%s' "$probes" > "$probes_file"
      [ "$probes" -eq 1 ] || exit 0
    fi
    rendered="$format"
    while [[ "$rendered" == *'#{'* ]]; do
      prefix="${rendered%%\#\{*}"
      remainder="${rendered#*\#\{}"
      field="${remainder%%\}*}"
      rendered_rest="${remainder#*\}}"
      value="$(cat "$FAKE_TMUX_VALUES/$pane/$field" 2>/dev/null || true)"
      rendered="$prefix$value$rendered_rest"
    done
    printf '%s' "$rendered"
    [ -z "${FAKE_TMUX_DISPLAY_LOG:-}" ] || log "$*"
    ;;
  capture-pane)
    log "$*"
    cat "${FAKE_TMUX_CAPTURE:-/dev/null}"
    ;;
  has-session)
    log "$*"
    [ "${FAKE_TMUX_SESSION_GONE:-}" != "${3:-}" ]
    ;;
  list-windows)
    log "$*"
    cat "${FAKE_TMUX_WINDOWS:-/dev/null}"
    ;;
  *)
    log "$*"
    [ "${FAKE_TMUX_FAIL_FINAL:-}" != "${1:-}" ] || exit 1
    ;;
esac
EOF
  chmod +x "$BATS_TEST_TMPDIR/bin/tmux"
}

pane() {
  printf '%%5' > "$FAKE_TMUX_VALUES/%5/pane_id"
  printf '%s' "${1:-0}" > "$FAKE_TMUX_VALUES/%5/alternate_on"
  printf '/work/project' > "$FAKE_TMUX_VALUES/%5/pane_current_path"
  printf 'Fix preview' > "$FAKE_TMUX_VALUES/%5/@pane_dash_title"
  printf 'opencode' > "$FAKE_TMUX_VALUES/%5/pane_current_command"
}

@test "preview captures the visible screen after a path and title header when alternate mode is active" {
  pane 1
  export FAKE_TMUX_CAPTURE="$BATS_TEST_TMPDIR/capture"
  printf 'alternate content\n' > "$FAKE_TMUX_CAPTURE"
  FZF_PREVIEW_COLUMNS=5 run "$PREVIEW" %5
  [ "$status" -eq 0 ]
  [[ "$output" == *'/work/project'* ]]
  [[ "$output" == *'Fix preview'* ]]
  [[ "$output" == *'alternate content'* ]]
  grep -Fx 'capture-pane -ep -t %5' "$FAKE_TMUX_LOG"
  ! grep -F -- '-a' "$FAKE_TMUX_LOG"
}

@test "preview gets pane identity, path, and title in one probe" {
  pane
  export FAKE_TMUX_DISPLAY_LOG=1

  run "$PREVIEW" %5

  [ "$status" -eq 0 ]
  [ "$(grep -c '^display-message ' "$FAKE_TMUX_LOG")" -eq 1 ]
  grep -F '#{pane_id}' "$FAKE_TMUX_LOG"
  grep -F '#{pane_current_path}' "$FAKE_TMUX_LOG"
  grep -F '#{@pane_dash_title}' "$FAKE_TMUX_LOG"
}

@test "preview captures the visible screen when alternate mode is inactive" {
  pane 0
  run "$PREVIEW" %5
  [ "$status" -eq 0 ]
  grep -Fx 'capture-pane -ep -t %5' "$FAKE_TMUX_LOG"
  ! grep -F -- '-a' "$FAKE_TMUX_LOG"
}

@test "preview reports a disappeared pane without leaking tmux errors" {
  run "$PREVIEW" %999
  [ "$status" -eq 0 ]
  [ "$output" = '[pane %999 is gone]' ]
  [ ! -s "$FAKE_TMUX_LOG" ]
}

@test "preview builds a multibyte separator without tr" {
  pane
  cat > "$BATS_TEST_TMPDIR/bin/tr" <<'EOF'
#!/usr/bin/env bash
cat
EOF
  chmod +x "$BATS_TEST_TMPDIR/bin/tr"
  FZF_PREVIEW_COLUMNS=5 run "$PREVIEW" %5
  [ "$status" -eq 0 ]
  [[ "$output" == *'─────'* ]]
}

@test "preview shows a session overview instead of capturing a pane" {
  export FAKE_TMUX_WINDOWS="$BATS_TEST_TMPDIR/windows"
  printf '0: editor * 2 panes\n1: logs   1 pane\n' > "$FAKE_TMUX_WINDOWS"

  run "$PREVIEW" '$1'

  [ "$status" -eq 0 ]
  [[ "$output" == *'▸ $1'* ]]
  [[ "$output" == *'0: editor * 2 panes'* ]]
  grep -Fx 'has-session -t $1' "$FAKE_TMUX_LOG"
  grep -F 'list-windows -t $1 -F' "$FAKE_TMUX_LOG"
  ! grep -F 'capture-pane' "$FAKE_TMUX_LOG"
}

@test "jump switches the requested client in one zoom-preserving command" {
  pane
  run "$ACTION" jump %5 /dev/ttys001
  [ "$status" -eq 0 ]
  grep -Fx 'switch-client -Z -c /dev/ttys001 -t %5' "$FAKE_TMUX_LOG"
  [ "$(wc -l < "$FAKE_TMUX_LOG")" -eq 1 ]
}

@test "zoom toggles target zoom before switching clients" {
  pane
  run "$ACTION" zoom %5 /dev/ttys001
  [ "$status" -eq 0 ]
  [ "$(sed -n '1p' "$FAKE_TMUX_LOG")" = 'resize-pane -Z -t %5' ]
  [ "$(sed -n '2p' "$FAKE_TMUX_LOG")" = 'switch-client -Z -c /dev/ttys001 -t %5' ]
}

@test "session jump uses its session id target" {
  run "$ACTION" jump '$1' /dev/ttys001

  [ "$status" -eq 0 ]
  grep -Fx 'has-session -t $1' "$FAKE_TMUX_LOG"
  grep -Fx 'switch-client -c /dev/ttys001 -t $1' "$FAKE_TMUX_LOG"
}

@test "session jump does nothing when the session is gone" {
  FAKE_TMUX_SESSION_GONE='$1' run "$ACTION" jump '$1' /dev/ttys001

  [ "$status" -eq 0 ]
  grep -Fx 'has-session -t $1' "$FAKE_TMUX_LOG"
  ! grep -F 'switch-client' "$FAKE_TMUX_LOG"
}

@test "session zoom is a plain jump" {
  run "$ACTION" zoom '$1' /dev/ttys001

  [ "$status" -eq 0 ]
  grep -Fx 'switch-client -c /dev/ttys001 -t $1' "$FAKE_TMUX_LOG"
  ! grep -F 'resize-pane' "$FAKE_TMUX_LOG"
}

@test "session send tells the user to select a pane" {
  tty="$BATS_TEST_TMPDIR/tty"
  : > "$tty"

  PANE_DASH_TTY="$tty" run "$ACTION" send '$1'

  [ "$status" -eq 0 ]
  [ "$(<"$tty")" = 'select a pane, not a session' ]
  [ ! -s "$FAKE_TMUX_LOG" ]
}

@test "jump exits silently when its final switch target vanishes" {
  FAKE_TMUX_FAIL_FINAL=switch-client run "$ACTION" jump %5 /dev/ttys001

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "send reports a vanished pane when its final delivery fails" {
  pane
  tty="$BATS_TEST_TMPDIR/tty"
  printf 'deploy this\n' > "$tty"

  FAKE_TMUX_FAIL_FINAL=send-keys PANE_DASH_TTY="$tty" run "$ACTION" send %5

  [ "$status" -eq 0 ]
  grep -F 'pane %5 vanished, aborted' "$tty"
}

@test "send injects a literal line then a separate Enter" {
  pane
  tty="$BATS_TEST_TMPDIR/tty"
  printf 'deploy this\n' > "$tty"
  PANE_DASH_TTY="$tty" run "$ACTION" send %5
  [ "$status" -eq 0 ]
  [ "$(sed -n '1p' "$FAKE_TMUX_LOG")" = 'send-keys -l -t %5 -- deploy this' ]
  [ "$(sed -n '2p' "$FAKE_TMUX_LOG")" = 'send-keys -t %5 Enter' ]
}

@test "send cancels on an empty injected line" {
  pane
  tty="$BATS_TEST_TMPDIR/tty"
  printf '\n' > "$tty"
  PANE_DASH_TTY="$tty" run "$ACTION" send %5
  [ "$status" -eq 0 ]
  [ ! -s "$FAKE_TMUX_LOG" ]
}

@test "send does not send when its pane is already gone" {
  tty="$BATS_TEST_TMPDIR/tty"
  : > "$tty"
  PANE_DASH_TTY="$tty" run "$ACTION" send %999
  [ "$status" -eq 0 ]
  [ ! -s "$FAKE_TMUX_LOG" ]
}

@test "send rechecks and aborts when the pane vanishes before delivery" {
  pane
  tty="$BATS_TEST_TMPDIR/tty"
  printf 'deploy this\n' > "$tty"
  FAKE_TMUX_VANISH_AFTER_FIRST_PROBE=%5 PANE_DASH_TTY="$tty" run "$ACTION" send %5
  [ "$status" -eq 0 ]
  [ ! -s "$FAKE_TMUX_LOG" ]
}

@test "actions do nothing for a nonexistent pane" {
  run "$ACTION" jump %999 /dev/ttys001
  [ "$status" -eq 0 ]
  [ ! -s "$FAKE_TMUX_LOG" ]
}
