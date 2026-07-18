setup() {
  export TMUX_STUB_DIR="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$TMUX_STUB_DIR/global"
  : > "$TMUX_STUB_DIR/calls.log"
  export PATH="$BATS_TEST_DIRNAME/stubs:$PATH"
  export PANE_DASH_NOW=1000000
  SCRIPT="$BATS_TEST_DIRNAME/../scripts/list.sh"
}

mkpane() { # mkpane <id> <key> <value>...
  local id="$1"; shift
  mkdir -p "$TMUX_STUB_DIR/panes.d/$id"
  grep -q "^$id$" "$TMUX_STUB_DIR/panes" 2>/dev/null || echo "$id" >> "$TMUX_STUB_DIR/panes"
  while [ $# -gt 1 ]; do printf '%s' "$2" > "$TMUX_STUB_DIR/panes.d/$id/$1"; shift 2; done
}

basepane() { # basepane <id> — native fields every pane has
  mkpane "$1" pane_current_command zsh pane_current_path /tmp/proj \
    session_name work window_index 1 pane_index 0
}

@test "plugin pane with fresh heartbeat is listed with its status" {
  basepane %1
  mkpane %1 @pane_dash_status working @pane_dash_status_since 999940 \
    @pane_dash_heartbeat 999990 @pane_dash_title "Fix auth" @pane_dash_model sonnet
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "%1"$'\t'* ]]
  [[ "${lines[0]}" == *working* ]]
}

@test "stale heartbeat shows stale" {
  basepane %1
  mkpane %1 @pane_dash_status working @pane_dash_status_since 900000 @pane_dash_heartbeat 900000
  run "$SCRIPT"
  [[ "${lines[0]}" == *stale* ]]
}

@test "opencode by process name without plugin shows unknown" {
  basepane %2
  mkpane %2 pane_current_command opencode
  run "$SCRIPT"
  [[ "${lines[0]}" == "%2"$'\t'* ]]
  [[ "${lines[0]}" == *unknown* ]]
}

@test "tagged pane is listed; plain pane is not" {
  basepane %3; mkpane %3 @pane_dash_tag deploy
  basepane %4
  run "$SCRIPT"
  [ "${#lines[@]}" -eq 1 ]
  [[ "${lines[0]}" == "%3"$'\t'* ]]
}

@test "sort order: needs_input, error, working, idle, unknown, stale" {
  for i in 1 2 3 4 5 6; do basepane "%$i"; done
  mkpane %1 @pane_dash_status idle        @pane_dash_status_since 999000 @pane_dash_heartbeat 999990
  mkpane %2 @pane_dash_status needs_input @pane_dash_status_since 999000 @pane_dash_heartbeat 999990
  mkpane %3 @pane_dash_status working     @pane_dash_status_since 999000 @pane_dash_heartbeat 999990
  mkpane %4 @pane_dash_status error       @pane_dash_status_since 999000 @pane_dash_heartbeat 999990
  mkpane %5 pane_current_command opencode
  mkpane %6 @pane_dash_status working     @pane_dash_status_since 900000 @pane_dash_heartbeat 900000
  run "$SCRIPT"
  [[ "${lines[0]}" == "%2"$'\t'* ]]
  [[ "${lines[1]}" == "%4"$'\t'* ]]
  [[ "${lines[2]}" == "%3"$'\t'* ]]
  [[ "${lines[3]}" == "%1"$'\t'* ]]
  [[ "${lines[4]}" == "%5"$'\t'* ]]
  [[ "${lines[5]}" == "%6"$'\t'* ]]
}

@test "within a group, oldest status_since first" {
  basepane %1; basepane %2
  mkpane %1 @pane_dash_status working @pane_dash_status_since 999900 @pane_dash_heartbeat 999990
  mkpane %2 @pane_dash_status working @pane_dash_status_since 999000 @pane_dash_heartbeat 999990
  run "$SCRIPT"
  [[ "${lines[0]}" == "%2"$'\t'* ]]
}

@test "grouped mode emits session headers before numerically sorted pane children" {
  printf '1' > "$TMUX_STUB_DIR/global/@pane_dash_group"
  basepane %1; basepane %2; basepane %3; basepane %4
  mkpane %1 session_name beta  window_index 1  pane_index 0  pane_current_command opencode
  mkpane %2 session_name alpha window_index 10 pane_index 0  pane_current_command opencode
  mkpane %3 session_name alpha window_index 2  pane_index 10 pane_current_command opencode
  mkpane %4 session_name alpha window_index 2  pane_index 2  pane_current_command opencode

  run "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == '$alpha'$'\t'* ]]
  [[ "${lines[0]}" == *'3 panes'* ]]
  [[ "${lines[1]}" == "%4"$'\t  '* ]]
  [[ "${lines[2]}" == "%3"$'\t  '* ]]
  [[ "${lines[3]}" == "%2"$'\t  '* ]]
  [[ "${lines[4]}" == '$beta'$'\t'* ]]
  [[ "${lines[5]}" == "%1"$'\t  '* ]]
}

@test "grouped session header uses the worst child status glyph" {
  printf '1' > "$TMUX_STUB_DIR/global/@pane_dash_group"
  basepane %1; basepane %2
  mkpane %1 session_name alpha pane_current_command opencode
  mkpane %2 session_name alpha @pane_dash_status needs_input @pane_dash_heartbeat 999990

  run "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == '$alpha'$'\t'* ]]
  [[ "${lines[0]}" == *'2 panes'* ]]
  [[ "${lines[0]}" == *'●'* ]]
}

@test "toggle-group enables session grouping when disabled" {
  run "$SCRIPT" toggle-group

  [ "$status" -eq 0 ]
  grep -F $'set-option\037-g\037@pane_dash_group\0371\037' "$TMUX_STUB_DIR/calls.log"
}

@test "toggle-group disables session grouping when enabled" {
  printf '1' > "$TMUX_STUB_DIR/global/@pane_dash_group"

  run "$SCRIPT" toggle-group

  [ "$status" -eq 0 ]
  grep -F $'set-option\037-g\037@pane_dash_group\0370\037' "$TMUX_STUB_DIR/calls.log"
}

@test "hostile path controls drop only malformed records without misattributing pane ids" {
  basepane %1; basepane %2; basepane %3
  for pane in %1 %2 %3; do mkpane "$pane" pane_current_command opencode; done
  printf 'safe\tpath' > "$TMUX_STUB_DIR/panes.d/%1/pane_current_path"
  printf 'evil\tpath\nline2' > "$TMUX_STUB_DIR/panes.d/%2/pane_current_path"
  printf 'separator\037path' > "$TMUX_STUB_DIR/panes.d/%3/pane_current_path"
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 1 ]
  [[ "${lines[0]}" == "%1"$'\t'* ]]
  ntabs="$(printf '%s' "${lines[0]}" | awk -F'\t' '{print NF-1}')"
  [ "$ntabs" -eq 1 ]
}

@test "list generation uses at most four tmux invocations regardless of pane count" {
  for n in $(seq 1 50); do
    basepane "%$n"
    mkpane "%$n" pane_current_command opencode
  done
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$TMUX_STUB_DIR/invocations.log" | tr -d ' ')" -le 4 ]
}

@test "custom stale threshold via @pane-dash-stale-secs" {
  printf '3600' > "$TMUX_STUB_DIR/global/@pane-dash-stale-secs"
  basepane %1
  mkpane %1 @pane_dash_status idle @pane_dash_status_since 998000 @pane_dash_heartbeat 998000
  run "$SCRIPT"
  [[ "${lines[0]}" == *idle* ]]
}

@test "zero-valued stale threshold with leading zeroes defaults to 60" {
  printf '00' > "$TMUX_STUB_DIR/global/@pane-dash-stale-secs"
  basepane %1
  mkpane %1 @pane_dash_status idle @pane_dash_status_since 999990 @pane_dash_heartbeat 999990
  run "$SCRIPT"
  [[ "${lines[0]}" == *idle* ]]
}
