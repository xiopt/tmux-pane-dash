#!/usr/bin/env bats

setup() {
  README="$BATS_TEST_DIRNAME/../README.md"
}

require_row() {
  local file=$1 row=$2
  grep -Fxq -- "$row" "$file"
}

require_text() {
  if ! grep -Fq -- "$2" "$1"; then
    printf 'missing README contract text: %s\n' "$2" >&3
    return 1
  fi
}

section() {
  local file=$1 heading=$2
  awk -v heading="## $heading" '
    $0 == heading { found = 1; next }
    found && /^## / { exit }
    found { print }
  ' "$file"
}

check_requirements() {
  local file=$1 rows
  rows="$(section "$file" Requirements)"
  printf '%s\n' "$rows" | grep -Fxq '| tmux | >=3.6 | Dashboard runtime |' || return
  printf '%s\n' "$rows" | grep -Fxq '| Node.js | >=20 | `npx` commands only |' || return
  printf '%s\n' "$rows" | grep -Fxq '| Rust + Cargo | Rust edition 2024 toolchain | TPM and manual source builds |' || return
  printf '%s\n' "$rows" | grep -Fxq '| make + standard `install` utility | Available locally | TPM and manual source builds |' || return
  printf '%s\n' "$rows" | grep -Fxq '| OpenCode | optional | Companion status producer only |'
}

check_legacy_drift() {
  local file=$1 requirements options status obsolete
  requirements="$(section "$file" Requirements)"
  options="$(section "$file" 'tmux options')"
  status="$(section "$file" 'Status legend')"

  ! grep -Eiq '^\| tmux \| .*3\.2' <<<"$requirements" || return
  ! grep -Eq '^\| `⊘ stale` \|.*~' <<<"$status" || return
  ! grep -Fq '✖' "$file" || return
  ! grep -Eq '^\| `@pane-dash-(width|height)` \| `(80%|70%)`' <<<"$options" || return
  ! grep -Fq 'docs/' "$file" || return

  for obsolete in \
    '@pane-dash-preview-layout' \
    '@pane-dash-preview-threshold' \
    '@pane-dash-preview-alt-layout' \
    '--recheck' \
    'open_v2.sh'; do
    ! grep -Fq -- "$obsolete" "$file" || return
  done
  ! grep -Fiq 'release distribution' "$file"
  ! grep -Fiq 'v1.1 roadmap' "$file"
}

check_options() {
  local file=$1
  for row in \
    '| `@pane-dash-key` | `D` | Dashboard prefix binding |' \
    '| `@pane-dash-tag-key` | `T` | Tag-toggle prefix binding |' \
    '| `@pane-dash-label-key` | `M` | Typed-label prefix binding |' \
    '| `@pane-dash-width` | `90%` | Popup width; empty uses default |' \
    '| `@pane-dash-height` | `85%` | Popup height; empty uses default |' \
    '| `@pane-dash-match` | `opencode` | Command match for auto-discovery; explicit empty disables command matching |' \
    '| `@pane-dash-stale-secs` | `60` | Positive heartbeat staleness threshold; invalid or nonpositive uses default |' \
    '| `@pane-dash-new-command` | `opencode` | Initial command for new panes; explicit empty creates a plain pane and sends no Enter |' \
    '| `@pane-dash-theme` | `dark` | `dark`, `light`, or `terminal-native`; invalid or empty warns and uses dark before TOML |' \
    '| `@pane_dash_group` | `1` | `1` grouped, `0` flat; shared server state updated by `s` |'; do
    require_row "$file" "$row" || return
  done
}

check_status() {
  local file=$1
  for row in \
    '| `● needs_input` | Waiting for permission or a question response |' \
    '| `◐ working` | Busy or retrying |' \
    '| `○ idle` | Known idle |' \
    '| `✗ error` | Agent error latched until work or user activity clears it |' \
    '| `? unknown` | No companion-plugin status available |' \
    '| `⊘ stale` | Companion heartbeat exceeded `@pane-dash-stale-secs` |'; do
    require_row "$file" "$row" || return
  done
}

check_keys() {
  local file=$1
  for row in \
    '| `<prefix> D` | Open dashboard |' \
    '| `<prefix> T` | Toggle manual tag using the current command as label |' \
    '| `<prefix> M` | Prompt for and set a manual label |' \
    '| `j` / `k`, `Down` / `Up` | Move down/up |' \
    '| `g` / `G` | First/last visible row |' \
    '| `h` / `l`, `z a` | Collapse/expand or toggle selected session in grouped mode |' \
    '| `/` | Enter live filter mode |' \
    '| `Enter` | Jump to selected session or pane |' \
    '| `Ctrl-z` | Zoom selected pane, then jump |' \
    '| `Ctrl-s` | Open literal send-line modal for selected pane |' \
    '| `Ctrl-u` / `Ctrl-d` | Inspect preview half-page up/down; pause preview capture only |' \
    '| `Ctrl-r` | Return preview to bottom and resume capture |' \
    '| `n` | Open context-aware create modal |' \
    '| `x` | Open pane-kill confirmation |' \
    '| `s` | Toggle grouped/flat mode and update shared `@pane_dash_group` |' \
    '| `?` | Open help |' \
    '| `q` / `Esc` | Close dashboard in navigation mode |' \
    '| Send | text/`Backspace`; `Enter` sends a nonempty line (empty closes with no send); `Esc` cancels; `?` is inert |' \
    '| Kill | `y`/`Y` confirms; any other key cancels except inert `?` |' \
    '| Create choice | `j`/`k` or arrows; `Enter` chooses; `Esc` cancels; `?` is inert |' \
    '| Create form | text/`Backspace`; `Tab`/Down next field; `Shift-Tab`/Up previous; `Enter` submits; `Esc` cancels; `?` is inert |' \
    '| Locked create submission | `q`/`Esc` closes the popup; all other keys are inert |' \
    '| Help | `j`/`k` and unmodified arrows scroll one line; `Ctrl-u`/`Ctrl-d` scroll half a page; unmodified `PageUp`/`PageDown` scroll a page; `g`/`G` jump to top/bottom; `?`, `Esc`, or unmodified `q` closes help |'; do
    require_row "$file" "$row" || return
  done
  require_text "$file" 'Printable unmodified/Shift text edits the query; `Backspace` deletes one Unicode scalar; `Esc` returns to navigation and retains the query. `?` is query text, not help.'
}

check_cli_commands() {
  local file=$1
  for command in \
    'npx @xiopt/tmux-pane-dash@latest setup' \
    'npx @xiopt/tmux-pane-dash@latest update' \
    'npx @xiopt/tmux-pane-dash@latest doctor' \
    'npx @xiopt/tmux-pane-dash@latest doctor --json' \
    'npx @xiopt/tmux-pane-dash@latest uninstall' \
    '--no-tmux' \
    '--no-opencode' \
    '--migrate' \
    '--allow-downgrade'; do
    require_text "$file" "$command" || return
  done
  ! grep -Fq 'docs/' "$file"
}

check_config() {
  local file=$1
  for text in \
    '$XDG_CONFIG_HOME/tmux-pane-dash/config.toml' \
    '$HOME/.config/tmux-pane-dash/config.toml' \
    'limited to 1024 bytes' \
    'The root is a flat TOML table.' \
    'Built-in themes are exact lowercase `dark`, `light`, and `terminal-native`.' \
    'canonical lowercase ANSI names' \
    '`reset`, `black`' \
    '`white`' \
    '`#RRGGBB` with exactly six hexadecimal digits' \
    '`ansi:0` through `ansi:255`' \
    'pane-dash intentionally does not paint a terminal background. The `light` theme expects a light terminal background. On a dark terminal background, use `dark` or `terminal-native`; selecting `light` may make dark foreground text appear blank or low contrast.' \
    'tmux `@pane-dash-theme` base, then TOML `theme` replacement, then per-slot overrides.' \
    'Config is read once per popup; reopen to reload it.' \
    'reject the whole file' \
    'each invalid color retains only that slot' \
    'capped at four rows'; do
    require_text "$file" "$text" || return
  done
  require_text "$file" 'text, dim, accent, needs_input, working, idle, error, unknown, stale,' || return
  require_text "$file" 'warning, degrade, border, status_bar, selection_fg, selection_bg' || return
}

replace_once() {
  local file=$1 old=$2 new=$3
  python3 - "$file" "$old" "$new" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
old, new = sys.argv[2:]
text = path.read_text()
assert old in text
path.write_text(text.replace(old, new, 1))
PY
}

@test "requirements table has normalized dependency contracts" {
  check_requirements "$README"
}

@test "installation names the unconfigured-remote placeholder and executable local workflows" {
  for text in \
    "set -g @plugin 'xiopt/tmux-pane-dash'" \
    '<prefix> I' '<prefix> U' '$HOME/.tmux/plugins/tmux-pane-dash' \
    'git clone https://github.com/xiopt/tmux-pane-dash.git "$HOME/.tmux/plugins/tmux-pane-dash"' \
    'cd "$HOME/.tmux/plugins/tmux-pane-dash"' \
    'run-shell "$HOME/.tmux/plugins/tmux-pane-dash/pane_dash.tmux"' \
    'tmux source-file "$HOME/.tmux.conf"'; do
    require_text "$README" "$text" || return
  done
  ! grep -Fq 'OWNER/tmux-pane-dash' "$README"
  ! grep -Fq '<repository-url>' "$README"
}

@test "OpenCode companion status plugin setup and removal are actionable" {
  for text in \
      '@xiopt/pane-dash-opencode@0.1.5' \
    '--no-opencode' \
    'OpenCode >=1.17.20' \
    'mkdir -p "$HOME/.config/opencode/plugin"' \
    'ln -sf "$PWD/opencode-plugin/pane-dash.ts" "$HOME/.config/opencode/plugin/pane-dash.ts"' \
    'Restart or reopen the OpenCode process' \
    'rm "$HOME/.config/opencode/plugin/pane-dash.ts"' \
    'Without the plugin, command-matched panes remain visible with `? unknown` status.'; do
    require_text "$README" "$text" || return
  done
}

@test "CLI commands and flags are documented exactly" {
  check_cli_commands "$README"
}

@test "option status and key tables pair every current contract" {
  check_options "$README"
  check_status "$README"
  check_keys "$README"
}

@test "config policy includes exact contracts" {
  check_config "$README"
}

@test "installation safety guidance is actionable" {
  for text in \
    'only files recorded as owned by this package' \
    'does not remove unrelated tmux or OpenCode settings' \
    'stops before any mutation' \
    '`--migrate` only for a recognized legacy ownership route'; do
    require_text "$README" "$text" || return
  done
}

@test "obsolete support claims are rejected only in their authoritative tables" {
  local requirements options status
  requirements="$(section "$README" Requirements)"
  options="$(section "$README" 'tmux options')"
  status="$(section "$README" 'Status legend')"

  ! grep -Eiq '^\| tmux \| .*3\.2' <<<"$requirements"
  ! grep -Eq '^\| `⊘ stale` \|.*~' <<<"$status"
  ! grep -Fq '✖' "$README"
  ! grep -Eq '^\| `@pane-dash-(width|height)` \| `(80%|70%)`' <<<"$options"
  ! grep -Fq 'youruser' "$README"
}

@test "legacy fixed-string drift guard rejects obsolete documentation and permits unrelated requirement prose" {
  check_legacy_drift "$README"

  local fixture="$BATS_TEST_TMPDIR/README.md"
  cp "$README" "$fixture"
  printf '\nOpenCode is not required.\n' >> "$fixture"
  check_legacy_drift "$fixture"
}

@test "legacy drift guard rejects every injected obsolete string" {
  local fixture="$BATS_TEST_TMPDIR/README.md" label obsolete
  while IFS='|' read -r label obsolete; do
    cp "$README" "$fixture"
    printf '\n%s\n' "$obsolete" >> "$fixture"
    ! check_legacy_drift "$fixture"
  done <<'CASES'
preview layout|@pane-dash-preview-layout
preview threshold|@pane-dash-preview-threshold
alternate preview layout|@pane-dash-preview-alt-layout
legacy recheck flag|--recheck
old launcher|open_v2.sh
old roadmap|V1.1 ROADMAP
CASES
}

@test "contract checkers fail after a default action status or timeline mutation" {
  local mutated="$BATS_TEST_TMPDIR/README.md"
  cp "$README" "$mutated"
  replace_once "$mutated" '`90%`' '`80%`'
  ! check_options "$mutated"

  cp "$README" "$mutated"
  replace_once "$mutated" 'Open dashboard' 'Open legacy dashboard'
  ! check_keys "$mutated"

  cp "$README" "$mutated"
  replace_once "$mutated" '`⊘ stale`' '`~ stale`'
  ! check_status "$mutated"

  cp "$README" "$mutated"
  cp "$README" "$mutated"
  replace_once "$mutated" 'pane-dash intentionally does not paint a terminal background. The `light` theme expects a light terminal background. On a dark terminal background, use `dark` or `terminal-native`; selecting `light` may make dark foreground text appear blank or low contrast.' ''
  ! check_config "$mutated" 3>/dev/null
}

run_bounded() {
  "$@" &
  local pid=$! deadline=$((SECONDS + 2))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 0.05
  done
  wait "$pid"
}

run_in_pty() {
  exec python3 -c '
import os
import pty
import select
import signal
import subprocess
import sys

master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, preexec_fn=os.setsid)
os.close(slave)

def terminate(signum, _frame):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
try:
    while child.poll() is None:
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                os.read(master, 4096)
            except OSError:
                pass
finally:
    os.close(master)

raise SystemExit(child.wait())
' "$@"
}

wait_for_attached_client() {
  local socket=$1 deadline=$((SECONDS + 2))
  while ! command tmux -f /dev/null -S "$socket" list-clients -F '#{client_tty}' 2>/dev/null | grep -q .; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.05
  done
}

run_readme_hook_example() {
  local config=$1 root socket hook_file binding attached status=0
  root="$(mktemp -d /tmp/pane-dash-readme-hook.XXXXXX)"
  socket="$root/tmux.sock"
  hook_file="$root/after-new-window.conf"
  binding="$root/prefix-c"
  printf '%s\n' "$config" >"$hook_file"

  scratch_tmux() { command tmux -f /dev/null -S "$socket" "$@"; }

  run_bounded scratch_tmux new-session -d -s base 'exec cat' || status=$?
  if [ "$status" -eq 0 ]; then
    run_bounded scratch_tmux source-file "$hook_file" || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    run_bounded scratch_tmux show-hooks -g >"$root/hooks" || status=$?
    ! grep -Eq '^after-new-window\[[0-9]+\][[:space:]]' "$root/hooks" || status=1
  fi
  if [ "$status" -eq 0 ]; then
    run_bounded scratch_tmux list-keys -T prefix >"$binding" || status=$?
    grep -Fq 'new-window' "$binding" && grep -Fq 'command-prompt' "$binding" || status=1
  fi
  if [ "$status" -eq 0 ]; then
    run_in_pty env TMUX= TERM=xterm tmux -f /dev/null -S "$socket" attach-session -t base >/dev/null 2>&1 &
    attached=$!
    wait_for_attached_client "$socket" || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    run_bounded run_in_pty env TMUX= tmux -f /dev/null -S "$socket" new-window -d -P -F '#{pane_id}' -t base >/dev/null || status=$?
  fi

  [ -z "${attached:-}" ] || kill "$attached" 2>/dev/null || true
  run_bounded scratch_tmux set-hook -gu after-new-window >/dev/null 2>&1 || true
  run_bounded scratch_tmux kill-server >/dev/null 2>&1 || true
  rm -rf "$root"
  return "$status"
}

run_old_client_tty_fixture() {
  local root socket hook_file attached status=0
  root="$(mktemp -d /tmp/pane-dash-readme-unsafe-hook.XXXXXX)"
  socket="$root/tmux.sock"
  hook_file="$root/after-new-window.conf"
  cat >"$hook_file" <<'EOF'
set-hook -g after-new-window 'if-shell -F "#{client_tty}" "command-prompt -I \"#{window_name}\" \"rename-window %%\""'
EOF

  scratch_tmux() { command tmux -f /dev/null -S "$socket" "$@"; }
  run_bounded scratch_tmux new-session -d -s base 'exec cat' || status=$?
  if [ "$status" -eq 0 ]; then
    run_bounded scratch_tmux source-file "$hook_file" || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    run_in_pty env TMUX= TERM=xterm tmux -f /dev/null -S "$socket" attach-session -t base >/dev/null 2>&1 &
    attached=$!
    wait_for_attached_client "$socket" || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    if run_bounded run_in_pty env TMUX= tmux -f /dev/null -S "$socket" new-window -d -P -F '#{pane_id}' -t base >/dev/null; then
      status=1
    else
      [ "$?" -eq 124 ] || status=1
    fi
  fi

  [ -z "${attached:-}" ] || kill "$attached" 2>/dev/null || true
  run_bounded scratch_tmux kill-server >/dev/null 2>&1 || true
  rm -rf "$root"
  return "$status"
}

@test "README manual prompt binding is exact, prompt-free for automation, and rejects client predicates" {
  local examples="$BATS_TEST_TMPDIR/readme-after-new-window-guidance"
  local expected="$BATS_TEST_TMPDIR/expected-after-new-window-guidance"

  cat >"$expected" <<'EOF'
set-hook -gu after-new-window
bind-key c new-window \; command-prompt -I "#{window_name}" "rename-window %%"
EOF
  awk '/^set-hook -gu after-new-window$|^bind-key c new-window \\; command-prompt -I "#\{window_name\}" "rename-window %%"$/ { print }' "$README" >"$examples"
  diff -u "$expected" "$examples"

  run_readme_hook_example "$(cat "$examples")"
  run_old_client_tty_fixture
}
