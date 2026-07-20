#!/usr/bin/env bash
# Verify that a display-popup child can attach as a tmux control client.
# shellcheck disable=SC1091 # The shared harness is resolved relative to this probe.
source "$(dirname "$0")/../lib.sh"

A="10_popup_attach.txt"
pd_reset_artifact "$A"
tmux_version="$(TMUX='' "$TMUX_BIN" -V)"

sock="$(pd_server popup)"
outer_pid=""
inner="$RESULTS_DIR/10_inner.sh"
out="$RESULTS_DIR/10_inner_out.txt"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tmux-pane-dash-popup.XXXXXX")"
argv_inner="$temp_dir/argv_inner.sh"
argv_out="$temp_dir/argv_out.txt"
argv_expected="$temp_dir/argv_expected.txt"
argv_form_passed=0

cleanup() {
  rm -rf "$temp_dir"
  TMUX='' pd_kill_server "$sock"
  if [[ -n "$outer_pid" ]]; then
    kill "$outer_pid" 2>/dev/null || true
    wait "$outer_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'exit 130' INT TERM

has_framed_probe() {
  awk '
    /^%begin / {
      open_ts = $2
      open_num = $3
      in_frame = 1
      probed = 0
      next
    }
    in_frame && /^PROBE:%/ { probed = 1; next }
    /^%end / {
      if (in_frame && $2 == open_ts && $3 == open_num && probed) found = 1
      in_frame = 0
      probed = 0
      next
    }
    /^%error / {
      in_frame = 0
      probed = 0
      next
    }
    END { exit !found }
  ' "$1"
}

parser_self_test() {
  has_framed_probe <(printf '%%begin 1 2 0\nPROBE:%%0\n%%end 1 2 0\n') &&
    ! has_framed_probe <(printf '%%begin 1 2 0\n%%end 1 2 0\nPROBE:%%0\n%%end 1 2 0\n') &&
    ! has_framed_probe <(printf '%%begin 1 2 0\nPROBE:%%0\n%%error 1 2 0\n') &&
    ! has_framed_probe <(printf '%%begin 1 2 0\nPROBE:%%0\n%%end 1 3 0\n')
}

parser_self_test || { echo "popup control-frame parser self-test failed" >&2; exit 1; }

TMUX='' pd_new_server "$sock"
: > "$out"
: > "$argv_out"
sid="$(TMUX='' "$TMUX_BIN" -L "$sock" display-message -p -t base '#{session_id}')"

# This script is launched by display-popup, not by the outer attached client.
# It attaches as a separate control client and records that client's transcript.
cat > "$inner" <<EOF
#!/usr/bin/env bash
{
  printf 'list-panes -a -F "PROBE:#{pane_id}"\n'
} | TMUX='' "$TMUX_BIN" -L "$sock" -C attach-session -f no-output,ignore-size -t '$sid' > "$out" 2>&1
EOF
chmod +x "$inner"

# This script receives argv directly from display-popup's multi-argument
# launcher form. Its output verifies that tmux does not route these values
# through a shell or expand their format-looking contents.
cat > "$argv_inner" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$argv_out"
EOF
chmod +x "$argv_inner"

# display-popup must target a real attached client. BSD script supplies its PTY.
{ sleep 8; } | TMUX='' script -q /dev/null "$TMUX_BIN" -L "$sock" attach-session -t base \
  >/dev/null 2>&1 &
outer_pid=$!

client_tty=""
for _ in {1..20}; do
  client_tty="$(TMUX='' "$TMUX_BIN" -L "$sock" list-clients -F '#{client_tty}' 2>/dev/null || true)"
  [[ -n "$client_tty" ]] && break
  sleep 0.1
done

if [[ -z "$client_tty" ]]; then
  pd_record "$A" "VERDICT: FAILED — fallback addendum required (control client outside popup)"
  pd_record "$A" "ERROR: timed out waiting for the outer attached client"
  exit 1
fi

# The popup shell only receives an absolute executable path. All tmux values
# are baked into the bash child above, so fish cannot reinterpret them.
TMUX='' "$TMUX_BIN" -L "$sock" display-popup -c "$client_tty" -E "$inner" || true

# Wait only for the ordered framed response; %exit is recorded independently.
for _ in {1..60}; do
  if has_framed_probe "$out" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if has_framed_probe "$out"; then
  pd_record "$A" "VERDICT: popup-interior control attach WORKS"
  if grep -q '^%exit$' "$out"; then
    pd_record "$A" "FINDING: control client emitted %exit on clean stdin EOF ($tmux_version)"
  else
    pd_record "$A" "FINDING: no %exit observed on stdin EOF ($tmux_version)"
  fi
else
  pd_record "$A" "VERDICT: FAILED — fallback addendum required (control client outside popup)"
fi
pd_record "$A" "--- raw inner output ---"
cat "$out" >> "$(pd_artifact "$A")"

arg_space='value with spaces'
arg_format='#{session_name}'
arg_quotes=$'quotes: "double" and \'single\''
printf '%s\n' "$arg_space" "$arg_format" "$arg_quotes" > "$argv_expected"

TMUX='' "$TMUX_BIN" -L "$sock" display-popup -c "$client_tty" -E \
  "$argv_inner" "$arg_space" "$arg_format" "$arg_quotes" || true

for _ in {1..20}; do
  if cmp -s "$argv_expected" "$argv_out"; then
    argv_form_passed=1
    break
  fi
  sleep 0.1
done

if (( argv_form_passed )); then
  pd_record "$A" "FINDING: display-popup multi-argument argv preserves hostile args exactly ($tmux_version)"
else
  pd_record "$A" "FINDING: display-popup multi-argument argv FAILED to preserve hostile args ($tmux_version)"
  pd_record "$A" "--- expected popup argv ---"
  cat "$argv_expected" >> "$(pd_artifact "$A")"
  pd_record "$A" "--- actual popup argv ---"
  cat "$argv_out" >> "$(pd_artifact "$A")"
fi

grep -q 'VERDICT: popup-interior control attach WORKS' "$(pd_artifact "$A")" &&
  (( argv_form_passed == 1 ))
