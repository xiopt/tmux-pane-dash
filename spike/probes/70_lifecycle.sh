#!/usr/bin/env bash
# Record control-client lifecycle behavior and channel-driven switch-client.
# shellcheck disable=SC1091 # The shared harness is resolved relative to this probe.
source "$(dirname "$0")/../lib.sh"

assert_switch_zoom_artifact() { # $1=artifact containing switch-client finding
  grep -qx 'FINDING: switch-client -Z zoomed=0' "$1"
}

if [[ "${1:-}" == "--assert-switch-zoom" ]]; then
  [[ $# == 2 ]] || { echo "usage: $0 --assert-switch-zoom <artifact>" >&2; exit 2; }
  assert_switch_zoom_artifact "$2"
  exit
fi

A="70_lifecycle.txt"
pd_reset_artifact "$A"

sock="$(pd_server life)"
sock2="$(pd_server life2)"
ctl_pid=""
outer_pid=""
input_open=false
control_snapshot=""
input_fifo="$RESULTS_DIR/70_control_input.fifo"
stop_mechanism=""

cleanup() {
  if [[ "$input_open" == true ]]; then
    exec 3>&-
  fi
  if [[ -n "$ctl_pid" ]]; then
    kill "$ctl_pid" 2>/dev/null || true
    wait "$ctl_pid" 2>/dev/null || true
  fi
  if [[ -n "$outer_pid" ]]; then
    kill "$outer_pid" 2>/dev/null || true
    wait "$outer_pid" 2>/dev/null || true
  fi
  rm -f "$input_fifo"
  TMUX='' pd_kill_server "$sock"
  TMUX='' pd_kill_server "$sock2"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

tmux_cmd() {
  TMUX='' "$TMUX_BIN" -L "$1" "${@:2}"
}

client_snapshot() { # $1=socket $2=tmux client PID
  tmux_cmd "$1" list-clients -F '#{client_pid}|#{client_tty}|#{session_name}' 2>/dev/null |
    awk -F '|' -v pid="$2" '$1 == pid { printf "pid=%s tty=%s session=%s", $1, $2, $3 }'
}

wait_for_client() { # $1=socket $2=tmux client PID
  local snapshot
  for _ in {1..40}; do
    snapshot="$(client_snapshot "$1" "$2")"
    [[ -n "$snapshot" ]] && { printf '%s' "$snapshot"; return 0; }
    sleep 0.05
  done
  return 1
}

wait_for_exit() { # $1=PID; bounded, returns 0 only after it exits
  for _ in {1..40}; do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.05
  done
  return 1
}

termination_form() { # $1=control transcript
  if grep -q '^%exit$' "$1"; then
    printf 'percent-exit'
  elif grep -q '\[detached\|\[exited\|\[server exited' "$1"; then
    printf 'bracketed-status'
  else
    printf 'bare-eof-or-other'
  fi
}

start_control() { # $1=socket $2=session id/name $3=raw transcript
  rm -f "$input_fifo"
  mkfifo "$input_fifo"
  : > "$3"
  TMUX='' "$TMUX_BIN" -L "$1" -C attach-session -f no-output,ignore-size -t "$2" \
    < "$input_fifo" > "$3" 2>&1 &
  ctl_pid=$!
  exec 3> "$input_fifo"
  input_open=true
  control_snapshot="$(wait_for_client "$1" "$ctl_pid")"
}

stop_control() {
  stop_mechanism="input-EOF"
  if [[ "$input_open" == true ]]; then
    exec 3>&-
    input_open=false
  fi
  if ! wait_for_exit "$ctl_pid"; then
    stop_mechanism="SIGTERM-fallback"
    kill "$ctl_pid" 2>/dev/null || true
    wait "$ctl_pid" 2>/dev/null || true
  fi
  ctl_pid=""
}

record_destroy_case() { # $1=label $2=session target $3=raw transcript
  local label="$1" session_target="$2" raw="$3" before after
  local client_alive=false retarget_confirmed=false

  if ! start_control "$sock" "$session_target" "$raw"; then
    pd_record "$A" "FINDING: $label could not attach control client"
    return 1
  fi
  before="$control_snapshot"
  pd_record "$A" "FINDING: $label attached control client $before"
  tmux_cmd "$sock" kill-session -t "$session_target"

  if wait_for_exit "$ctl_pid"; then
    pd_record "$A" "FINDING: $label destroy outcome=CLIENT_EXITED_WITHIN_2S"
  else
    client_alive=true
    after="$(client_snapshot "$sock" "$ctl_pid")"
    if [[ -n "$after" && "${after##*session=}" != "" ]]; then
      retarget_confirmed=true
      pd_record "$A" "FINDING: $label destroy outcome=CLIENT_STILL_ALIVE_AFTER_2S retargeted $after"
    else
      pd_record "$A" "FINDING: $label destroy outcome=CLIENT_STILL_ALIVE_AFTER_2S alive-but-unconfirmed (no list-clients entry)"
    fi
  fi
  pd_record "$A" "--- tail after $label destroy ---"
  tail -n 8 "$raw" >> "$(pd_artifact "$A")" || true
  if [[ "$client_alive" == true ]]; then
    if [[ "$retarget_confirmed" == true ]]; then
      pd_record "$A" "FINDING: $label natural-termination=no-termination-observed (client alive, retargeted)"
    else
      pd_record "$A" "FINDING: $label natural-termination=no-termination-observed (client alive, alive-but-unconfirmed (no list-clients entry))"
    fi
  else
    pd_record "$A" "FINDING: $label natural-termination form=$(termination_form "$raw")"
  fi
  stop_control
  if [[ "$client_alive" == true ]]; then
    pd_record "$A" "FINDING: $label forced-termination mechanism=$stop_mechanism form=$(termination_form "$raw")"
  fi
}

TMUX='' pd_new_server "$sock"
tmux_cmd "$sock" new-session -d -s survivor
sid="$(tmux_cmd "$sock" display-message -p -t base '#{session_id}')"

# (a) The default is intentionally not changed; record the observed default.
pd_record "$A" "FINDING: detach-on-destroy default=$(tmux_cmd "$sock" show-options -gv detach-on-destroy)"
record_destroy_case "detach-on-destroy default" "$sid" "$RESULTS_DIR/70_destroy_default.txt"

tmux_cmd "$sock" set-option -g detach-on-destroy off
tmux_cmd "$sock" new-session -d -s base-off
sid_off="$(tmux_cmd "$sock" display-message -p -t base-off '#{session_id}')"
pd_record "$A" "FINDING: detach-on-destroy off=$(tmux_cmd "$sock" show-options -gv detach-on-destroy)"
record_destroy_case "detach-on-destroy off" "$sid_off" "$RESULTS_DIR/70_destroy_off.txt"

# (b) A server kill must end an attached control client without timeout limbo.
raw_serverkill="$RESULTS_DIR/70_serverkill.txt"
sid_survivor="$(tmux_cmd "$sock" display-message -p -t survivor '#{session_id}')"
start_control "$sock" "$sid_survivor" "$raw_serverkill"
tmux_cmd "$sock" kill-server
if wait_for_exit "$ctl_pid"; then
  pd_record "$A" "FINDING: kill-server outcome=CLIENT_EXITED_WITHIN_2S"
else
  pd_record "$A" "FINDING: kill-server outcome=TIMEOUT_LIMBO"
  exit 1
fi
wait "$ctl_pid" 2>/dev/null || true
ctl_pid=""
input_open=false
pd_record "$A" "--- tail after kill-server ---"
tail -n 8 "$raw_serverkill" >> "$(pd_artifact "$A")" || true
pd_record "$A" "FINDING: kill-server stream-form=$(termination_form "$raw_serverkill")"

# (c) A real PTY client is the switch target; the control client sends the
# command through its channel, then a separate one-shot query verifies it.
TMUX='' pd_new_server "$sock2"
tmux_cmd "$sock2" new-window -d -t base
target="$(tmux_cmd "$sock2" display-message -p -t base:1 '#{pane_id}')"
{ sleep 8; } | TMUX='' pd_run_in_pty "$TMUX_BIN" -L "$sock2" attach-session -t base \
  >/dev/null 2>&1 &
outer_pid=$!

ctty=""
for _ in {1..40}; do
  ctty="$(tmux_cmd "$sock2" list-clients -F '#{client_tty}' 2>/dev/null | head -n 1 || true)"
  [[ -n "$ctty" ]] && break
  sleep 0.05
done
[[ -n "$ctty" ]] || { pd_record "$A" "FINDING: switch-client outer PTY timeout"; exit 1; }

sid_switch="$(tmux_cmd "$sock2" display-message -p -t base '#{session_id}')"
raw_switch="$RESULTS_DIR/70_switch.txt"
start_control "$sock2" "$sid_switch" "$raw_switch"
printf 'switch-client -Z -c %s -t %s\n' "$ctty" "$target" >&3

switch_state=""
for _ in {1..40}; do
  # `-t` accepts a client tty across the tested tmux versions.
  switch_state="$(tmux_cmd "$sock2" display-message -p -t "$ctty" \
    '#{session_name}:#{window_index}.#{pane_index}:#{pane_id}:zoom=#{window_zoomed_flag}' 2>/dev/null || true)"
  [[ "$switch_state" == *":$target:zoom="* ]] && break
  sleep 0.05
done

pd_record "$A" "--- raw switch-client response ---"
cat "$raw_switch" >> "$(pd_artifact "$A")"
if grep -q '^%error ' "$raw_switch"; then
  pd_record "$A" "FINDING: switch-client via channel response=ERROR"
  exit 1
fi
if [[ "$switch_state" != *":$target:zoom="* ]]; then
  pd_record "$A" "FINDING: switch-client via channel target mismatch state=[$switch_state] target=[$target]"
  exit 1
fi
switch_zoomed="${switch_state##*zoom=}"
pd_record "$A" "FINDING: switch-client -Z zoomed=$switch_zoomed"
if [[ "$switch_zoomed" == 0 ]]; then
  pd_record "$A" "FINDING: switch-client via channel response=OK outer-current=[$switch_state] target=[$target]"
else
  pd_record "$A" "FINDING: switch-client via channel zoom preservation FAILED outer-current=[$switch_state] target=[$target]"
  exit 1
fi

stop_control
TMUX='' pd_kill_server "$sock2"
wait "$outer_pid" 2>/dev/null || true
outer_pid=""

grep -q 'kill-server outcome=CLIENT_EXITED_WITHIN_2S' "$(pd_artifact "$A")"
grep -q 'switch-client via channel response=OK' "$(pd_artifact "$A")"
