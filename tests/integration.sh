#!/usr/bin/env bash
# tests/integration.sh — real-tmux checks on an isolated server (tmux -L).
# Run OUTSIDE any tmux session preferably; TMUX is cleared defensively.
set -euo pipefail

SOCK="pd-int-$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmux_bin_candidate="${TMUX_BIN:-tmux}"
tmux_bin="$(command -v "$tmux_bin_candidate")"
tmux_dir="$(dirname "$tmux_bin")"
export PATH="$tmux_dir:$PATH"
T() { TMUX='' "$tmux_bin" -L "$SOCK" "$@"; }
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

# 1. Plugin setup preserves user hooks and upgrades pane-dash hooks in place.
T set-hook -g 'client-focus-in[31337]' 'display-message user-focus-in'
T set-hook -g 'client-focus-out[31337]' 'display-message user-focus-out'
T set-hook -g 'after-select-pane[31337]' 'display-message user-select-pane'
unrelated_notify_hook='run-shell -b "user notify hook focus --client #{q:hook_client} --pane #{q:hook_pane}"'
legacy_notify_hook="run-shell -b \"TMUX=#{q:socket_path},#{q:pid},0 #{q:@pane_dash_notify_binary} notify hook focus --client '#{q:hook_client}' --pane '#{q:pane_id}' --width '#{q:client_width}' --focused 1 >/dev/null 2>&1\""
T set-hook -g 'after-select-pane[31338]' "$unrelated_notify_hook"
T set-hook -g 'after-select-pane[31339]' "$legacy_notify_hook"
select_pane_hooks_before="$(T show-hooks -g after-select-pane)"
unrelated_hook_before="$(printf '%s\n' "$select_pane_hooks_before" | grep -F 'after-select-pane[31338]')"
legacy_hook_before="$(printf '%s\n' "$select_pane_hooks_before" | grep -F 'after-select-pane[31339]')"
T set-option -s 'terminal-features[31337]' 'user*:RGB'
T run-shell "$ROOT/pane_dash.tmux"
focus_in_hooks="$(T show-hooks -g client-focus-in)"
focus_out_hooks="$(T show-hooks -g client-focus-out)"
select_pane_hooks="$(T show-hooks -g after-select-pane)"
terminal_features="$(T show-options -sv terminal-features)"
[ "$(printf '%s\n' "$focus_in_hooks" | grep -Fxc 'client-focus-in[31337] display-message user-focus-in')" = "1" ] \
  || fail "plugin replaced user client-focus-in hook"
[ "$(printf '%s\n' "$focus_out_hooks" | grep -Fxc 'client-focus-out[31337] display-message user-focus-out')" = "1" ] \
  || fail "plugin replaced user client-focus-out hook"
[ "$(printf '%s\n' "$focus_in_hooks" | grep -Fc '@pane_dash_focus_#{hook_client}')" = "1" ] \
  || fail "plugin client-focus-in hook count"
[ "$(printf '%s\n' "$focus_out_hooks" | grep -Fc '@pane_dash_focus_#{hook_client}')" = "1" ] \
  || fail "plugin client-focus-out hook count"
[ "$(printf '%s\n' "$select_pane_hooks" | grep -Fxc 'after-select-pane[31337] display-message user-select-pane')" = "1" ] \
  || fail "plugin replaced user after-select-pane hook"
[ "$(printf '%s\n' "$select_pane_hooks" | grep -Fxc -- "$unrelated_hook_before")" = "1" ] \
  || fail "unrelated notify-looking after-select-pane hook changed"
[ "$(printf '%s\n' "$select_pane_hooks" | grep -Fxc -- "$legacy_hook_before")" = "0" ] \
  || fail "legacy pane-dash after-select-pane hook survived"
[ "$(printf '%s\n' "$select_pane_hooks" | grep -Fc 'after-select-pane[31339]')" = "1" ] \
  || fail "pane-dash after-select-pane hook was not replaced in place"
select_pane_owned="$(printf '%s\n' "$select_pane_hooks" | grep -F 'after-select-pane[31339]' || true)"
case "$select_pane_owned" in
  *'#{q:client_tty}'*'#{q:pane_id}'*) ;;
  *) fail "after-select-pane hook did not use generic client/pane formats" ;;
esac
case "$select_pane_owned" in
  *'#{q:hook_client}'*|*'#{q:hook_pane}'*) fail "after-select-pane hook retained authoritative-only formats" ;;
esac
case "$select_pane_owned" in
  *'--acknowledge 1'*) ;;
  *) fail "after-select-pane hook does not acknowledge focused pane notifications" ;;
esac
for hook in client-focus-in client-focus-out after-select-window client-session-changed client-resized; do
  hook_lines="$(T show-hooks -g "$hook")"
  hook_line="$(printf '%s\n' "$hook_lines" | grep -F 'notify hook focus --client' || true)"
  [ "$(printf '%s\n' "$hook_lines" | grep -Fc 'notify hook focus --client')" = "1" ] \
    || fail "$hook notification hook count"
  case "$hook_line" in
    *'#{q:pane_id}'*'#{q:client_width}'*) ;;
    *) fail "$hook notification hook missing generic pane/width formats" ;;
  esac
  case "$hook" in
    after-select-window)
      case "$hook_line" in
        *'#{q:client_tty}'*'#{q:hook_client}'*) fail "$hook mixed client formats" ;;
        *'#{q:client_tty}'*) ;;
        *) fail "$hook did not use generic client format" ;;
      esac
      ;;
    *)
      case "$hook_line" in
        *'#{q:hook_client}'*) ;;
        *) fail "$hook did not use hook client format" ;;
      esac
      ;;
  esac
  case "$hook" in
    client-focus-out|client-resized) expected_acknowledge=0 ;;
    *) expected_acknowledge=1 ;;
  esac
  case "$hook_line" in
    *"--acknowledge $expected_acknowledge"*) ;;
    *) fail "$hook notification acknowledgment mode" ;;
  esac
done
pane_exited_hooks="$(T show-hooks -g pane-exited)"
pane_exited_line="$(printf '%s\n' "$pane_exited_hooks" | grep -F 'notify hook pane-exited' || true)"
case "$pane_exited_line" in
  *'#{q:hook_pane}'*) ;;
  *) fail "pane-exited hook did not use hook pane format" ;;
esac
select_pane_hooks_first="$select_pane_hooks"
T run-shell "$ROOT/pane_dash.tmux"
select_pane_hooks_second="$(T show-hooks -g after-select-pane)"
[ "$select_pane_hooks_second" = "$select_pane_hooks_first" ] || fail "plugin reload was not idempotent"
[ "$(printf '%s\n' "$select_pane_hooks_second" | grep -Fxc 'after-select-pane[31337] display-message user-select-pane')" = "1" ] \
  || fail "plugin reload changed unrelated after-select-pane hook"
[ "$(printf '%s\n' "$terminal_features" | grep -Fxc 'user*:RGB')" = "1" ] \
  || fail "plugin replaced user terminal feature"
[ "$(printf '%s\n' "$terminal_features" | grep -Fxc '*:focus')" = "1" ] \
  || fail "plugin focus terminal feature count"
mouse_binding="$(T list-keys -T root | grep 'MouseDown1Status ' || true)"
case "$mouse_binding" in
  *'"{ run-shell'*|*'"{ if-shell'*) fail "status mouse binding wraps an executable branch in an invalid command group" ;;
esac
T if-shell -F 1 'run-shell -b "true"' 'if-shell -F 0 { run-shell -b "false" } { run-shell -b "true" }' \
  || fail "status mouse branch grammar is not executable"
pass "plugin focus setup preserves same-index entries and is idempotent"

# 2. pane options: set, read via display-message format, unset
T set-option -p -t "$pane" @pane_dash_status working
[ "$(T display-message -p -t "$pane" '#{@pane_dash_status}')" = "working" ] \
  || fail "pane option roundtrip"
T set-option -pu -t "$pane" @pane_dash_status
[ -z "$(T display-message -p -t "$pane" '#{@pane_dash_status}')" ] \
  || fail "pane option unset"
pass "pane user options"

# 3. capture: normal vs alternate screen
T send-keys -t "$pane" 'printf NORMALMARKER; sleep 0.2' Enter
sleep 1
T capture-pane -ep -t "$pane" | grep -q NORMALMARKER || fail "normal capture"
[ "$(T display-message -p -t "$pane" '#{alternate_on}')" = "0" ] || fail "alternate_on flag 0"
pass "capture normal screen"

# 4. switch-client requires a client. A script(1)-backed PTY is not reliable
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

# 5. send-keys -l literal: C-c must arrive as text, not as a key
T send-keys -t "$pane_b" cat Enter
wait_for "cat did not start" "$pane_b" pane_has_command "$pane_b" cat
T send-keys -l -t "$pane_b" -- 'C-c'
T send-keys -t "$pane_b" Enter
wait_for "literal send-keys" "$pane_b" capture_has_line "$pane_b" 'C-c'
pass "literal send-keys"

echo "ALL INTEGRATION CHECKS PASSED"
