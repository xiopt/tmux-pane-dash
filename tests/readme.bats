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
  printf '%s\n' "$rows" | grep -Fxq '| tmux | >=3.6 | Always; v2 wire-format support floor |' || return
  printf '%s\n' "$rows" | grep -Fxq '| Rust + Cargo | toolchain supporting Rust edition 2024 | Source build only |' || return
  printf '%s\n' "$rows" | grep -Fxq '| make + standard `install` utility | Available locally | Source packaging |' || return
  printf '%s\n' "$rows" | grep -Fxq '| fzf | >=0.73.0 | Explicit legacy engine or missing-binary fallback only |' || return
  printf '%s\n' "$rows" | grep -Fxq '| OpenCode | optional | Companion status producer only |'
}

check_legacy_drift() {
  local file=$1 requirements options status fzf_row obsolete
  fzf_row='| fzf | >=0.73.0 | Explicit legacy engine or missing-binary fallback only |'
  requirements="$(section "$file" Requirements)"
  options="$(section "$file" 'tmux options')"
  status="$(section "$file" 'Status legend')"

  [ "$(printf '%s\n' "$requirements" | grep -Fxc -- "$fzf_row")" -eq 1 ] || return
  [ "$(printf '%s\n' "$requirements" | grep -Ec '^\| fzf \|')" -eq 1 ] || return
  ! grep -Eiq '^\| tmux \| .*3\.2' <<<"$requirements" || return
  ! grep -Eq '^\| `⊘ stale` \|.*~' <<<"$status" || return
  ! grep -Fq '✖' "$file" || return
  ! grep -Eq '^\| `@pane-dash-(width|height)` \| `(80%|70%)`' <<<"$options" || return

  for obsolete in \
    '@pane-dash-preview-layout' \
    '@pane-dash-preview-threshold' \
    '@pane-dash-preview-alt-layout' \
    '--recheck' \
    'open_v2.sh'; do
    ! grep -Fq -- "$obsolete" "$file" || return
  done
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
    '| `@pane-dash-engine` | absent = Rust-first | `rust`, deprecated `fzf`, or absent; explicit empty is invalid |' \
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
    '| Help | `?`, `Esc`, or unmodified `q` closes help; all other keys are inert |'; do
    require_row "$file" "$row" || return
  done
  require_text "$file" 'Printable unmodified/Shift text edits the query; `Backspace` deletes one Unicode scalar; `Esc` returns to navigation and retains the query. `?` is query text, not help.'
}

check_engine_policy() {
  local file=$1 policy
  for text in \
    'With no `@pane-dash-engine` option, the plugin is Rust-first.' \
    '`set -g @pane-dash-engine rust` is valid but unnecessary.' \
    '`set -g @pane-dash-engine fzf` explicitly selects the legacy dashboard even if a Rust binary exists.' \
    'An explicitly empty engine option is invalid, not absent.' \
    "pane-dash: Rust binary not found; using legacy fzf (run 'make build' in the plugin directory or 'make install')" \
    'pane-dash: @pane-dash-engine fzf is deprecated; supported through v2.x, removed no earlier than v3.0' \
    'pane-dash: invalid @pane-dash-engine value; using Rust-first resolution' \
    'fzf is deprecated in v2 but supported through v2.x and removed no earlier than v3.0.' \
    'The legacy scripts stay present and tested until removal.'; do
    require_text "$file" "$text" || return
  done
  policy="$(section "$file" 'Engine migration and compatibility')"
  ! grep -Eiq 'removed (in|during|before) v2' <<<"$policy" || return
  ! grep -Eiq 'Rust dashboard.*requires fzf|fzf.*required.*Rust dashboard' <<<"$policy" || return
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
    "set -g @plugin 'OWNER/tmux-pane-dash'" \
    'this checkout has no configured canonical remote' \
    'substitute the owner from the published repository URL before TPM use' \
    '<prefix> I' '<prefix> U' '$HOME/.tmux/plugins/tmux-pane-dash' \
    'git clone <repository-url> "$HOME/.tmux/plugins/tmux-pane-dash"' \
    'Replace `<repository-url>` with the published repository URL' \
    'cd "$HOME/.tmux/plugins/tmux-pane-dash"' \
    'run-shell "$HOME/.tmux/plugins/tmux-pane-dash/pane_dash.tmux"' \
    'tmux source-file "$HOME/.tmux.conf"'; do
    require_text "$README" "$text" || return
  done
  ! grep -Fq 'youruser' "$README"
}

@test "OpenCode companion status plugin setup and removal are actionable" {
  for text in \
    'mkdir -p "$HOME/.config/opencode/plugin"' \
    'ln -sf "$PWD/opencode-plugin/pane-dash.ts" "$HOME/.config/opencode/plugin/pane-dash.ts"' \
    'Restart or reopen the OpenCode process' \
    'rm "$HOME/.config/opencode/plugin/pane-dash.ts"' \
    'Without the plugin, command-matched panes remain visible with `? unknown` status.'; do
    require_text "$README" "$text" || return
  done
}

@test "option status and key tables pair every current contract" {
  check_options "$README"
  check_status "$README"
  check_keys "$README"
}

@test "engine and config policies include exact contracts" {
  check_engine_policy "$README"
  check_config "$README"
}

@test "local verification includes the quoting integration gate" {
  require_text "$README" 'tests/rust_engine_quoting_integration.sh'
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
  replace_once "$mutated" 'removed no earlier than v3.0' 'removed in v2.1'
  ! check_engine_policy "$mutated" 3>/dev/null
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

run_readme_hook_example() {
  local hook_line=$1 root socket hook_file status=0
  root="$(mktemp -d "$BATS_TEST_TMPDIR/readme-hook.XXXXXX")"
  socket="$root/tmux.sock"
  hook_file="$root/after-new-window.conf"
  printf '%s\n' "$hook_line" >"$hook_file"

  scratch_tmux() { command tmux -f /dev/null -S "$socket" "$@"; }

  run_bounded scratch_tmux new-session -d -s base 'exec cat' || status=$?
  if [ "$status" -eq 0 ]; then
    run_bounded scratch_tmux source-file "$hook_file" || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    run_bounded scratch_tmux new-window -d -P -F '#{pane_id}' -t base >/dev/null || status=$?
  fi

  run_bounded scratch_tmux set-hook -gu after-new-window >/dev/null 2>&1 || true
  run_bounded scratch_tmux kill-server >/dev/null 2>&1 || true
  rm -rf "$root"
  return "$status"
}

@test "README client-aware after-new-window hook examples are exact and prompt-free" {
  local examples="$BATS_TEST_TMPDIR/readme-after-new-window-hooks"
  local expected="$BATS_TEST_TMPDIR/expected-after-new-window-hooks"
  local hook_line

  cat >"$expected" <<'EOF'
set-hook -g after-new-window 'if-shell -F "#{client_tty}" "command-prompt -I \"#{window_name}\" \"rename-window %%\""'
set-hook -g after-new-window "if-shell -F '#{!=:#{client_tty},}' 'command-prompt -I \"#{window_name}\" \"rename-window %%\"'"
EOF
  awk '/^set-hook -g after-new-window / { print }' "$README" >"$examples"
  diff -u "$expected" "$examples"

  while IFS= read -r hook_line; do
    run_readme_hook_example "$hook_line"
  done <"$examples"
}
