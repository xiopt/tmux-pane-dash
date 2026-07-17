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

@test "binds dashboard, tag, and label actions with default keys" {
  run "$SCRIPT"

  [ "$status" -eq 0 ]
  assert_call 1 bind-key D run-shell "$ROOT/scripts/dash.sh '#{client_tty}' '#{pane_id}'"
  assert_call 2 bind-key T run-shell "$ROOT/scripts/tag.sh toggle '#{pane_id}'"
  assert_call 3 bind-key M command-prompt -p 'pane-dash label:' \
    "run-shell \"$ROOT/scripts/tag.sh label '#{pane_id}' '%%'\""
}

@test "uses configured dashboard, tag, and label keys" {
  printf 'F' > "$TMUX_STUB_DIR/global/@pane-dash-key"
  printf 'g' > "$TMUX_STUB_DIR/global/@pane-dash-tag-key"
  printf 'L' > "$TMUX_STUB_DIR/global/@pane-dash-label-key"

  run "$SCRIPT"

  [ "$status" -eq 0 ]
  assert_call 1 bind-key F run-shell "$ROOT/scripts/dash.sh '#{client_tty}' '#{pane_id}'"
  assert_call 2 bind-key g run-shell "$ROOT/scripts/tag.sh toggle '#{pane_id}'"
  assert_call 3 bind-key L command-prompt -p 'pane-dash label:' \
    "run-shell \"$ROOT/scripts/tag.sh label '#{pane_id}' '%%'\""
}
