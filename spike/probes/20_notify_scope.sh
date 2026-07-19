#!/usr/bin/env bash
# Record which server notifications reach a control client attached to base.
# shellcheck disable=SC1091 # The shared harness is resolved relative to this probe.
source "$(dirname "$0")/../lib.sh"

A="20_notify_scope.txt"
pd_reset_artifact "$A"

sock="$(pd_server notify)"
raw="$RESULTS_DIR/20_notify_scope_raw.txt"
input_fifo="$RESULTS_DIR/20_notify_scope_input.fifo"
ctl_pid=""
input_fd_open=false

cleanup() {
  if [[ "$input_fd_open" == true ]]; then
    exec 3>&-
  fi
  if [[ -n "$ctl_pid" ]]; then
    kill "$ctl_pid" 2>/dev/null || true
    wait "$ctl_pid" 2>/dev/null || true
  fi
  rm -f "$input_fifo"
  TMUX='' pd_kill_server "$sock"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

tmux_cmd() {
  TMUX='' "$TMUX_BIN" -L "$sock" "$@"
}

summarize_tokens() {
  awk '
    /^MARKER:/ {
      split($0, marker, ":")
      if (marker[2] != 0) {
        result = "(none)"
        if (tokens != "") result = tokens
        printf "FINDING: %s %s -> %s\n", marker[2], marker[3], result
      }
      tokens = ""
      next
    }
    /^%[[:alnum:]-]+/ {
      token = $1
      tokens = tokens == "" ? token : tokens " " token
    }
  ' "$1"
}

tokens_for() {
  local number="$1"
  summarize_tokens "$raw" | awk -v number="$number" '
    $1 == "FINDING:" && $2 == number {
      sub(/^FINDING: [0-9]+ .* -> /, "")
      print
    }
  '
}

TMUX='' pd_new_server "$sock"
tmux_cmd new-session -d -s other
tmux_cmd set-option -gw automatic-rename off
tmux_cmd set-option -gw allow-rename off
tmux_cmd set-option -w -t base:0 automatic-rename off
tmux_cmd set-option -w -t base:0 allow-rename off
tmux_cmd set-option -w -t other:0 automatic-rename off
tmux_cmd set-option -w -t other:0 allow-rename off
sid="$(tmux_cmd display-message -p -t base '#{session_id}')"

: > "$raw"
rm -f "$input_fifo"
mkfifo "$input_fifo"

# Keep stdin open so this control client remains attached for the full matrix.
TMUX='' "$TMUX_BIN" -L "$sock" -C attach-session \
  -f no-output,ignore-size -t "$sid" < "$input_fifo" >> "$raw" 2>&1 &
ctl_pid=$!
exec 3> "$input_fifo"
input_fd_open=true
sleep 1
printf 'MARKER:0:control-client-attached\n' >> "$raw"

step_number=0
step() {
  local action="$1"
  shift
  "$@"
  sleep 0.3
  step_number=$((step_number + 1))
  printf 'MARKER:%s:%s\n' "$step_number" "$action" >> "$raw"
}

step "split-window in ATTACHED session" tmux_cmd split-window -d -t base:0
step "kill that pane" tmux_cmd kill-pane -t base:0.1
step "new-window in ATTACHED" tmux_cmd new-window -d -t base
step "rename window in ATTACHED" tmux_cmd rename-window -t base:1 renamed
step "split-window in OTHER session" tmux_cmd split-window -d -t other:0
step "new-window in OTHER" tmux_cmd new-window -d -t other
step "rename OTHER session" tmux_cmd rename-session -t other other2
step "set a pane option in OTHER (status write)" \
  tmux_cmd set-option -p -t other2:0.0 @pane_dash_status working
step "link OTHER window into base" tmux_cmd link-window -s other2:1 -t base:9
step "split the LINKED window from other side" tmux_cmd split-window -d -t other2:1
step "new detached session (server-wide)" tmux_cmd new-session -d -s third
step "kill OTHER session" tmux_cmd kill-session -t other2
step "set a pane option in ATTACHED session (status write)" \
  tmux_cmd set-option -p -t base:0.0 @pane_dash_status working

sleep 0.3
exec 3>&-
input_fd_open=false
wait "$ctl_pid" 2>/dev/null || true
ctl_pid=""

pd_record "$A" "--- raw control stream ---"
cat "$raw" >> "$(pd_artifact "$A")"
pd_record "$A" "--- token summary ---"
summarize_tokens "$raw" >> "$(pd_artifact "$A")"

# These are the only invariants the v2 transport spec depends on.
[[ "$(tokens_for 8)" == "(none)" ]]
[[ "$(tokens_for 13)" == "(none)" ]]
for action_number in 1 2 3 4; do
  [[ "$(tokens_for "$action_number")" != "(none)" ]]
done
test -s "$raw"
