setup() {
  export TMUX_STUB_DIR="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$TMUX_STUB_DIR/global"
  : > "$TMUX_STUB_DIR/calls.log"
  export PATH="$BATS_TEST_DIRNAME/stubs:$PATH"
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  SCRIPT="$BATS_TEST_DIRNAME/../pane_dash.tmux"
}

assert_call() {
  local index="$1"
  shift
  local expected actual
  expected="$(printf '%s\037' "$@")"
  actual="$(sed -n "${index}p" "$TMUX_STUB_DIR/calls.log")"
  [ "$actual" = "$expected" ]
}

assert_notification() {
  local index="$1"
  shift
  local expected actual
  expected="$(printf '%s\037' "$@")"
  actual="$(sed -n "${index}p" "$TMUX_STUB_DIR/notifications.log")"
  [ "$actual" = "$expected" ]
}

@test "binds dashboard, tag, and label actions with default keys" {
  run "$SCRIPT"

  [ "$status" -eq 0 ]
  assert_call 3 bind-key D run-shell "'$ROOT/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
  assert_call 4 bind-key T run-shell "\"$ROOT/scripts/tag.sh\" toggle '#{pane_id}'"
  assert_call 5 bind-key M command-prompt -p 'pane-dash label:' \
    "set-option -p @pane_dash_label_input \"%%%\" ; run-shell '\"$ROOT/scripts/tag.sh\" label-from-option \"#{pane_id}\"'"
}

@test "uses configured dashboard, tag, and label keys" {
  printf 'F' > "$TMUX_STUB_DIR/global/@pane-dash-key"
  printf 'g' > "$TMUX_STUB_DIR/global/@pane-dash-tag-key"
  printf 'L' > "$TMUX_STUB_DIR/global/@pane-dash-label-key"

  run "$SCRIPT"

  [ "$status" -eq 0 ]
  assert_call 3 bind-key F run-shell "'$ROOT/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
  assert_call 4 bind-key g run-shell "\"$ROOT/scripts/tag.sh\" toggle '#{pane_id}'"
  assert_call 5 bind-key L command-prompt -p 'pane-dash label:' \
    "set-option -p @pane_dash_label_input \"%%%\" ; run-shell '\"$ROOT/scripts/tag.sh\" label-from-option \"#{pane_id}\"'"
}

@test "uses fzf engine when no engine option is configured" {
  run "$SCRIPT"

  [ "$status" -eq 0 ]
  assert_call 3 bind-key D run-shell "'$ROOT/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
}

@test "resolves the rust binary from the plugin-local bin directory first" {
  printf 'rust' > "$TMUX_STUB_DIR/global/@pane-dash-engine"
  copy_root="$BATS_TEST_TMPDIR/plugin"
  mkdir -p "$copy_root/bin"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$copy_root/bin/pane-dash"
  chmod +x "$copy_root/bin/pane-dash"

  run "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_call 3 bind-key D run-shell \
    "'$copy_root/scripts/open_v2.sh' '$copy_root/bin/pane-dash' '#{client_tty}' '#{session_id}' '#{pane_id}'"
}

@test "quotes rust launcher paths in a plugin directory with spaces and metacharacters" {
  printf 'rust' > "$TMUX_STUB_DIR/global/@pane-dash-engine"
  copy_root="$BATS_TEST_TMPDIR/plugin with space \"\$dollar\`tick\`"
  mkdir -p "$copy_root/bin"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$copy_root/bin/pane-dash"
  chmod +x "$copy_root/bin/pane-dash"

  run "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_call 3 bind-key D run-shell \
    "'$copy_root/scripts/open_v2.sh' '$copy_root/bin/pane-dash' '#{client_tty}' '#{session_id}' '#{pane_id}'"
}

@test "falls back to fzf with a hint when the rust binary is missing" {
  printf 'rust' > "$TMUX_STUB_DIR/global/@pane-dash-engine"
  export PATH="$BATS_TEST_DIRNAME/stubs:/usr/bin:/bin"
  copy_root="$BATS_TEST_TMPDIR/plugin-no-bin"
  mkdir -p "$copy_root"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"

  run "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_notification 1 display-message \
    'pane-dash: rust engine selected but pane-dash binary not found; using fzf'
  assert_call 3 bind-key D run-shell "'$copy_root/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
}

@test "open_v2 passes the exact popup argv with defaults" {
  run "$ROOT/scripts/open_v2.sh" /tmp/pane-dash /dev/ttys001 '$3' '%42'

  [ "$status" -eq 0 ]
  assert_call 2 display-popup -E -c /dev/ttys001 -t '%42' -w 90% -h 85% \
    /tmp/pane-dash /dev/ttys001 '$3' '%42'
}

@test "quotes script paths when installed in a directory with spaces" {
  copy_root="$BATS_TEST_TMPDIR/with space"
  mkdir -p "$copy_root"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"

  run "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_call 3 bind-key D run-shell "'$copy_root/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
  assert_call 4 bind-key T run-shell "\"$copy_root/scripts/tag.sh\" toggle '#{pane_id}'"
}

@test "installs additive indexed focus hooks without replacing user hook zero" {
  mkdir -p "$TMUX_STUB_DIR/hooks"
  printf '%s' 'display-message user-focus-hook' > "$TMUX_STUB_DIR/hooks/client-focus-in[0]"
  run "$SCRIPT"

  [ "$status" -eq 0 ]
  assert_call 1 set-hook -g 'client-focus-in[31337]' 'set-option -gF "@pane_dash_focus_#{hook_client}" "1"'
  assert_call 2 set-hook -g 'client-focus-out[31337]' 'set-option -gF "@pane_dash_focus_#{hook_client}" "0"'
  [ "$(<"$TMUX_STUB_DIR/hooks/client-focus-in[0]")" = 'display-message user-focus-hook' ]
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(<"$TMUX_STUB_DIR/hooks/client-focus-in[0]")" = 'display-message user-focus-hook' ]
  [ "$(<"$TMUX_STUB_DIR/hooks/client-focus-in[31337]")" = 'set-option -gF "@pane_dash_focus_#{hook_client}" "1"' ]
}

@test "open_v2 initializes the owner focus option before opening its popup" {
  run "$ROOT/scripts/open_v2.sh" /tmp/pane-dash /dev/ttys001 '$3' '%42'

  [ "$status" -eq 0 ]
  assert_call 1 set-option -g @pane_dash_focus_/dev/ttys001 1
}
