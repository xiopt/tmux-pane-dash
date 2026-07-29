#!/usr/bin/env bats

setup() {
  repo_root="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd -P)"
  root="$BATS_TEST_TMPDIR/smoke"
  mkdir -p "$root/bin"
  log="$root/calls"
  : > "$log"
  cat > "$root/bin/node" <<'SH'
#!/bin/sh
printf 'node %s\n' "$*" >> "$SMOKE_LOG"
if [ "${1:-}" = "--version" ]; then printf 'v20.0.0\n'; exit 0; fi
npm_cli=$1
shift
exec "$npm_cli" "$@"
SH
  cat > "$root/bin/npm" <<'SH'
#!/bin/sh
printf 'npm %s\n' "$*" >> "$SMOKE_LOG"
case "$*" in
  *@xiopt/tmux-pane-dash@0.1.1*setup*|*@xiopt/tmux-pane-dash@0.1.1*doctor*|*@xiopt/tmux-pane-dash@0.1.1*uninstall*|*@xiopt/tmux-pane-dash@latest*update*) exit 0 ;;
  *) exit 64 ;;
esac
SH
  chmod 755 "$root/bin/node" "$root/bin/npm"
  export SMOKE_LOG="$log" NODE_20_BIN="$root/bin/node" NPM_20_CLI="$root/bin/npm"
}

@test "public smoke runs exact ordered setup doctor reuse latest update uninstall" {
  run "$repo_root/scripts/release/public-smoke.sh"
  [ "$status" -eq 0 ]
  [ "$(grep -c '^npm ' "$log")" -eq 5 ]
  mapfile -t calls < <(grep '^npm ' "$log")
  [[ "${calls[0]}" == *@xiopt/tmux-pane-dash@0.1.1*"-- tmux-pane-dash setup"* ]]
  [[ "${calls[1]}" == *@xiopt/tmux-pane-dash@0.1.1*"-- tmux-pane-dash doctor"* ]]
  [[ "${calls[2]}" == *@xiopt/tmux-pane-dash@0.1.1*"-- tmux-pane-dash setup"* ]]
  [[ "${calls[3]}" == *@xiopt/tmux-pane-dash@latest*"-- tmux-pane-dash update"* ]]
  [[ "${calls[4]}" == *@xiopt/tmux-pane-dash@0.1.1*"-- tmux-pane-dash uninstall"* ]]
}

@test "public smoke requires exact wrapper-exported Node 20" {
  printf '#!/bin/sh\nprintf "v18.0.0\\n"\n' > "$root/bin/node"
  chmod 755 "$root/bin/node"
  run "$repo_root/scripts/release/public-smoke.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"v20.0.0"* ]]
}
