#!/usr/bin/env bash
# Hermetic coverage for the portable PTY launcher used by the tmux integration test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/tmux-pane-dash-pty.XXXXXX")"
marker="$tmp/injected"

cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

# shellcheck disable=SC1091 # Local helper is resolved relative to this test.
source "$ROOT/tests/pane_dash_pty.sh"

hostile_dir="$tmp/hostile path; \$(touch '$marker')"
hostile_executable="$hostile_dir/runner's name"
mkdir -p "$hostile_dir"
cat > "$hostile_executable" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

prefix="${PTY_RECORD_PREFIX:?PTY_RECORD_PREFIX is required}"
printf '%s\0' "$@" > "$prefix.argv"
printf 'TERM=%s\n' "$TERM" > "$prefix.env"
cat > "$prefix.stdin"
EOF
chmod +x "$hostile_executable"

cat > "$tmp/script" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

prefix="${PTY_RECORD_PREFIX:?PTY_RECORD_PREFIX is required}"
flavor="${FAKE_SCRIPT_FLAVOR:?FAKE_SCRIPT_FLAVOR is required}"

if [[ "${1:-}" == '--version' ]]; then
  case "$flavor" in
    bsd)
      printf 'script: illegal option -- -\n' >&2
      exit 1
      ;;
    util-linux)
      printf 'script from util-linux 2.39\n'
      exit 0
      ;;
    *)
      printf 'unknown script flavor: %s\n' "$flavor" >&2
      exit 64
      ;;
  esac
fi

printf '%s\0' "$@" > "$prefix.script-argv"
printf '%s\n' "$(ps -o pgid= -p "$$" | tr -d ' ')" > "$prefix.pgid"
case "$flavor" in
  bsd)
    [[ "$1" == '-q' && "$2" == '/dev/null' ]]
    shift 2
    exec "$@"
    ;;
  util-linux)
    [[ "$1" == '-q' && "$2" == '-c' && "$4" == '/dev/null' ]]
    printf '%s' "$3" > "$prefix.command"
    exec /bin/sh -c "$3"
    ;;
  *)
    printf 'unknown script flavor: %s\n' "$flavor" >&2
    exit 64
    ;;
esac
EOF
chmod +x "$tmp/script"

hostile_arg1="argument; \$(touch '$marker')"
hostile_arg2="prefix \$(touch '$marker') suffix"
hostile_arg3="quote ' and \" and \$HOME"
hostile_arg4=$'line one\nline two'
hostile_arg5='#{pane_id}; echo pwned'
hostile_label="label \$(touch '$marker'); echo pwned"

run_case() {
  local flavor="$1" term_input="$2" expected_term="$3" invocation="${4:-source}"
  local prefix="$tmp/$flavor-${term_input:-unset}"
  local expected_argv="$prefix.expected-argv"
  local expected_stdin="$prefix.expected-stdin"

  printf '%s\0' "$hostile_arg1" "$hostile_arg2" "$hostile_arg3" "$hostile_arg4" "$hostile_arg5" > "$expected_argv"
  printf '%s' "$hostile_label" > "$expected_stdin"

  if [[ "$invocation" == cli ]]; then
    printf '%s' "$hostile_label" | \
      FAKE_SCRIPT_FLAVOR="$flavor" PTY_RECORD_PREFIX="$prefix" TERM="$term_input" \
      PD_SCRIPT_BIN="$tmp/script" "$ROOT/tests/pane_dash_pty.sh" "$hostile_executable" \
        "$hostile_arg1" "$hostile_arg2" "$hostile_arg3" "$hostile_arg4" "$hostile_arg5"
  else
    printf '%s' "$hostile_label" | \
      FAKE_SCRIPT_FLAVOR="$flavor" PTY_RECORD_PREFIX="$prefix" TERM="$term_input" \
      PD_SCRIPT_BIN="$tmp/script" pane_dash_run_in_pty "$hostile_executable" \
        "$hostile_arg1" "$hostile_arg2" "$hostile_arg3" "$hostile_arg4" "$hostile_arg5"
  fi

  cmp -s "$expected_argv" "$prefix.argv"
  cmp -s "$expected_stdin" "$prefix.stdin"
  grep -Fxq "TERM=$expected_term" "$prefix.env"
  [ ! -e "$marker" ]

  case "$flavor" in
    bsd)
      [ ! -e "$prefix.command" ]
      ;;
    util-linux)
      [ -s "$prefix.command" ]
      if grep -Fq -- "$hostile_label" "$prefix.command"; then
        printf 'hostile label was embedded in the PTY command\n' >&2
        return 1
      fi
      ;;
  esac
}

if "$ROOT/tests/pane_dash_pty.sh" >"$tmp/no-arguments.stdout" 2>"$tmp/no-arguments.stderr"; then
  printf 'direct PTY helper accepted an empty command\n' >&2
  exit 1
fi
grep -Fq "usage:" "$tmp/no-arguments.stderr"

run_case bsd '' xterm source
run_case bsd dumb xterm source
run_case util-linux '' xterm cli
run_case util-linux dumb xterm cli
run_case util-linux screen-256color screen-256color cli

process_prefix="$tmp/process-group"
printf '%s\0' "$hostile_arg1" "$hostile_arg2" "$hostile_arg3" "$hostile_arg4" "$hostile_arg5" > "$process_prefix.expected-argv"
printf '%s' "$hostile_label" > "$process_prefix.expected-stdin"
printf '%s' "$hostile_label" | \
  FAKE_SCRIPT_FLAVOR=bsd PTY_RECORD_PREFIX="$process_prefix" TERM='' PD_SCRIPT_BIN="$tmp/script" \
  python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    "$ROOT/tests/pane_dash_pty.sh" "$hostile_executable" \
    "$hostile_arg1" "$hostile_arg2" "$hostile_arg3" "$hostile_arg4" "$hostile_arg5" &
process_launcher_pid=$!
wait "$process_launcher_pid"
cmp -s "$process_prefix.expected-argv" "$process_prefix.argv"
cmp -s "$process_prefix.expected-stdin" "$process_prefix.stdin"
[[ "$(<"$process_prefix.pgid")" == "$process_launcher_pid" ]]
[ ! -e "$marker" ]
