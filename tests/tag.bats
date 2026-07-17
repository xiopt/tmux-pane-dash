setup() {
  export TMUX_STUB_DIR="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$TMUX_STUB_DIR/panes.d/%5" "$TMUX_STUB_DIR/global"
  : > "$TMUX_STUB_DIR/calls.log"
  : > "$TMUX_STUB_DIR/notifications.log"
  export PATH="$BATS_TEST_DIRNAME/stubs:$PATH"
  SCRIPT="$BATS_TEST_DIRNAME/../scripts/tag.sh"
}

read_args() {
  local file="$1"
  local last
  mapfile -t args < <(tr '\037' '\n' < "$TMUX_STUB_DIR/$file")
  last=$((${#args[@]} - 1))
  if [ "$last" -ge 0 ] && [ -z "${args[$last]}" ]; then
    unset "args[$last]"
  fi
}

assert_call() {
  local index="$1"
  shift
  local expected actual
  expected="$(printf '%s\037' "$@")"
  actual="$(sed -n "${index}p" "$TMUX_STUB_DIR/calls.log")"
  [ "$actual" = "$expected" ]
}

@test "toggle tags an untagged pane with its current command" {
  printf 'nvim' > "$TMUX_STUB_DIR/panes.d/%5/pane_current_command"
  run "$SCRIPT" toggle %5
  [ "$status" -eq 0 ]
  read_args calls.log
  [ "${args[*]}" = 'set-option -p -t %5 @pane_dash_tag nvim' ]
}

@test "toggle untags a tagged pane" {
  printf 'nvim' > "$TMUX_STUB_DIR/panes.d/%5/@pane_dash_tag"
  run "$SCRIPT" toggle %5
  [ "$status" -eq 0 ]
  read_args calls.log
  [ "${args[*]}" = 'set-option -pu -t %5 @pane_dash_tag' ]
}

@test "label sanitizes control chars, tabs, newlines and caps length" {
  long="$(printf 'a%.0s' $(seq 1 200))"
  expected="bad label x[31m$(printf 'a%.0s' $(seq 1 65))"
  run "$SCRIPT" label %5 "$(printf 'bad\tlabel\nx\033[31m')${long}"
  [ "$status" -eq 0 ]
  read_args calls.log
  [ "${args[5]}" = "$expected" ]
  [ "${#args[5]}" -eq 80 ]
  ! printf '%s' "${args[5]}" | LC_ALL=C grep -q '[[:cntrl:]]'
}

@test "label with empty value does not set an option" {
  run "$SCRIPT" label %5 ""
  [ "$status" -eq 0 ]
  [ ! -s "$TMUX_STUB_DIR/calls.log" ]
}

@test "label stores hashes literally and escapes them in the notification" {
  run "$SCRIPT" label %5 'x#{pane_id}'
  [ "$status" -eq 0 ]
  read_args calls.log
  [ "${args[5]}" = 'x#{pane_id}' ]
  read_args notifications.log
  [ "${args[*]}" = 'display-message pane-dash: tagged as x##{pane_id}' ]
}

@test "label-from-option consumes hostile input as a literal tag" {
  printf '%s' 'it'"'"'s a #{pane_id} "x" ; echo pwned' > "$TMUX_STUB_DIR/panes.d/%5/@pane_dash_label_input"

  run "$SCRIPT" label-from-option %5

  [ "$status" -eq 0 ]
  assert_call 1 set-option -pu -t %5 @pane_dash_label_input
  assert_call 2 set-option -p -t %5 @pane_dash_tag 'it'"'"'s a #{pane_id} "x" ; echo pwned'
}
