setup() {
  export TMUX_STUB_DIR="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$TMUX_STUB_DIR/global"
  : > "$TMUX_STUB_DIR/calls.log"
  : > "$TMUX_STUB_DIR/invocations.log"
  export PATH="$BATS_TEST_DIRNAME/stubs:$PATH"
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  SCRIPT="$ROOT/pane_dash.tmux"
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

assert_call_contains() {
  grep -Fq -- "$1" "$TMUX_STUB_DIR/calls.log"
}

assert_no_engine_query() {
  ! grep -Fq -- '@pane-dash-engine' "$TMUX_STUB_DIR/invocations.log"
}

@test "binds the local Rust binary with direct client session and pane identities" {
  copy_root="$BATS_TEST_TMPDIR/plugin"
  mkdir -p "$copy_root/bin" "$copy_root/scripts"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  cp "$ROOT/scripts/open.sh" "$ROOT/scripts/tag.sh" "$copy_root/scripts/"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$copy_root/bin/pane-dash"
  chmod +x "$copy_root/bin/pane-dash"

  run "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_call_contains "$(shell_quote "$copy_root/scripts/open.sh") $(shell_quote "$copy_root/bin/pane-dash") '#{client_tty}' '#{session_id}' '#{pane_id}'"
  assert_no_engine_query
}

@test "uses only the logical local binary path and never PATH" {
  copy_root="$BATS_TEST_TMPDIR/plugin"
  path_root="$BATS_TEST_TMPDIR/path"
  mkdir -p "$copy_root/scripts" "$path_root"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  cp "$ROOT/scripts/open.sh" "$ROOT/scripts/tag.sh" "$copy_root/scripts/"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$path_root/pane-dash"
  chmod +x "$path_root/pane-dash"

  run env PATH="$BATS_TEST_DIRNAME/stubs:$path_root:$PATH" "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  grep -Fqx "display-message$(printf '\037')pane-dash: Rust binary unavailable; run 'make build' in the tmux-pane-dash directory$(printf '\037')" "$TMUX_STUB_DIR/notifications.log"
  ! grep -Fq -- "$path_root/pane-dash" "$TMUX_STUB_DIR/calls.log"
  assert_no_engine_query
}

@test "has no legacy fallback, engine lookup, or startup build activity" {
  ! grep -Fq -- '@pane-dash-engine' "$SCRIPT"
  ! grep -Fq -- 'fzf' "$SCRIPT"
  ! grep -Fq -- 'type -P' "$SCRIPT"
  ! grep -Fq -- 'PATH' "$SCRIPT"
  ! grep -Eq -- '\<(npm|bun|cargo|curl|wget|download|update)\>' "$SCRIPT"
  [ "$(grep -Fc -- 'make build' "$SCRIPT")" -eq 1 ]
}

@test "rejects missing nonregular and nonexecutable local binaries" {
  for kind in missing directory nonexecutable; do
    copy_root="$BATS_TEST_TMPDIR/$kind"
    mkdir -p "$copy_root/scripts"
    cp "$SCRIPT" "$copy_root/pane_dash.tmux"
    cp "$ROOT/scripts/open.sh" "$ROOT/scripts/tag.sh" "$copy_root/scripts/"
    case "$kind" in
      directory) mkdir -p "$copy_root/bin/pane-dash" ;;
      nonexecutable) mkdir -p "$copy_root/bin"; printf x > "$copy_root/bin/pane-dash" ;;
    esac
    : > "$TMUX_STUB_DIR/notifications.log"
    run "$copy_root/pane_dash.tmux"
    [ "$status" -eq 0 ]
    grep -Fqx "display-message$(printf '\037')pane-dash: Rust binary unavailable; run 'make build' in the tmux-pane-dash directory$(printf '\037')" "$TMUX_STUB_DIR/notifications.log"
    ! grep -Fq -- "$copy_root/scripts/open.sh" "$TMUX_STUB_DIR/calls.log"
  done
}

@test "keeps the current symlink logical in its dashboard binding" {
  install_root="$BATS_TEST_TMPDIR/install"
  version_root="$install_root/versions/0.1.0"
  mkdir -p "$version_root/bin" "$version_root/scripts"
  cp "$SCRIPT" "$version_root/pane_dash.tmux"
  cp "$ROOT/scripts/open.sh" "$ROOT/scripts/tag.sh" "$version_root/scripts/"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$version_root/bin/pane-dash"
  chmod +x "$version_root/bin/pane-dash"
  ln -s versions/0.1.0 "$install_root/current"

  run "$install_root/current/pane_dash.tmux"

  [ "$status" -eq 0 ]
  assert_call_contains "$install_root/current/scripts/open.sh"
  assert_call_contains "$install_root/current/bin/pane-dash"
}

@test "preserves focus hooks options and tag label bindings" {
  copy_root="$BATS_TEST_TMPDIR/plugin"
  mkdir -p "$copy_root/bin" "$copy_root/scripts"
  cp "$SCRIPT" "$copy_root/pane_dash.tmux"
  cp "$ROOT/scripts/open.sh" "$ROOT/scripts/tag.sh" "$copy_root/scripts/"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$copy_root/bin/pane-dash"
  chmod +x "$copy_root/bin/pane-dash"

  run "$copy_root/pane_dash.tmux"

  [ "$status" -eq 0 ]
  grep -Fq 'set-hook' "$TMUX_STUB_DIR/calls.log"
  grep -Fq 'focus-events' "$TMUX_STUB_DIR/calls.log"
  grep -Fq "scripts/tag.sh" "$TMUX_STUB_DIR/calls.log"
  grep -Fq 'command-prompt' "$TMUX_STUB_DIR/calls.log"
}

@test "open preserves exact popup argv" {
  run "$ROOT/scripts/open.sh" /tmp/pane-dash /dev/ttys001 '$3' '%42'

  [ "$status" -eq 0 ]
  grep -Fqx "display-popup$(printf '\037')-E$(printf '\037')-c$(printf '\037')/dev/ttys001$(printf '\037')-t$(printf '\037')%42$(printf '\037')-w$(printf '\037')90%$(printf '\037')-h$(printf '\037')85%$(printf '\037')/tmp/pane-dash$(printf '\037')/dev/ttys001$(printf '\037')\$3$(printf '\037')%42$(printf '\037')" "$TMUX_STUB_DIR/calls.log"
}
