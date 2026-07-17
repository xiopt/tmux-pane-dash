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
    value="$FAKE_TMUX_VALUES/$pane/$key"
    [ -f "$value" ] || exit 1
    cat "$value"
    ;;
  capture-pane)
    log "$*"
    cat "${FAKE_TMUX_CAPTURE:-/dev/null}"
    ;;
  *)
    log "$*"
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

@test "preview captures alternate-screen content after a path and title header" {
  pane 1
  export FAKE_TMUX_CAPTURE="$BATS_TEST_TMPDIR/capture"
  printf 'alternate content\n' > "$FAKE_TMUX_CAPTURE"
  FZF_PREVIEW_COLUMNS=5 run "$PREVIEW" %5
  [ "$status" -eq 0 ]
  [[ "$output" == *'/work/project'* ]]
  [[ "$output" == *'Fix preview'* ]]
  [[ "$output" == *'alternate content'* ]]
  grep -Fx 'capture-pane -aep -t %5' "$FAKE_TMUX_LOG"
}

@test "preview reports a disappeared pane without leaking tmux errors" {
  run "$PREVIEW" %999
  [ "$status" -eq 0 ]
  [ "$output" = '[pane %999 is gone]' ]
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

@test "actions do nothing for a nonexistent pane" {
  run "$ACTION" jump %999 /dev/ttys001
  [ "$status" -eq 0 ]
  [ ! -s "$FAKE_TMUX_LOG" ]
}
