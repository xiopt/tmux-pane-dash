#!/usr/bin/env bash
# Record tmux format expansion behavior for user-provided command arguments.
export TMUX=''
# shellcheck disable=SC1091 # The shared harness is resolved relative to this probe.
source "$(dirname "$0")/../lib.sh"

A="40_expansion_matrix.txt"
pd_reset_artifact "$A"

sock="$(pd_server expand)"
M='#{session_name}'
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pd_spike_cwd.XXXXXX")"
d="$temp_dir/pd_spike_cwd_#{session_name}"
operational_failures=0

cleanup() {
  rm -rf "$temp_dir"
  TMUX='' pd_kill_server "$sock"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

t() {
  TMUX='' "$TMUX_BIN" -L "$sock" "$@"
}

fresh_server() {
  TMUX='' pd_new_server "$sock"
}

record_action_error() { # $1=label, remaining args=failed command output
  local label="$1"
  shift
  pd_record "$A" "ERROR: $label action failed: $*"
  operational_failures=$((operational_failures + 1))
}

classify_readback() { # $1=label $2=expected, remaining args=readback command
  local label="$1"
  local expected="$2"
  shift 2

  local got
  if ! got="$("$@" 2>&1)"; then
    pd_record "$A" "$label: REJECTED"
    pd_record "$A" "ERROR: $label readback failed: $got"
    operational_failures=$((operational_failures + 1))
    LAST_RESULT=REJECTED
  elif grep -Fqx -- "$expected" <<<"$got"; then
    pd_record "$A" "$label: NOT_EXPANDED"
    LAST_RESULT=NOT_EXPANDED
  else
    pd_record "$A" "$label: EXPANDED_OR_MANGLED got=[$got]"
    LAST_RESULT=EXPANDED_OR_MANGLED
  fi
}

run_and_classify() { # $1=label $2=expected; action function; readback function
  local label="$1"
  local expected="$2"
  local action="$3"
  local readback="$4"
  local error

  if ! error="$($action 2>&1)"; then
    pd_record "$A" "$label: REJECTED"
    record_action_error "$label" "$error"
    LAST_RESULT=REJECTED
    return
  fi
  classify_readback "$label" "$expected" "$readback"
}

record_doubling() { # $1=label $2=expected; action function; readback function
  local label="$1"
  local expected="$2"
  local action="$3"
  local readback="$4"
  local error got

  if ! error="$($action 2>&1)"; then
    pd_record "$A" "$label: DOUBLING_BROKEN action_error=[$error]"
    operational_failures=$((operational_failures + 1))
  elif ! got="$($readback 2>&1)"; then
    pd_record "$A" "$label: DOUBLING_BROKEN readback_error=[$got]"
    operational_failures=$((operational_failures + 1))
  elif grep -Fqx -- "$expected" <<<"$got"; then
    pd_record "$A" "$label: DOUBLING_OK"
  else
    pd_record "$A" "$label: DOUBLING_BROKEN got=[$got]"
  fi
}

# Each action/readback pair is reset to a fresh disposable server. This keeps
# a rejected or expanded name from changing a later row's target selection.
fresh_server
session_name="session-${M}"
new_session_name() { t new-session -d -s "$session_name"; }
read_session_name() { t list-sessions -F '#{session_name}'; }
run_and_classify "new-session -s" "$session_name" new_session_name read_session_name
if [[ "$LAST_RESULT" == EXPANDED_OR_MANGLED ]]; then
  fresh_server
  session_name="session-##{session_name}"
  new_session_name() { t new-session -d -s "$session_name"; }
  record_doubling "new-session -s" 'session-#{session_name}' new_session_name read_session_name
fi

fresh_server
window_name="window-${M}"
new_session_window_name() { t new-session -d -s named-window -n "$window_name"; }
read_new_session_window_name() { t display-message -p -t named-window:0 '#{window_name}'; }
run_and_classify "new-session -n" "$window_name" new_session_window_name read_new_session_window_name
if [[ "$LAST_RESULT" == EXPANDED_OR_MANGLED ]]; then
  fresh_server
  window_name="window-##{session_name}"
  new_session_window_name() { t new-session -d -s named-window -n "$window_name"; }
  record_doubling "new-session -n" 'window-#{session_name}' new_session_window_name read_new_session_window_name
fi

fresh_server
window_name="window-${M}"
new_window_name() { t new-window -d -t base -n "$window_name"; }
read_new_window_name() { t display-message -p -t base:1 '#{window_name}'; }
run_and_classify "new-window -n" "$window_name" new_window_name read_new_window_name
if [[ "$LAST_RESULT" == EXPANDED_OR_MANGLED ]]; then
  fresh_server
  window_name="window-##{session_name}"
  new_window_name() { t new-window -d -t base -n "$window_name"; }
  record_doubling "new-window -n" 'window-#{session_name}' new_window_name read_new_window_name
fi

# Keep both literal and likely expanded paths present. The literal path is the
# required marker directory; the extra paths avoid a missing cwd masking an
# otherwise observable expansion result.
mkdir -p "$d" "$temp_dir/pd_spike_cwd_base" "$temp_dir/pd_spike_cwd_cwd-session"
# tmux reports the physical cwd on macOS (/private/tmp rather than /tmp). Keep
# this normalized expectation separate from the raw marker argument so that
# filesystem canonicalization is not mistaken for format expansion.
d_readback="$(cd "$d" && pwd -P)"
pd_record "$A" "CONTROL cwd readback normalization: raw=[$d] physical=[$d_readback]"

fresh_server
new_window_cwd() { t new-window -d -t base -c "$d"; }
read_new_window_cwd() { t display-message -p -t base:1 '#{pane_current_path}'; }
run_and_classify "new-window -c" "$d_readback" new_window_cwd read_new_window_cwd
if [[ "$LAST_RESULT" == EXPANDED_OR_MANGLED ]]; then
  fresh_server
  d_double="$temp_dir/pd_spike_cwd_##{session_name}"
  new_window_cwd() { t new-window -d -t base -c "$d_double"; }
  record_doubling "new-window -c" "$d_readback" new_window_cwd read_new_window_cwd
fi

fresh_server
split_window_cwd() { t split-window -d -t base:0 -c "$d"; }
read_split_window_cwd() { t display-message -p -t base:0.1 '#{pane_current_path}'; }
run_and_classify "split-window -c" "$d_readback" split_window_cwd read_split_window_cwd
if [[ "$LAST_RESULT" == EXPANDED_OR_MANGLED ]]; then
  fresh_server
  d_double="$temp_dir/pd_spike_cwd_##{session_name}"
  split_window_cwd() { t split-window -d -t base:0 -c "$d_double"; }
  record_doubling "split-window -c" "$d_readback" split_window_cwd read_split_window_cwd
fi

fresh_server
new_session_cwd() { t new-session -d -s cwd-session -c "$d"; }
read_new_session_cwd() { t display-message -p -t cwd-session:0 '#{pane_current_path}'; }
run_and_classify "new-session -c" "$d_readback" new_session_cwd read_new_session_cwd
if [[ "$LAST_RESULT" == EXPANDED_OR_MANGLED ]]; then
  fresh_server
  d_double="$temp_dir/pd_spike_cwd_##{session_name}"
  new_session_cwd() { t new-session -d -s cwd-session -c "$d_double"; }
  record_doubling "new-session -c" "$d_readback" new_session_cwd read_new_session_cwd
fi

# display-message expands the option lookup once but does not re-expand its
# stored result. show-options is retained as a channel-independent second view.
fresh_server
plain_readback=""
if ! control_error="$(t set-option -p -t base:0.0 @pd_probe plain-control-value 2>&1)"; then
  pd_record "$A" "ERROR: CONTROL set-option -p plain action failed: $control_error"
  operational_failures=$((operational_failures + 1))
elif ! plain_readback="$(t display-message -p -t base:0.0 '#{@pd_probe}' 2>&1)"; then
  pd_record "$A" "ERROR: CONTROL set-option -p plain readback failed: $plain_readback"
  operational_failures=$((operational_failures + 1))
fi
if [[ "$plain_readback" == plain-control-value ]]; then
  pd_record "$A" "CONTROL set-option -p plain readback: EXACT"
else
  pd_record "$A" "CONTROL set-option -p plain readback: MISMATCH got=[$plain_readback]"
  operational_failures=$((operational_failures + 1))
fi
option_value="option-${M}"
set_option_value() { t set-option -p -t base:0.0 @pd_probe "$option_value"; }
read_option_value() { t display-message -p -t base:0.0 '#{@pd_probe}'; }
run_and_classify "set-option -p" "$option_value" set_option_value read_option_value
if ! show_option_value="$(t show-options -p -t base:0.0 -v @pd_probe 2>&1)"; then
  pd_record "$A" "ERROR: SECOND_OPINION set-option -p show-options -v failed: $show_option_value"
  operational_failures=$((operational_failures + 1))
fi
pd_record "$A" "SECOND_OPINION set-option -p show-options -v: got=[$show_option_value] (display-message readback is authoritative; show-options may quote or escape)"
if [[ "$LAST_RESULT" == EXPANDED_OR_MANGLED ]]; then
  fresh_server
  option_value="option-##{session_name}"
  set_option_value() { t set-option -p -t base:0.0 @pd_probe "$option_value"; }
  record_doubling "set-option -p" 'option-#{session_name}' set_option_value read_option_value
fi

fresh_server
if ! cat_error="$(t respawn-pane -k -t base:0.0 cat 2>&1)"; then
  pd_record "$A" "ERROR: send-keys -l cat setup failed: $cat_error"
  operational_failures=$((operational_failures + 1))
fi
send_payload() { t send-keys -l -t base:0.0 -- "$M"; }
read_send_payload() { t capture-pane -p -t base:0.0 -S -; }
run_and_classify "send-keys -l" "$M" send_payload read_send_payload
if [[ "$LAST_RESULT" == EXPANDED_OR_MANGLED ]]; then
  fresh_server
  if ! cat_error="$(t respawn-pane -k -t base:0.0 cat 2>&1)"; then
    pd_record "$A" "ERROR: send-keys -l doubling cat setup failed: $cat_error"
    operational_failures=$((operational_failures + 1))
  fi
  doubled_payload='##{session_name}'
  send_payload() { t send-keys -l -t base:0.0 -- "$doubled_payload"; }
  record_doubling "send-keys -l" "$M" send_payload read_send_payload
fi

fresh_server
renamed_session="rename-${M}"
rename_session() { t rename-session -t base "$renamed_session"; }
read_renamed_session() { t list-sessions -F '#{session_name}'; }
run_and_classify "rename-session" "$renamed_session" rename_session read_renamed_session
if [[ "$LAST_RESULT" == EXPANDED_OR_MANGLED ]]; then
  fresh_server
  renamed_session='rename-##{session_name}'
  rename_session() { t rename-session -t base "$renamed_session"; }
  record_doubling "rename-session" 'rename-#{session_name}' rename_session read_renamed_session
fi

fresh_server
renamed_window="rename-${M}"
rename_window() { t rename-window -t base:0 "$renamed_window"; }
read_renamed_window() { t display-message -p -t base:0 '#{window_name}'; }
run_and_classify "rename-window" "$renamed_window" rename_window read_renamed_window
if [[ "$LAST_RESULT" == EXPANDED_OR_MANGLED ]]; then
  fresh_server
  renamed_window='rename-##{session_name}'
  rename_window() { t rename-window -t base:0 "$renamed_window"; }
  record_doubling "rename-window" 'rename-#{session_name}' rename_window read_renamed_window
fi

# Every matrix row must be recorded. Findings are data; only missing probes fail.
for label in \
  'new-session -s' 'new-session -n' 'new-window -n' 'new-window -c' \
  'split-window -c' 'new-session -c' 'set-option -p' 'send-keys -l' \
  'rename-session' 'rename-window'; do
  if ! grep -Eq "^${label}: (NOT_EXPANDED|EXPANDED_OR_MANGLED|REJECTED)" "$(pd_artifact "$A")"; then
    echo "missing matrix row: $label" >&2
    exit 1
  fi
done

if (( operational_failures > 0 )); then
  echo "expansion matrix encountered $operational_failures operational failure(s)" >&2
  exit 1
fi
