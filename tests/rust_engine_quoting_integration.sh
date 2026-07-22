#!/usr/bin/env bash
# Exercise Rust bindings through real tmux with hostile plugin and PATH names.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMUX_BIN="$(command -v "${TMUX_BIN:-tmux}")"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pane-dash-quoting.XXXXXX")"
declare -a CLIENT_PIDS=() SOCKETS=()

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  local pid socket
  for pid in "${CLIENT_PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  for socket in "${SOCKETS[@]:-}"; do TMUX='' "$TMUX_BIN" -S "$socket" kill-server 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM

wait_for() { # description command...
  local description=$1 remaining=100
  shift
  while ((remaining--)); do "$@" && return 0; sleep .05; done
  fail "timeout waiting for $description"
}

start_clients() { # socket
  local socket=$1
  { sleep 600; } | TMUX='' script -q /dev/null "$TMUX_BIN" -S "$socket" attach-session -t one >/dev/null 2>&1 & CLIENT_PIDS+=("$!")
  { sleep 600; } | TMUX='' script -q /dev/null "$TMUX_BIN" -S "$socket" attach-session -t two >/dev/null 2>&1 & CLIENT_PIDS+=("$!")
  wait_for 'two attached clients' bash -c "[ \"\$(TMUX='' '$TMUX_BIN' -S '$socket' list-clients | wc -l | tr -d ' ')\" = 2 ]"
}

write_recorder() { # binary log executed-marker
  cat > "$1" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$@" > "$2"
touch "$3"
exit 42
EOF
  chmod +x "$1"
}

run_scenario() { # local|path
  local mode=$1 socket wrapper log executed tmux_log
  local local_sentinel="$TMP/$mode.local-sentinel" backtick_sentinel="$TMP/$mode.backtick-sentinel" plugin path_dir='' binary hostile binding expected_tty expected_session expected_pane actual hostile_engine
  socket="$TMP/$mode.socket"; wrapper="$TMP/$mode-wrapper"; log="$TMP/$mode.argv"; executed="$TMP/$mode.executed"; tmux_log="$TMP/$mode.tmux.log"
  SOCKETS+=("$socket")
  mkdir -p "$wrapper"
  cat > "$wrapper/tmux" <<EOF
#!/usr/bin/env bash
printf '%s\037' "\$@" >> "$tmux_log"
printf '\n' >> "$tmux_log"
exec "$TMUX_BIN" -S "$socket" "\$@"
EOF
  chmod +x "$wrapper/tmux"
  # shellcheck disable=SC2016 # These command substitutions are hostile literal path bytes.
  printf -v hostile '%s/plugin space '\'' " $(touch %s) ;#`touch %s`' "$TMP" "$local_sentinel" "$backtick_sentinel"
  plugin="$hostile"
  mkdir -p "$plugin/scripts"
  cp "$ROOT/pane_dash.tmux" "$plugin/"
  cp "$ROOT/scripts/open.sh" "$plugin/scripts/"
  if [ "$mode" = local ]; then
    mkdir -p "$plugin/bin"
    binary="$plugin/bin/pane-dash"
  else
    # shellcheck disable=SC2016 # These command substitutions are hostile literal path bytes.
    printf -v path_dir '%s/path space " $(touch %s) ;#`touch %s`' "$TMP" "$local_sentinel" "$backtick_sentinel"
    mkdir -p "$path_dir"
    binary="$path_dir/pane-dash"
  fi
  write_recorder "$binary" "$log" "$executed"

  TMUX='' "$TMUX_BIN" -S "$socket" -f /dev/null new-session -d -s one 'exec cat'
  TMUX='' "$TMUX_BIN" -S "$socket" new-session -d -s two 'exec cat'
  start_clients "$socket"

  hostile_engine=$'bad\n\033[31m;$(touch never);`touch never`\047'
  TMUX='' "$TMUX_BIN" -S "$socket" set-option -g @pane-dash-engine "$hostile_engine"
  TMUX='' PATH="$wrapper:$path_dir:$PATH" "$plugin/pane_dash.tmux"
  grep -Fqx $'display-message\037pane-dash: invalid @pane-dash-engine value; using Rust-first resolution\037' "$tmux_log" || fail "$mode hostile engine warning"
  ! grep -F 'never' "$tmux_log" || fail "$mode hostile engine payload echoed"
  ! [ -e "$TMP/never" ] || fail "$mode hostile engine executed"
  TMUX='' "$TMUX_BIN" -S "$socket" set-option -gu @pane-dash-engine
  TMUX='' PATH="$wrapper:$path_dir:$PATH" "$plugin/pane_dash.tmux"

  binding="$(TMUX='' "$TMUX_BIN" -S "$socket" list-keys -T prefix | awk '$4 == "D" { print; exit }')"
  if [ "$mode" = path ]; then
    [[ "$binding" == *"'/"* ]] || fail "$mode binding omitted absolute binary"
    [[ "$binding" == *'/pane-dash'* ]] || fail "$mode binding omitted pane-dash filename"
  fi
  [[ "$binding" != *dash.sh* ]] || fail "$mode unexpectedly bound legacy dashboard"
  ! [ -e "$local_sentinel" ] || fail "$mode dollar command substitution executed"
  ! [ -e "$backtick_sentinel" ] || fail "$mode backtick substitution executed"
  ! [ -e "$executed" ] || fail "$mode binary executed while loading"

  expected_tty="$(TMUX='' "$TMUX_BIN" -S "$socket" list-clients -t two -F '#{client_tty}')"
  expected_session="$(TMUX='' "$TMUX_BIN" -S "$socket" list-clients -t two -F '#{session_id}')"
  expected_pane="$(TMUX='' "$TMUX_BIN" -S "$socket" list-clients -t two -F '#{pane_id}')"
  TMUX='' "$TMUX_BIN" -S "$socket" send-keys -K -c "$expected_tty" C-b D
  wait_for "$mode recorder" test -s "$log"
  actual="$(paste -sd $'\t' "$log")"
  [[ "$actual" = "$expected_tty"$'\t'"$expected_session"$'\t'"$expected_pane" ]] || fail "$mode argv [$actual]"
  [ -e "$executed" ] || fail "$mode recorder marker did not prove invocation"
  binding="$(TMUX='' "$TMUX_BIN" -S "$socket" list-keys -T prefix | awk '$4 == "D" { print; exit }')"
  [[ "$binding" != *dash.sh* ]] || fail "$mode runtime failure rebound dashboard"
  ! [ -e "$local_sentinel" ] || fail "$mode substitution executed on launch"
  ! [ -e "$backtick_sentinel" ] || fail "$mode backtick executed on launch"
  printf 'ok: hostile %s route captured exact second-client argv\n' "$mode"
}

run_scenario local
run_scenario path
