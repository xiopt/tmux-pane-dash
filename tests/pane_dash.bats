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

assert_engine_query_count() {
  [ "$(grep -Fc $'show-option\037-gq\037@pane-dash-engine\037' "$TMUX_STUB_DIR/invocations.log")" -eq "$1" ]
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

@test "binds dashboard, tag, and label actions with default keys" {
  printf 'fzf' > "$TMUX_STUB_DIR/global/@pane-dash-engine"
  run "$SCRIPT"

  [ "$status" -eq 0 ]
  assert_call 5 bind-key D run-shell "'$ROOT/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
  assert_call 6 bind-key T run-shell "\"$ROOT/scripts/tag.sh\" toggle '#{pane_id}'"
  assert_call 7 bind-key M command-prompt -p 'pane-dash label:' \
    "set-option -p @pane_dash_label_input \"%%%\" ; run-shell '\"$ROOT/scripts/tag.sh\" label-from-option \"#{pane_id}\"'"
}

@test "uses configured dashboard, tag, and label keys" {
  printf 'F' > "$TMUX_STUB_DIR/global/@pane-dash-key"
  printf 'g' > "$TMUX_STUB_DIR/global/@pane-dash-tag-key"
  printf 'L' > "$TMUX_STUB_DIR/global/@pane-dash-label-key"
  printf 'fzf' > "$TMUX_STUB_DIR/global/@pane-dash-engine"

  run "$SCRIPT"

  [ "$status" -eq 0 ]
  assert_call 5 bind-key F run-shell "'$ROOT/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
  assert_call 6 bind-key g run-shell "\"$ROOT/scripts/tag.sh\" toggle '#{pane_id}'"
  assert_call 7 bind-key L command-prompt -p 'pane-dash label:' \
    "set-option -p @pane_dash_label_input \"%%%\" ; run-shell '\"$ROOT/scripts/tag.sh\" label-from-option \"#{pane_id}\"'"
}

@test "absent engine silently prefers the plugin-local Rust binary over PATH" {
  copy_root="$BATS_TEST_TMPDIR/plugin"
  path_root="$BATS_TEST_TMPDIR/path"
  mkdir -p "$copy_root/bin" "$path_root"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$copy_root/bin/pane-dash"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$path_root/pane-dash"
  chmod +x "$copy_root/bin/pane-dash"
  chmod +x "$path_root/pane-dash"

  run env PATH="$BATS_TEST_DIRNAME/stubs:$path_root:$PATH" "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_call 5 bind-key D run-shell \
    "'$copy_root/scripts/open.sh' '$copy_root/bin/pane-dash' '#{client_tty}' '#{session_id}' '#{pane_id}'"
  [ ! -s "$TMUX_STUB_DIR/notifications.log" ]
  assert_engine_query_count 1
}

@test "explicit rust resolves an executable PATH file to an absolute Rust binding" {
  printf 'rust' > "$TMUX_STUB_DIR/global/@pane-dash-engine"
  copy_root="$BATS_TEST_TMPDIR/plugin"
  path_root="$BATS_TEST_TMPDIR/path"
  mkdir -p "$copy_root" "$path_root"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$path_root/pane-dash"
  chmod +x "$path_root/pane-dash"

  run env PATH="$BATS_TEST_DIRNAME/stubs:$path_root:$PATH" "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_call 5 bind-key D run-shell \
    "'$copy_root/scripts/open.sh' '$path_root/pane-dash' '#{client_tty}' '#{session_id}' '#{pane_id}'"
  [ ! -s "$TMUX_STUB_DIR/notifications.log" ]
  assert_engine_query_count 1
}

@test "accepts a PATH symlink and normalizes a relative PATH component" {
  printf 'rust' > "$TMUX_STUB_DIR/global/@pane-dash-engine"
  copy_root="$BATS_TEST_TMPDIR/plugin"
  mkdir -p "$copy_root" "$BATS_TEST_TMPDIR/real-bin" "$BATS_TEST_TMPDIR/relative-bin"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$BATS_TEST_TMPDIR/real-bin/pane-dash"
  chmod +x "$BATS_TEST_TMPDIR/real-bin/pane-dash"
  ln -s "$BATS_TEST_TMPDIR/real-bin/pane-dash" "$BATS_TEST_TMPDIR/relative-bin/pane-dash"

  run bash -c "cd '$BATS_TEST_TMPDIR' && PATH='$BATS_TEST_DIRNAME/stubs:relative-bin':\"\$PATH\" '$copy_root/pane_dash.tmux'"

  [ "$status" -eq 0 ]
  physical_tmp="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
  assert_call 5 bind-key D run-shell \
    "'$copy_root/scripts/open.sh' '$physical_tmp/relative-bin/pane-dash' '#{client_tty}' '#{session_id}' '#{pane_id}'"
}

@test "rejects nonregular and nonexecutable candidates without evaluating shell names" {
  printf 'rust' > "$TMUX_STUB_DIR/global/@pane-dash-engine"
  copy_root="$BATS_TEST_TMPDIR/plugin"
  path_root="$BATS_TEST_TMPDIR/path"
  mkdir -p "$copy_root/bin/pane-dash" "$path_root/pane-dash"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  env_file="$BATS_TEST_TMPDIR/bash-env"
  cat > "$env_file" <<'EOF'
shopt -s expand_aliases
alias pane-dash='false'
pane-dash() { false; }
EOF

  run env BASH_ENV="$env_file" PATH="$BATS_TEST_DIRNAME/stubs:$path_root:$PATH" "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_notification 1 display-message \
    "pane-dash: Rust binary not found; using legacy fzf (run 'make build' in the plugin directory or 'make install')"
  assert_call 5 bind-key D run-shell "'$copy_root/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
}

@test "load does not invoke build install or network commands and Rust bindings have no runtime lookup" {
  copy_root="$BATS_TEST_TMPDIR/plugin"
  path_root="$BATS_TEST_TMPDIR/path"
  mkdir -p "$copy_root/bin" "$path_root"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  printf '#!/usr/bin/env bash\nexit 42\n' > "$copy_root/bin/pane-dash"
  chmod +x "$copy_root/bin/pane-dash"
  for command in cargo make install curl wget; do
    cat > "$path_root/$command" <<EOF
#!/usr/bin/env bash
printf '%s\n' '$command' >> "$BATS_TEST_TMPDIR/unsafe.log"
exit 99
EOF
    chmod +x "$path_root/$command"
  done

  run env PATH="$BATS_TEST_DIRNAME/stubs:$path_root:$PATH" "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  [ ! -e "$BATS_TEST_TMPDIR/unsafe.log" ]
  binding="$(sed -n '5p' "$TMUX_STUB_DIR/calls.log")"
  [[ "$binding" == *"$copy_root/bin/pane-dash"* ]]
  [[ "$binding" != *'command -v'* ]]
  [[ "$binding" != *'type -P'* ]]
  [[ "$binding" != *cargo* ]]
  [[ "$binding" != *make* ]]
  [[ "$binding" != *dash.sh* ]]
}

@test "explicit fzf always binds legacy and emits only its deprecation" {
  printf 'fzf' > "$TMUX_STUB_DIR/global/@pane-dash-engine"
  copy_root="$BATS_TEST_TMPDIR/plugin"
  mkdir -p "$copy_root/bin"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$copy_root/bin/pane-dash"
  chmod +x "$copy_root/bin/pane-dash"

  run "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_call 5 bind-key D run-shell "'$copy_root/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
  assert_notification 1 display-message \
    'pane-dash: @pane-dash-engine fzf is deprecated; supported through v2.x, removed no earlier than v3.0'
  [ "$(wc -l < "$TMUX_STUB_DIR/notifications.log" | tr -d ' ')" -eq 1 ]
  assert_engine_query_count 1
}

@test "invalid and explicit empty engines warn then use Rust-first" {
  copy_root="$BATS_TEST_TMPDIR/plugin"
  mkdir -p "$copy_root/bin"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$copy_root/bin/pane-dash"
  chmod +x "$copy_root/bin/pane-dash"

  for engine in invalid ''; do
    : > "$TMUX_STUB_DIR/calls.log"
    : > "$TMUX_STUB_DIR/notifications.log"
    : > "$TMUX_STUB_DIR/invocations.log"
    rm -rf "$TMUX_STUB_DIR/hooks" "$TMUX_STUB_DIR/server-options"
    rm -f "$TMUX_STUB_DIR/global/focus-events"
    printf '%s' "$engine" > "$TMUX_STUB_DIR/global/@pane-dash-engine"
    run "$copy_root/pane_dash.tmux"
    [ "$status" -eq 0 ]
    assert_call 5 bind-key D run-shell \
      "'$copy_root/scripts/open.sh' '$copy_root/bin/pane-dash' '#{client_tty}' '#{session_id}' '#{pane_id}'"
    assert_notification 1 display-message 'pane-dash: invalid @pane-dash-engine value; using Rust-first resolution'
    [ "$(wc -l < "$TMUX_STUB_DIR/notifications.log" | tr -d ' ')" -eq 1 ]
    assert_engine_query_count 1
  done
}

@test "missing Rust falls back once and invalid missing warns in order" {
  copy_root="$BATS_TEST_TMPDIR/plugin-no-bin"
  mkdir -p "$copy_root"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  export PATH="$BATS_TEST_DIRNAME/stubs:/usr/bin:/bin"

  run "$copy_root/pane_dash.tmux"
  [ "$status" -eq 0 ]
  assert_notification 1 display-message \
    "pane-dash: Rust binary not found; using legacy fzf (run 'make build' in the plugin directory or 'make install')"
  assert_call 5 bind-key D run-shell "'$copy_root/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
  assert_engine_query_count 1

  : > "$TMUX_STUB_DIR/calls.log"
  : > "$TMUX_STUB_DIR/notifications.log"
  : > "$TMUX_STUB_DIR/invocations.log"
  printf 'invalid' > "$TMUX_STUB_DIR/global/@pane-dash-engine"
  run "$copy_root/pane_dash.tmux"
  [ "$status" -eq 0 ]
  assert_notification 1 display-message 'pane-dash: invalid @pane-dash-engine value; using Rust-first resolution'
  assert_notification 2 display-message \
    "pane-dash: Rust binary not found; using legacy fzf (run 'make build' in the plugin directory or 'make install')"
  assert_engine_query_count 1
}

@test "quotes Rust launcher paths with spaces quotes and shell metacharacters" {
  printf 'rust' > "$TMUX_STUB_DIR/global/@pane-dash-engine"
  copy_root="$BATS_TEST_TMPDIR/plugin with space '\"\$dollar;#\`tick\`"
  mkdir -p "$copy_root/bin"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$copy_root/bin/pane-dash"
  chmod +x "$copy_root/bin/pane-dash"

  run "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_call 5 bind-key D run-shell \
    "$(shell_quote "$copy_root/scripts/open.sh") $(shell_quote "$copy_root/bin/pane-dash") '#{client_tty}' '#{session_id}' '#{pane_id}'"
}

@test "open passes the exact popup argv with defaults" {
  run "$ROOT/scripts/open.sh" /tmp/pane-dash /dev/ttys001 '$3' '%42'

  [ "$status" -eq 0 ]
  assert_call 2 display-popup -E -c /dev/ttys001 -t '%42' -w 90% -h 85% \
    /tmp/pane-dash /dev/ttys001 '$3' '%42'
}

@test "open uses configured popup geometry" {
  printf '77%%' > "$TMUX_STUB_DIR/global/@pane-dash-width"
  printf '66%%' > "$TMUX_STUB_DIR/global/@pane-dash-height"

  run "$ROOT/scripts/open.sh" /tmp/pane-dash /dev/ttys001 '$3' '%42'

  [ "$status" -eq 0 ]
  assert_call 2 display-popup -E -c /dev/ttys001 -t '%42' -w 77% -h 66% \
    /tmp/pane-dash /dev/ttys001 '$3' '%42'
}

@test "quotes script paths when installed in a directory with spaces" {
  copy_root="$BATS_TEST_TMPDIR/with space"
  mkdir -p "$copy_root"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"

  run "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_call 5 bind-key D run-shell "'$copy_root/scripts/dash.sh' '#{client_tty}' '#{pane_id}'"
  assert_call 6 bind-key T run-shell "\"$copy_root/scripts/tag.sh\" toggle '#{pane_id}'"
}

@test "appends a focus hook at the first free index without replacing a user hook" {
  mkdir -p "$TMUX_STUB_DIR/hooks"
  printf '%s' 'display-message user-focus-hook' > "$TMUX_STUB_DIR/hooks/client-focus-in[0]"

  run "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(<"$TMUX_STUB_DIR/hooks/client-focus-in[0]")" = 'display-message user-focus-hook' ]
  [ "$(<"$TMUX_STUB_DIR/hooks/client-focus-in[1]")" = 'set-option -gF "@pane_dash_focus_#{hook_client}" "1"' ]
}

@test "default focus setup enables focus events and appends the terminal focus feature" {
  run "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(<"$TMUX_STUB_DIR/global/focus-events")" = on ]
  [ "$(find "$TMUX_STUB_DIR/server-options/terminal-features" -type f -exec grep -lFx '*:focus' {} + | wc -l | tr -d ' ')" -eq 1 ]
}

@test "preserves same-index focus hooks and terminal feature while adding focus setup once" {
  mkdir -p "$TMUX_STUB_DIR/hooks"
  printf '%s' 'display-message user-focus-in' > "$TMUX_STUB_DIR/hooks/client-focus-in[31337]"
  printf '%s' 'display-message user-focus-out' > "$TMUX_STUB_DIR/hooks/client-focus-out[31337]"
  mkdir -p "$TMUX_STUB_DIR/server-options/terminal-features"
  printf '%s' 'user*:RGB' > "$TMUX_STUB_DIR/server-options/terminal-features/31337"

  run "$SCRIPT"

  [ "$status" -eq 0 ]
  run "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(<"$TMUX_STUB_DIR/global/focus-events")" = on ]
  [ "$(<"$TMUX_STUB_DIR/hooks/client-focus-in[31337]")" = 'display-message user-focus-in' ]
  [ "$(<"$TMUX_STUB_DIR/hooks/client-focus-out[31337]")" = 'display-message user-focus-out' ]
  [ "$(<"$TMUX_STUB_DIR/server-options/terminal-features/31337")" = 'user*:RGB' ]
  [ "$(find "$TMUX_STUB_DIR/hooks" -type f -exec grep -lFx 'set-option -gF "@pane_dash_focus_#{hook_client}" "1"' {} + | wc -l | tr -d ' ')" -eq 1 ]
  [ "$(find "$TMUX_STUB_DIR/hooks" -type f -exec grep -lFx 'set-option -gF "@pane_dash_focus_#{hook_client}" "0"' {} + | wc -l | tr -d ' ')" -eq 1 ]
  [ "$(find "$TMUX_STUB_DIR/server-options/terminal-features" -type f -exec grep -lFx '*:focus' {} + | wc -l | tr -d ' ')" -eq 1 ]
}

@test "open initializes the owner focus option before opening its popup" {
  run "$ROOT/scripts/open.sh" /tmp/pane-dash /dev/ttys001 '$3' '%42'

  [ "$status" -eq 0 ]
  assert_call 1 set-option -g @pane_dash_focus_/dev/ttys001 1
}
