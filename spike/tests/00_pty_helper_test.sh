#!/usr/bin/env bash
# Regression tests for portable PTY attachment used by popup/lifecycle probes.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/tmux-pane-dash-pty.XXXXXX")"

cleanup() {
  rm -rf "$tmp" "$SPIKE_DIR/results/tmux_fake"
}
trap cleanup EXIT

cat > "$tmp/tmux" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == '-V' ]]
printf 'tmux fake\n'
EOF
chmod +x "$tmp/tmux"
export TMUX_BIN="$tmp/tmux"
# shellcheck disable=SC1091 # Shared harness is resolved relative to this test.
source "$SPIKE_DIR/lib.sh"

cat > "$tmp/recorder" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "TERM=$TERM" > "$PTY_RECORD_PREFIX.env"
printf '%s\0' "$@" > "$PTY_RECORD_PREFIX.argv"
cat > "$PTY_RECORD_PREFIX.stdin"
EOF
chmod +x "$tmp/recorder"

cat > "$tmp/script" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == '--version' ]]; then
  if [[ "$FAKE_SCRIPT_FLAVOR" == util-linux ]]; then
    printf 'script from util-linux 2.39\n'
    exit 0
  fi
  printf 'script: illegal option -- -\n' >&2
  exit 1
fi

printf '%s\0' "$@" > "$PTY_RECORD_PREFIX.script_argv"
if [[ "$FAKE_SCRIPT_FLAVOR" == bsd ]]; then
  [[ "$1" == '-q' && "$2" == '/dev/null' ]]
  shift 2
  exec "$@"
fi

[[ "$1" == '-q' && "$2" == '-c' && "$4" == '/dev/null' ]]
exec /bin/sh -c "$3"
EOF
chmod +x "$tmp/script"

assert_recording() { # $1=prefix $2=expected TERM
  local prefix="$1" expected_term="$2"
  local expected="$prefix.expected"

  printf '%s\0' 'space value' "O'Reilly" '#{session_name}' '"quoted"' > "$expected"
  cmp -s "$expected" "$prefix.argv"
  grep -Fxq "TERM=$expected_term" "$prefix.env"
  cmp -s <(printf 'piped stdin\n') "$prefix.stdin"
}

run_branch() { # $1=flavor $2=TERM input $3=expected TERM
  local flavor="$1" term_input="$2" expected_term="$3"
  local prefix="$tmp/$flavor-${term_input:-unset}"

  printf 'piped stdin\n' | \
    FAKE_SCRIPT_FLAVOR="$flavor" PTY_RECORD_PREFIX="$prefix" TERM="$term_input" \
    PD_SCRIPT_BIN="$tmp/script" pd_run_in_pty "$tmp/recorder" \
      'space value' "O'Reilly" '#{session_name}' '"quoted"'
  assert_recording "$prefix" "$expected_term"
}

run_branch bsd '' xterm
run_branch bsd dumb xterm
run_branch util-linux '' xterm
run_branch util-linux dumb xterm
run_branch util-linux screen-256color screen-256color
