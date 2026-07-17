setup() {
  export TMUX_STUB_DIR="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$TMUX_STUB_DIR/panes.d/%5" "$TMUX_STUB_DIR/global"
  : > "$TMUX_STUB_DIR/calls.log"
  export PATH="$BATS_TEST_DIRNAME/stubs:$PATH"
  SCRIPT="$BATS_TEST_DIRNAME/../scripts/tag.sh"
}

@test "toggle tags an untagged pane with its current command" {
  printf 'nvim' > "$TMUX_STUB_DIR/panes.d/%5/pane_current_command"
  run "$SCRIPT" toggle %5
  [ "$status" -eq 0 ]
  grep -q 'set-option -p -t %5 @pane_dash_tag nvim' "$TMUX_STUB_DIR/calls.log"
}

@test "toggle untags a tagged pane" {
  printf 'nvim' > "$TMUX_STUB_DIR/panes.d/%5/@pane_dash_tag"
  run "$SCRIPT" toggle %5
  [ "$status" -eq 0 ]
  grep -q 'set-option -pu -t %5 @pane_dash_tag' "$TMUX_STUB_DIR/calls.log"
}

@test "label sanitizes control chars, tabs, newlines and caps length" {
  long="$(printf 'a%.0s' $(seq 1 200))"
  run "$SCRIPT" label %5 "$(printf 'bad\tlabel\nx\033[31m')${long}"
  [ "$status" -eq 0 ]
  line="$(grep 'set-option -p -t %5 @pane_dash_tag' "$TMUX_STUB_DIR/calls.log")"
  case "$line" in (*"$(printf '\t')"*) false ;; esac   # no tab survived
  [ "${#line}" -lt 140 ]                                # capped
}

@test "label with empty value does not set an option" {
  run "$SCRIPT" label %5 ""
  [ "$status" -eq 0 ]
  ! grep -q 'set-option -p -t %5 @pane_dash_tag' "$TMUX_STUB_DIR/calls.log"
}
