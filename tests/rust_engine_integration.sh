#!/usr/bin/env bash
# Verify the Rust launcher expands binding-time identities for the invoking client.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMUX_BIN="$(command -v "${TMUX_BIN:-tmux}")"
SOCK="pd-rust-routing-$$"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pane-dash-routing.XXXXXX")"
CLIENT1_PID=""
CLIENT2_PID=""

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  kill "$CLIENT1_PID" "$CLIENT2_PID" 2>/dev/null || true
  wait "$CLIENT1_PID" 2>/dev/null || true
  wait "$CLIENT2_PID" 2>/dev/null || true
  TMUX='' "$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

PLUGIN="$TMP/plugin"
WRAPPER="$TMP/wrapper"
LOG="$TMP/argv.log"
mkdir -p "$PLUGIN/bin" "$PLUGIN/scripts" "$WRAPPER"
cp "$ROOT/pane_dash.tmux" "$PLUGIN/"
cp "$ROOT/scripts/open_v2.sh" "$PLUGIN/scripts/"
cat > "$PLUGIN/bin/pane-dash" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$LOG"
EOF
chmod +x "$PLUGIN/bin/pane-dash"
cat > "$WRAPPER/tmux" <<EOF
#!/usr/bin/env bash
exec "$TMUX_BIN" -L "$SOCK" "\$@"
EOF
chmod +x "$WRAPPER/tmux"

TMUX='' PATH="$WRAPPER:$PATH" "$TMUX_BIN" -L "$SOCK" -f /dev/null new-session -d -s one 'sleep 120'
TMUX='' PATH="$WRAPPER:$PATH" "$TMUX_BIN" -L "$SOCK" new-session -d -s two 'sleep 120'
TMUX='' PATH="$WRAPPER:$PATH" "$TMUX_BIN" -L "$SOCK" set-option -g @pane-dash-engine rust
TMUX='' PATH="$WRAPPER:$PATH" bash "$PLUGIN/pane_dash.tmux"

{ sleep 120; } | TMUX='' script -q /dev/null "$TMUX_BIN" -L "$SOCK" attach-session -t one >/dev/null 2>&1 &
CLIENT1_PID=$!
{ sleep 1; printf '\002D'; sleep 5; } | TMUX='' script -q /dev/null "$TMUX_BIN" -L "$SOCK" attach-session -t two >/dev/null 2>&1 &
CLIENT2_PID=$!

for _ in $(seq 1 30); do
  client_count="$(TMUX='' "$TMUX_BIN" -L "$SOCK" list-clients 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$client_count" = 2 ]] && break
  sleep 0.1
done
[[ "${client_count:-0}" = 2 ]] || fail "two PTY clients did not attach"

expected_tty="$(TMUX='' "$TMUX_BIN" -L "$SOCK" list-clients -t two -F '#{client_tty}')"
expected_session="$(TMUX='' "$TMUX_BIN" -L "$SOCK" list-clients -t two -F '#{session_id}')"
expected_pane="$(TMUX='' "$TMUX_BIN" -L "$SOCK" list-clients -t two -F '#{pane_id}')"
expected="$(printf '%s\t%s\t%s' "$expected_tty" "$expected_session" "$expected_pane")"
for _ in $(seq 1 50); do
  [[ -s "$LOG" ]] && break
  sleep 0.1
done
[[ -s "$LOG" ]] || fail "Rust launcher did not invoke recorder"
actual="$(paste -sd $'\t' "$LOG")"
[[ "$actual" = "$expected" ]] || fail "expected argv [$expected], got [$actual]"
printf 'ok: Rust binding captured client 2 tty/session/pane\n'
