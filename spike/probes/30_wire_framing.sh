#!/usr/bin/env bash
# Probe control-channel wire construction and command-frame guard handling.
# shellcheck disable=SC1091 # The shared harness is resolved relative to this probe.
source "$(dirname "$0")/../lib.sh"

export TMUX=''

A="30_wire_framing.txt"
pd_reset_artifact "$A"
tmux_version="$(TMUX='' "$TMUX_BIN" -V)"

sock="$(pd_server wire)"
raw="$RESULTS_DIR/30_wire_framing_raw.bin"
input_fifo="$RESULTS_DIR/30_wire_framing_input.fifo"
octal_segment="$RESULTS_DIR/30_wire_framing_octal.bin"
raw_segment="$RESULTS_DIR/30_wire_framing_raw-command.bin"
guard_segment="$RESULTS_DIR/30_wire_framing_guard.bin"
argv_raw="$RESULTS_DIR/30_wire_framing_argv.bin"
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

sync_completed() {
  local number="$1"

  awk -v number="$number" '
    /^%begin / {
      begin_ts = $2
      begin_id = $3
      in_frame = 1
      synced = 0
      next
    }
    in_frame && $0 == "SYNC:" number { synced = 1; next }
    /^%end / {
      if (in_frame && $2 == begin_ts && $3 == begin_id && synced) found = 1
      in_frame = 0
      synced = 0
      next
    }
    /^%error / {
      in_frame = 0
      synced = 0
      next
    }
    END { exit !found }
  ' "$raw"
}

sync_barrier() {
  local number="$1"

  printf "display-message -p 'SYNC:%s'\n" "$number" >&3
  for _ in {1..40}; do
    if sync_completed "$number"; then
      return
    fi
    sleep 0.05
  done
  echo "timed out waiting for SYNC:$number control response" >&2
  return 1
}

capture_segment() { # $1=destination, $2=sync number, remaining args=sender function
  local destination="$1"
  local number="$2"
  shift 2
  local offset
  offset="$(wc -c < "$raw")"

  "$@"
  sync_barrier "$number"
  dd if="$raw" bs=1 skip="$offset" 2>/dev/null > "$destination"
}

has_rs_us_data_line() {
  local file="$1"
  LC_ALL=C grep -a -q $'^\036.*\037' "$file"
}

record_wire_verdict() { # $1=label $2=stream
  local label="$1"
  local stream="$2"
  local count
  count="$(LC_ALL=C grep -a -c $'^\036.*\037' "$stream" || true)"

  if (( count > 0 )); then
    pd_record "$A" "FINDING: $label: PASS (RS-prefixed data lines=$count)"
    return 0
  fi

  pd_record "$A" "FINDING: $label: FAIL (RS-prefixed data lines=0)"
  return 1
}

guard_mimic_is_distinguishable() {
  awk '
    /^%begin / {
      open_ts = $2
      open_id = $3
      open = 1
      next
    }
    open && $0 == "%end 1 1 1" {
      fake_seen = 1
      if ($2 != open_ts || $3 != open_id) fake_mismatches = 1
      next
    }
    /^%end / {
      if (open && $2 == open_ts && $3 == open_id && fake_seen && fake_mismatches) {
        real_pair_matches = 1
        exit
      }
      open = 0
      next
    }
    /^%error / { open = 0 }
    END { exit !real_pair_matches }
  ' "$1"
}

send_octal_command() {
  # Backslash-octal must reach tmux's command parser as literal text.
  printf '%s\n' 'list-panes -a -F "\036#{session_id}\037#{pane_id}"' >&3
}

send_raw_command() {
  # Here the command line itself contains RS and US bytes.
  printf '%s' 'list-panes -a -F "' >&3
  printf '\036#{session_id}\037#{pane_id}' >&3
  printf '"\n' >&3
}

send_guard_command() {
  printf '%s\n' 'list-panes -a -F "#{@pd_evil}"' >&3
}

TMUX='' pd_new_server "$sock"
sid="$(tmux_cmd display-message -p -t base '#{session_id}')"

: > "$raw"
rm -f "$input_fifo"
mkfifo "$input_fifo"

# The FIFO + retained writer fd keeps the control client alive across commands.
TMUX='' "$TMUX_BIN" -L "$sock" -C attach-session \
  -f no-output,ignore-size -t "$sid" < "$input_fifo" >> "$raw" 2>&1 &
ctl_pid=$!
exec 3> "$input_fifo"
input_fd_open=true
sync_barrier 0

# Pane titles reject newlines on tmux 3.7b; retain that result as a finding.
title_before="$(tmux_cmd display-message -p -t base:0.0 '#{pane_title}')"
tmux_cmd select-pane -t base:0.0 -T "$(printf 'evil\n%%end 1 1 1\nafter')"
title_after="$(tmux_cmd display-message -p -t base:0.0 '#{pane_title}')"
if [[ "$title_after" == "$title_before" ]]; then
  pd_record "$A" "FINDING: select-pane -T rejects embedded newlines on $tmux_version (title unchanged)"
else
  pd_record "$A" "FINDING: select-pane -T accepted embedded newlines on $tmux_version (title changed)"
fi

evil_value="$(printf 'evil\n%%end 1 1 1\nafter')"
tmux_cmd set-option -p -t base:0.0 @pd_evil "$evil_value"
option_value="$(tmux_cmd display-message -p -t base:0.0 '#{@pd_evil}')"
guard_required=true
if [[ "$option_value" == "$evil_value" ]]; then
  pd_record "$A" "FINDING: pane option @pd_evil preserves embedded newlines on $tmux_version"
else
  pd_record "$A" "FINDING: no in-band newline injection vector found via title/options on $tmux_version"
  guard_required=false
fi

capture_segment "$octal_segment" 1 send_octal_command
capture_segment "$raw_segment" 2 send_raw_command
if [[ "$guard_required" == true ]]; then
  capture_segment "$guard_segment" 3 send_guard_command
else
  # Preserve the parser fixture even if this tmux version cannot emit it live.
  printf '%%begin 10 20 1\nevil\n%%end 1 1 1\nafter\n%%end 10 20 1\n' > "$guard_segment"
fi

# The argv path bypasses tmux's control-command parser; raw bytes are one argv value.
TMUX='' "$TMUX_BIN" -L "$sock" list-panes -a \
  -F $'\036#{session_id}\037#{pane_id}' > "$argv_raw"

channel_passes=0
if record_wire_verdict "channel double-quoted octal" "$octal_segment"; then
  channel_passes=$((channel_passes + 1))
fi
if record_wire_verdict "channel raw control bytes" "$raw_segment"; then
  channel_passes=$((channel_passes + 1))
fi
argv_pass=false
if record_wire_verdict "one-shot argv raw bytes" "$argv_raw"; then
  argv_pass=true
fi

guard_pass=false
if guard_mimic_is_distinguishable "$guard_segment"; then
  if [[ "$guard_required" == true ]]; then
    pd_record "$A" "FINDING: guard-mimicking frame: PASS (real %begin/%end ids match; fake ids differ)"
  else
    pd_record "$A" "FINDING: guard-mimicking frame: PASS (synthetic fixture; real %begin/%end ids match; fake ids differ)"
  fi
  guard_pass=true
else
  pd_record "$A" "FINDING: guard-mimicking frame: FAIL (missing matching real pair or distinguishable fake %end)"
fi

pd_record "$A" "--- guard-mimicking raw block (od -c) ---"
od -c "$guard_segment" | sed -n '1,80p' | sed 's/[[:space:]]*$//' >> "$(pd_artifact "$A")"
pd_record "$A" "--- wire stream excerpt (od -c) ---"
od -c "$raw" | sed -n '1,80p' | sed 's/[[:space:]]*$//' >> "$(pd_artifact "$A")"

exec 3>&-
input_fd_open=false
wait "$ctl_pid" 2>/dev/null || true
ctl_pid=""

(( channel_passes > 0 ))
[[ "$argv_pass" == true ]]
if [[ "$guard_required" == true ]]; then
  [[ "$guard_pass" == true ]]
fi
