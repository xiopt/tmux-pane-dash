#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'public-smoke: %s\n' "$*" >&2; exit 1; }

case "${NODE_20_BIN:-}:${NPM_20_CLI:-}" in
  /*:/*) ;;
  *) fail 'NODE_20_BIN and NPM_20_CLI must be absolute wrapper-exported paths' ;;
esac
[ -x "$NODE_20_BIN" ] || fail 'NODE_20_BIN is not executable'
[ -f "$NPM_20_CLI" ] || fail 'NPM_20_CLI is not a file'
[ "$($NODE_20_BIN --version 2>/dev/null)" = 'v20.0.0' ] || fail 'NODE_20_BIN must be exact Node v20.0.0'
for credential in GH_TOKEN GITHUB_TOKEN NPM_TOKEN NODE_AUTH_TOKEN; do
  [ -z "${!credential:-}" ] || fail "credential environment is forbidden: $credential"
done

active=0
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ "$active" -ne 0 ]; then
    kill -TERM -- "-$active" 2>/dev/null || true
    wait "$active" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

run_bounded() {
  local package=$1 command=$2
  shift 2
  set -m
  (exec "$NODE_20_BIN" "$NPM_20_CLI" exec --yes --ignore-scripts --no-audit --no-fund --package "$package" -- tmux-pane-dash "$command" "$@") &
  active=$!
  set +m
  local elapsed=0 limit=${PANE_DASH_PUBLIC_SMOKE_TIMEOUT_SECONDS:-60}
  [[ "$limit" =~ ^[1-9][0-9]*$ ]] || fail 'invalid child timeout'
  while kill -0 "$active" 2>/dev/null; do
    [ "$elapsed" -lt "$limit" ] || { kill -TERM "$active" 2>/dev/null || true; fail "child timed out: $package $command"; }
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$active" || fail "child failed: $package $command"
  active=0
}

run_bounded '@xiopt/tmux-pane-dash@0.1.1' setup
run_bounded '@xiopt/tmux-pane-dash@0.1.1' doctor
run_bounded '@xiopt/tmux-pane-dash@0.1.1' setup
run_bounded '@xiopt/tmux-pane-dash@latest' update
run_bounded '@xiopt/tmux-pane-dash@0.1.1' uninstall
printf '%s\n' 'ordered=setup,doctor,reuse,latest-update,uninstall bounded=PASS credentials=absent public-network-requests=0 public-smoke: PASS'
