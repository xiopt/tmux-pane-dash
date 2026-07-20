#!/usr/bin/env bash
# Measure launch through the first real terminal frame 20 times.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${PANE_DASH_BIN:-$ROOT/bin/pane-dash}"
TMUX_BIN="$(command -v "${TMUX_BIN:-tmux}")"
VERSION="$("$TMUX_BIN" -V | tr ' ' '_')"
RESULTS_DIR="$ROOT/spike/results/$VERSION"
RESULT="$RESULTS_DIR/80_coldframe.txt"
RUNS=20
scratch_sock=""
scratch_client_pid=""
scratch_dir=""
client_tty=""
session_id=""
pane_id=""
declare -a run_env=()

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "$scratch_client_pid" ]]; then
    kill "$scratch_client_pid" 2>/dev/null || true
    wait "$scratch_client_pid" 2>/dev/null || true
  fi
  if [[ -n "$scratch_sock" ]]; then
    TMUX='' "$TMUX_BIN" -L "$scratch_sock" kill-server 2>/dev/null || true
  fi
  [[ -z "$scratch_dir" ]] || rm -rf "$scratch_dir"
}
trap cleanup EXIT

[[ -x "$BIN" ]] || fail "binary is not executable: $BIN (run make build)"
mkdir -p "$RESULTS_DIR"

if [[ -n "${TMUX:-}" ]]; then
  client_tty="$("$TMUX_BIN" display-message -p '#{client_tty}' 2>/dev/null || true)"
  session_id="$("$TMUX_BIN" display-message -p '#{session_id}' 2>/dev/null || true)"
  pane_id="$("$TMUX_BIN" display-message -p '#{pane_id}' 2>/dev/null || true)"
fi

if [[ -z "$client_tty" || -z "$session_id" || -z "$pane_id" ]]; then
  scratch_sock="pd-coldframe-$$"
  scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/pane-dash-coldframe.XXXXXX")"
  wrapper_dir="$scratch_dir/bin"
  mkdir -p "$wrapper_dir"
  cat > "$wrapper_dir/tmux" <<EOF
#!/usr/bin/env bash
exec "$TMUX_BIN" -L "$scratch_sock" "\$@"
EOF
  chmod +x "$wrapper_dir/tmux"
  TMUX='' "$TMUX_BIN" -L "$scratch_sock" -f /dev/null new-session -d -s cold -x 200 -y 60 'sleep 120'
  for _ in $(seq 1 29); do
    TMUX='' "$TMUX_BIN" -L "$scratch_sock" split-window -d -t cold:0 'sleep 120'
  done
  { sleep 120; } | TMUX='' script -q /dev/null "$TMUX_BIN" -L "$scratch_sock" attach-session -t cold >/dev/null 2>&1 &
  scratch_client_pid=$!
  for _ in $(seq 1 30); do
    client_tty="$(TMUX='' "$TMUX_BIN" -L "$scratch_sock" list-clients -F '#{client_tty}' 2>/dev/null | head -n 1 || true)"
    [[ -n "$client_tty" ]] && break
    sleep 0.1
  done
  session_id="$(TMUX='' "$TMUX_BIN" -L "$scratch_sock" list-clients -F '#{session_id}' | head -n 1)"
  pane_id="$(TMUX='' "$TMUX_BIN" -L "$scratch_sock" list-clients -F '#{pane_id}' | head -n 1)"
  run_env=("TMUX=" "PATH=$wrapper_dir:$PATH")
fi

[[ -n "$client_tty" && -n "$session_id" && -n "$pane_id" ]] || fail "could not resolve a live tmux client"

samples="$scratch_dir/samples"
[[ -n "$scratch_dir" ]] || samples="$(mktemp "${TMPDIR:-/tmp}/pane-dash-coldframe.XXXXXX")"
trap '[[ -n "$scratch_dir" ]] || rm -f "$samples"; cleanup' EXIT
: > "$samples"
for _ in $(seq 1 "$RUNS"); do
  stderr="$(mktemp "${TMPDIR:-/tmp}/pane-dash-coldframe-stderr.XXXXXX")"
  # shellcheck disable=SC2016 # The child shell, not this probe, expands its positional arguments.
  script -q /dev/null env "${run_env[@]}" bash -c 'stderr=$1; shift; exec "$@" 2>"$stderr"' \
    pane-dash-coldframe "$stderr" "$BIN" --bench-first-frame "$client_tty" "$session_id" "$pane_id" >/dev/null
  value="$(awk -F= '/^pane-dash coldframe_ms=/{print $2}' "$stderr")"
  rm -f "$stderr"
  [[ "$value" =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail "missing coldframe measurement"
  printf '%s\n' "$value" >> "$samples"
done

sort -n "$samples" -o "$samples"
p50="$(sed -n '10p' "$samples")"
p95="$(sed -n '19p' "$samples")"
{
  printf '# coldframe: tmux %s; date: %s; runs: %s\n' "$("$TMUX_BIN" -V)" "$(date -u +%FT%TZ)" "$RUNS"
  printf 'samples_ms: %s\n' "$(tr '\n' ' ' < "$samples" | sed 's/ $//')"
  printf 'p50_ms: %s\n' "$p50"
  printf 'p95_ms: %s\n' "$p95"
} > "$RESULT"
cat "$RESULT"
