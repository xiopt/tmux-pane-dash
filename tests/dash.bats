@test "outer mode reports a useful error outside tmux" {
  SCRIPT="$BATS_TEST_DIRNAME/../scripts/dash.sh"

  run env -u TMUX "$SCRIPT"

  [ "$status" -eq 1 ]
  [ "$output" = "pane-dash: must be run inside tmux" ]
}
