#!/usr/bin/env bash
# tests/integration.sh — real-tmux checks on an isolated server (tmux -L).
# Run OUTSIDE any tmux session preferably; TMUX is cleared defensively.
set -euo pipefail

SOCK="pd-int-$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T() { TMUX='' command tmux -L "$SOCK" "$@"; }
fail() { echo "FAIL: $1"; T kill-server 2>/dev/null || true; exit 1; }
pass() { echo "ok: $1"; }
pane_has_command() { [ "$(T display-message -p -t "$1" '#{pane_current_command}')" = "$2" ]; }
capture_has_line() { T capture-pane -p -t "$1" | grep -Fxq -- "$2"; }
wait_for() {
  local what="$1" pane="$2" deadline current capture
  shift 2
  deadline="$(perl -MTime::HiRes=time -e 'print time + 2')"
  while ! "$@"; do
    if ! perl -e 'exit $ARGV[0] < $ARGV[1] ? 0 : 1' "$(perl -MTime::HiRes=time -e 'print time')" "$deadline"; then
      current="$(T display-message -p -t "$pane" '#{pane_current_command}' 2>&1 || true)"
      capture="$(T capture-pane -p -t "$pane" 2>&1 || true)"
      fail "$what (current command: $current; capture: $capture)"
    fi
    sleep 0.02
  done
}

trap 'T kill-server 2>/dev/null || true' EXIT
T -f /dev/null new-session -d -s alpha -x 120 -y 30

pane="$(T display-message -p -t alpha '#{pane_id}')"

# 1. Plugin setup appends focus entries without taking a user's index.
T set-hook -g 'client-focus-in[31337]' 'display-message user-focus-in'
T set-hook -g 'client-focus-out[31337]' 'display-message user-focus-out'
T set-option -s 'terminal-features[31337]' 'user*:RGB'
T run-shell "$ROOT/pane_dash.tmux"
T run-shell "$ROOT/pane_dash.tmux"
focus_in_hooks="$(T show-hooks -g client-focus-in)"
focus_out_hooks="$(T show-hooks -g client-focus-out)"
terminal_features="$(T show-options -sv terminal-features)"
[ "$(printf '%s\n' "$focus_in_hooks" | grep -Fxc 'client-focus-in[31337] display-message user-focus-in')" = "1" ] \
  || fail "plugin replaced user client-focus-in hook"
[ "$(printf '%s\n' "$focus_out_hooks" | grep -Fxc 'client-focus-out[31337] display-message user-focus-out')" = "1" ] \
  || fail "plugin replaced user client-focus-out hook"
[ "$(printf '%s\n' "$focus_in_hooks" | grep -Fc '@pane_dash_focus_#{hook_client}')" = "1" ] \
  || fail "plugin client-focus-in hook count"
[ "$(printf '%s\n' "$focus_out_hooks" | grep -Fc '@pane_dash_focus_#{hook_client}')" = "1" ] \
  || fail "plugin client-focus-out hook count"
[ "$(printf '%s\n' "$terminal_features" | grep -Fxc 'user*:RGB')" = "1" ] \
  || fail "plugin replaced user terminal feature"
[ "$(printf '%s\n' "$terminal_features" | grep -Fxc '*:focus')" = "1" ] \
  || fail "plugin focus terminal feature count"
pass "plugin focus setup preserves same-index entries and is idempotent"

# 2. pane options: set, read via display-message format, unset
T set-option -p -t "$pane" @pane_dash_status working
[ "$(T display-message -p -t "$pane" '#{@pane_dash_status}')" = "working" ] \
  || fail "pane option roundtrip"
T set-option -pu -t "$pane" @pane_dash_status
[ -z "$(T display-message -p -t "$pane" '#{@pane_dash_status}')" ] \
  || fail "pane option unset"
pass "pane user options"

# 3. list.sh against the real server: default grouping emits a session header and child row
T set-option -p -t "$pane" @pane_dash_tag itest
row="$(TMUX='' PATH="$PATH" bash -c "cd '$ROOT' && tmux() { command tmux -L '$SOCK' \"\$@\"; }; export -f tmux; scripts/list.sh")"
[ "$(printf '%s\n' "$row" | wc -l | tr -d ' ')" = "2" ] || fail "list.sh grouped row count"
printf '%s\n' "$row" | sed -n '1p' | grep -Eq '^\$[0-9]+\t' || fail "list.sh session header key"
printf '%s\n' "$row" | sed -n '2p' | grep -q "^$pane	" || fail "list.sh pane id field"
pass "list.sh against real server"

# 4. capture: normal vs alternate screen
T send-keys -t "$pane" 'printf NORMALMARKER; sleep 0.2' Enter
sleep 1
T capture-pane -ep -t "$pane" | grep -q NORMALMARKER || fail "normal capture"
[ "$(T display-message -p -t "$pane" '#{alternate_on}')" = "0" ] || fail "alternate_on flag 0"
pass "capture normal screen"

# 5. switch-client requires a client. A script(1)-backed PTY is not reliable
#    here because this non-interactive test runner closes its stdin, so assert
#    tmux's documented detached-server failure precisely instead.
# Use an unconfigured shell so this timing gate measures tmux delivery, not
# user shell initialization.
T set-option -g default-shell /bin/sh
T new-session -d -s beta
pane_b="$(T display-message -p -t beta '#{pane_id}')"
if switch_error="$(T switch-client -t "$pane_b" 2>&1)"; then
  fail "switch-client unexpectedly accepted a detached target"
fi
case "$switch_error" in
  'no current client' | 'no clients') ;;
  *) fail "switch-client detached failure: $switch_error" ;;
esac
pass "switch-client detached failure"

# 6. send-keys -l literal: C-c must arrive as text, not as a key
T send-keys -t "$pane_b" cat Enter
wait_for "cat did not start" "$pane_b" pane_has_command "$pane_b" cat
T send-keys -l -t "$pane_b" -- 'C-c'
T send-keys -t "$pane_b" Enter
wait_for "literal send-keys" "$pane_b" capture_has_line "$pane_b" 'C-c'
pass "literal send-keys"

echo "ALL INTEGRATION CHECKS PASSED"
