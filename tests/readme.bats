#!/usr/bin/env bats

setup() {
  README="$BATS_TEST_DIRNAME/../README.md"
}

require_text() {
  if ! grep -Fiq -- "$1" "$README"; then
    printf 'missing README contract text: %s\n' "$1" >&3
    return 1
  fi
}

@test "requirements distinguish the Rust dashboard from legacy dependencies" {
  require_text 'tmux | >=3.6'
  require_text 'Rust + Cargo | toolchain supporting Rust edition 2024'
  require_text 'make + standard `install` utility'
  require_text '| fzf | >=0.73.0 |'
  require_text 'Explicit legacy engine or missing-binary fallback only'
  require_text '| OpenCode | optional |'
  require_text 'Companion status producer only'
  require_text 'does not require fzf'
}

@test "installation and migration document source packaging and the exact fallback policy" {
  for text in \
    'make build' \
    'make install' \
    'make uninstall' \
    'DESTDIR' \
    'PREFIX' \
    'does not compile on load' \
    'Plugin-local `bin/pane-dash` wins over PATH' \
    'run-shell' \
    'reload' \
    'Rust-first' \
    'set -g @pane-dash-engine rust' \
    'set -g @pane-dash-engine fzf' \
    "pane-dash: Rust binary not found; using legacy fzf (run 'make build' in the plugin directory or 'make install')" \
    'supported through v2.x' \
    'removed no earlier than v3.0' \
    'legacy scripts stay present and tested until removal'; do
    require_text "$text"
  done
}

@test "key reference covers current reducer navigation filtering and modal behavior" {
  for text in \
    '<prefix> D' '<prefix> T' '<prefix> M' \
    '`j` / `k`, `Down` / `Up`' '`g` / `G`' '`h` / `l`, `z a`' \
    '`/`' '`Enter`' '`Ctrl-z`' '`Ctrl-s`' '`Ctrl-u` / `Ctrl-d`' '`Ctrl-r`' \
    '`n`' '`x`' '`s`' '`?`' '`q` / `Esc`' \
    'Printable unmodified/Shift text edits the query' \
    'Send | text/`Backspace`; `Enter` sends a nonempty line' \
    'Kill | `y`/`Y` confirms' \
    'Create choice | `j`/`k` or arrows' \
    'Create form | text/`Backspace`; `Tab`/Down next field' \
    'Locked create submission | `q`/`Esc` closes the popup' \
    'Help | `?`, `Esc`, or unmodified `q` closes help'; do
    require_text "$text"
  done
}

@test "options configuration status behavior troubleshooting and local verification are authoritative" {
  for text in \
    '@pane-dash-key' '@pane-dash-tag-key' '@pane-dash-label-key' \
    '`@pane-dash-width` | `90%`' '`@pane-dash-height` | `85%`' \
    '@pane-dash-match' '@pane-dash-stale-secs' '@pane-dash-new-command' \
    '@pane-dash-theme' '`@pane-dash-engine` | absent = Rust-first' '@pane_dash_group' \
    '$XDG_CONFIG_HOME/tmux-pane-dash/config.toml' '$HOME/.config/tmux-pane-dash/config.toml' \
    'limited to 1024 bytes' 'dark`, `light`, and `terminal-native' \
    'text, dim, accent, needs_input, working, idle, error, unknown, stale,' \
    'warning, degrade, border, status_bar, selection_fg, selection_bg' \
    '`#RRGGBB`' '`ansi:0` through `ansi:255`' \
    'tmux `@pane-dash-theme` base, then TOML `theme` replacement, then per-slot overrides' \
    'Config is read once per popup' 'reject the whole file' 'each invalid color retains only that slot' \
    'capped at four rows' \
    'grouped is default' 'live filter is retained' 'Inspect pauses only preview capture' \
    'live updates lost — polling' 'context-aware create' 'sends text literally followed by Enter' \
    'requires y/Y confirmation' 'vanished panes become a silent no-op' 'Partial post-create failures are surfaced' \
    'PATH inherited by the tmux server' 'install fzf >=0.73.0' 'upgrade to >=3.6' \
    'make clean && make build' 'bats tests/*.bats' \
    'shellcheck pane_dash.tmux scripts/*.sh tests/*.sh' \
    'cargo fmt --manifest-path pane-dash/Cargo.toml -- --check' \
    'cargo clippy --manifest-path pane-dash/Cargo.toml --all-targets -- -D warnings' \
    'cargo test --manifest-path pane-dash/Cargo.toml' \
    'cargo test --manifest-path pane-dash/Cargo.toml -- --ignored --nocapture --test-threads=1' \
    '(cd opencode-plugin && bun test)' 'tests/rust_live_integration.sh' \
    'Network, CI, and release automation are out of Phase 7'; do
    require_text "$text"
  done

  for pair in '● needs_input' '◐ working' '○ idle' '✗ error' '? unknown' '⊘ stale'; do
    require_text "$pair"
  done
}

@test "README rejects obsolete v1 dashboard documentation" {
  ! grep -Ei 'tmux.*3\.2' "$README"
  ! grep -Fq '✖' "$README"
  ! grep -Eiq 'stale.*~|~.*stale' "$README"
  ! grep -Eiq 'fzf.*(required|requirement).*always|fzf.*universally required' "$README"
  ! grep -Eq '@pane-dash-(width|height).*(`)?(80%|70%)' "$README"
  ! grep -Fq '@pane-dash-preview-layout' "$README"
  ! grep -Fq '@pane-dash-preview-threshold' "$README"
  ! grep -Fq '@pane-dash-preview-alt-layout' "$README"
  ! grep -Fq -- '--recheck' "$README"
  ! grep -Fq 'v1.1 roadmap' "$README"
  ! grep -Fq "open_v2"'.sh' "$README"
}
