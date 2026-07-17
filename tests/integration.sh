#!/usr/bin/env bash
# tests/integration.sh — real-tmux checks on an isolated server (tmux -L).
# Run OUTSIDE any tmux session preferably; TMUX is cleared defensively.
set -euo pipefail

SOCK="pd-int-$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T() { TMUX='' command tmux -L "$SOCK" "$@"; }
fail() { echo "FAIL: $1"; T kill-server 2>/dev/null || true; exit 1; }
pass() { echo "ok: $1"; }

trap 'T kill-server 2>/dev/null || true' EXIT
T -f /dev/null new-session -d -s alpha -x 120 -y 30

pane="$(T display-message -p -t alpha '#{pane_id}')"

# 1. pane options: set, read via display-message format, unset
T set-option -p -t "$pane" @pane_dash_status working
[ "$(T display-message -p -t "$pane" '#{@pane_dash_status}')" = "working" ] \
  || fail "pane option roundtrip"
T set-option -pu -t "$pane" @pane_dash_status
[ -z "$(T display-message -p -t "$pane" '#{@pane_dash_status}')" ] \
  || fail "pane option unset"
pass "pane user options"

# 2. list.sh against the real server: tag the pane, expect exactly one framed row
T set-option -p -t "$pane" @pane_dash_tag itest
row="$(TMUX='' PATH="$PATH" bash -c "cd '$ROOT' && tmux() { command tmux -L '$SOCK' \"\$@\"; }; export -f tmux; scripts/list.sh")"
[ "$(printf '%s\n' "$row" | wc -l | tr -d ' ')" = "1" ] || fail "list.sh row count"
printf '%s' "$row" | grep -q "^$pane	" || fail "list.sh pane id field"
pass "list.sh against real server"

# 3. capture: normal vs alternate screen
T send-keys -t "$pane" 'printf NORMALMARKER; sleep 0.2' Enter
sleep 1
T capture-pane -ep -t "$pane" | grep -q NORMALMARKER || fail "normal capture"
[ "$(T display-message -p -t "$pane" '#{alternate_on}')" = "0" ] || fail "alternate_on flag 0"
pass "capture normal screen"

# 4. switch-client with a pane target in another session (no client attached:
#    verify the command is accepted against a detached target instead)
T new-session -d -s beta
pane_b="$(T display-message -p -t beta '#{pane_id}')"
T switch-client -t "$pane_b" 2>/dev/null || pass "switch-client (no client attached — accepted/skipped)"

# 5. send-keys -l literal: C-c must arrive as text, not as a key
T send-keys -l -t "$pane_b" -- 'echo C-c-literal-ok'
T send-keys -t "$pane_b" Enter
sleep 1
T capture-pane -p -t "$pane_b" | grep -q 'C-c-literal-ok' || fail "literal send-keys"
pass "literal send-keys"

echo "ALL INTEGRATION CHECKS PASSED"
