# tmux-pane-dash v2

tmux-pane-dash is a tmux popup dashboard for OpenCode sessions and manually tagged panes. It provides live status, grouped or flat views, filtering, pane preview, safe pane actions, and context-aware creation.

> **Screenshot placeholder:** dashboard screenshot coming soon.

## Requirements

| Dependency | Requirement | Scope |
| --- | --- | --- |
| tmux | >=3.6 | Always; v2 wire-format support floor |
| Rust + Cargo | toolchain supporting Rust edition 2024 | Source build only |
| make + standard `install` utility | Available locally | Source packaging |
| fzf | >=0.73.0 | Explicit legacy engine or missing-binary fallback only |
| OpenCode | optional | Companion status producer only |

Rust 1.85+ is the edition-2024 language floor. The Rust dashboard itself does not require fzf. OpenCode is only needed to produce companion status; command-matched panes still appear without it as `? unknown`.

## Install, update, and remove

### TPM

Add the plugin to `~/.tmux.conf`, then install or update it with TPM:

```tmux
set -g @plugin 'youruser/tmux-pane-dash'
```

From TPM's cloned plugin directory, build the Rust dashboard:

```sh
make build
```

TPM loading does not compile on load. `make install` is an optional alternative and also runs the build. Plugin-local `bin/pane-dash` wins over PATH, so `make build` is the most direct way to make TPM use the Rust dashboard.

### Manual or source clone

Clone or unpack the source, build it, then add its absolute path to tmux:

```sh
git clone https://github.com/youruser/tmux-pane-dash.git ~/src/tmux-pane-dash
cd ~/src/tmux-pane-dash
make build
```

```tmux
run-shell '~/src/tmux-pane-dash/pane_dash.tmux'
```

Reload tmux after changing the entry:

```sh
tmux source-file ~/.tmux.conf
```

### Optional PATH install

`make install` builds first and installs `pane-dash` to `$HOME/.local/bin` by default:

```sh
make install
make install PREFIX=/usr/local
make install DESTDIR=/tmp/package PREFIX=/usr/local
```

PATH installation installs only the binary, not the tmux scripts: the source or TPM clone remains the plugin entry point. Ensure `$HOME/.local/bin` is in the PATH inherited by the tmux server; reloading a shell alone may not change an already-running server's environment. A plugin-local build avoids that dependency.

### Update and remove

After a TPM update, source pull, or source replacement, rerun `make build` (or `make install`) and reload `pane_dash.tmux` or your tmux configuration. There is no automatic update, freshness check, or build on plugin load.

Use the command that matches what you want to remove:

```sh
make uninstall                 # installed binary for the configured PREFIX/BINDIR/DESTDIR
make clean                     # local Cargo output and bin/pane-dash
```

Remove the TPM or manual `run-shell` entry separately. `make uninstall` does not remove plugin-local `bin/pane-dash`, because `make install` depends on `make build`.

## Engine migration and compatibility

With no `@pane-dash-engine` option, the plugin is Rust-first. `set -g @pane-dash-engine rust` is valid but unnecessary. `set -g @pane-dash-engine fzf` explicitly selects the legacy dashboard even if a Rust binary exists. An explicitly empty engine option is invalid, not absent.

Rust-first checks the plugin-local binary first, then PATH. If neither is available, it displays this actionable fallback and opens the legacy dashboard:

```text
pane-dash: Rust binary not found; using legacy fzf (run 'make build' in the plugin directory or 'make install')
```

Explicit legacy mode displays:

```text
pane-dash: @pane-dash-engine fzf is deprecated; supported through v2.x, removed no earlier than v3.0
```

An invalid engine value displays:

```text
pane-dash: invalid @pane-dash-engine value; using Rust-first resolution
```

fzf is deprecated in v2 but supported through v2.x and removed no earlier than v3.0. The legacy scripts stay present and tested until removal. fzf >=0.73.0 is needed only for explicit legacy mode or missing-binary fallback; a resolved Rust dashboard has no fzf runtime dependency.

## Keys

### tmux bindings

| Default | Action |
| --- | --- |
| `<prefix> D` | Open dashboard |
| `<prefix> T` | Toggle manual tag using the current command as label |
| `<prefix> M` | Prompt for and set a manual label |

### Navigation and dashboard

| Key | Action |
| --- | --- |
| `j` / `k`, `Down` / `Up` | Move down/up |
| `g` / `G` | First/last visible row |
| `h` / `l`, `z a` | Collapse/expand or toggle selected session in grouped mode |
| `/` | Enter live filter mode |
| `Enter` | Jump to selected session or pane |
| `Ctrl-z` | Zoom selected pane, then jump |
| `Ctrl-s` | Open literal send-line modal for selected pane |
| `Ctrl-u` / `Ctrl-d` | Inspect preview half-page up/down; pause preview capture only |
| `Ctrl-r` | Return preview to bottom and resume capture |
| `n` | Open context-aware create modal |
| `x` | Open pane-kill confirmation |
| `s` | Toggle grouped/flat mode and update shared `@pane_dash_group` |
| `?` | Open help |
| `q` / `Esc` | Close dashboard in navigation mode |

### Filter and preview

Printable unmodified/Shift text edits the query; `Backspace` deletes one Unicode scalar; `Esc` returns to navigation and retains the query. `?` is query text, not help. Preview controls and `Ctrl-s` retain their reducer-defined availability while filtering; navigation, grouping, creation, kill, and jump keys do not act as dashboard actions while filtering.

`Ctrl-u` and `Ctrl-d` enter inspect mode. Inspect pauses only preview capture, not topology or status snapshots. `Ctrl-r` resumes bottom-following preview capture.

### Modals

| Modal | Keys |
| --- | --- |
| Send | text/`Backspace`; `Enter` sends a nonempty line (empty closes with no send); `Esc` cancels; `?` is inert |
| Kill | `y`/`Y` confirms; any other key cancels except inert `?` |
| Create choice | `j`/`k` or arrows; `Enter` chooses; `Esc` cancels; `?` is inert |
| Create form | text/`Backspace`; `Tab`/Down next field; `Shift-Tab`/Up previous; `Enter` submits; `Esc` cancels; `?` is inert |
| Locked create submission | `q`/`Esc` closes the popup; all other keys are inert |
| Help | `?`, `Esc`, or unmodified `q` closes help; all other keys are inert |

## tmux options

Set options before loading or reloading `pane_dash.tmux`. Options are read at popup startup except the live shared group state. Key and engine options take effect when `pane_dash.tmux` is reloaded; width and height are read by the launcher on each open.

| Option | Default | Contract |
| --- | --- | --- |
| `@pane-dash-key` | `D` | Dashboard prefix binding |
| `@pane-dash-tag-key` | `T` | Tag-toggle prefix binding |
| `@pane-dash-label-key` | `M` | Typed-label prefix binding |
| `@pane-dash-width` | `90%` | Popup width; empty uses default |
| `@pane-dash-height` | `85%` | Popup height; empty uses default |
| `@pane-dash-match` | `opencode` | Command match for auto-discovery; explicit empty disables command matching |
| `@pane-dash-stale-secs` | `60` | Positive heartbeat staleness threshold; invalid or nonpositive uses default |
| `@pane-dash-new-command` | `opencode` | Initial command for new panes; explicit empty creates a plain pane and sends no Enter |
| `@pane-dash-theme` | `dark` | `dark`, `light`, or `terminal-native`; invalid or empty warns and uses dark before TOML |
| `@pane-dash-engine` | absent = Rust-first | `rust`, deprecated `fzf`, or absent; explicit empty is invalid |
| `@pane_dash_group` | `1` | `1` grouped, `0` flat; shared server state updated by `s` |

## Dashboard behavior and safety

- **Discovery and status:** a pane option, command match, or manual tag admits a pane. Labels fall back through title, tag, and current command. OpenCode status is optional.
- **Grouped and flat views:** grouped is default and headers collapse locally. Flat mode is status-sorted. A live filter is retained and temporarily exposes matches inside collapsed sessions.
- **Degraded updates:** `live updates lost — polling` means the control channel is unavailable and bounded fallback polling is active. The dashboard is degraded, not frozen.
- **Creation:** a session header offers window or session; a pane offers four split directions, window, or session; an empty dashboard offers session. The name is optional, cwd is the child working directory, and an empty command creates a plain pane without sending Enter. Partial post-create failures are surfaced, and a new pane remains reconciled when present.
- **Send safety:** sending is pane-only, shows the target and current command, and sends text literally followed by Enter. It never interprets the text as a tmux or shell command. Verify manually tagged targets because literal input still affects the running program.
- **Kill and navigation:** kill is pane-only and requires y/Y confirmation; vanished panes become a silent no-op. Session rows jump sessions, while pane rows target the exact pane. Zoom then jump handles vanishing targets.

## Status legend

| Glyph/status | Meaning |
| --- | --- |
| `● needs_input` | Waiting for permission or a question response |
| `◐ working` | Busy or retrying |
| `○ idle` | Known idle |
| `✗ error` | Agent error latched until work or user activity clears it |
| `? unknown` | No companion-plugin status available |
| `⊘ stale` | Companion heartbeat exceeded `@pane-dash-stale-secs` |

## TOML configuration

At popup startup, the dashboard selects one config path:

1. A nonempty `$XDG_CONFIG_HOME/tmux-pane-dash/config.toml`;
2. Otherwise a nonempty `$HOME/.config/tmux-pane-dash/config.toml`;
3. Otherwise no file and no warning.

The selected path does not fall back when missing. It must be a regular file (a symlink to one is allowed), is limited to 1024 bytes, and Config is read once per popup; reopen to reload it.

The root is a flat TOML table. Recognized optional string keys are `theme` and these fifteen palette slots:

```text
text, dim, accent, needs_input, working, idle, error, unknown, stale,
warning, degrade, border, status_bar, selection_fg, selection_bg
```

Built-in themes are exact lowercase `dark`, `light`, and `terminal-native`. Colors accept canonical lowercase ANSI names (`reset`, `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `gray`, `dark_gray`, `light_red`, `light_green`, `light_yellow`, `light_blue`, `light_magenta`, `light_cyan`, `white`), `#RRGGBB` with exactly six hexadecimal digits, or `ansi:0` through `ansi:255`.

Precedence is tmux `@pane-dash-theme` base, then TOML `theme` replacement, then per-slot overrides. Arrays, nested tables, malformed files, oversized files, and unreadable files reject the whole file. In a structurally valid file, an unknown theme retains the prior base, each invalid color retains only that slot's prior value, and valid siblings still apply. Unknown flat scalar keys are forward-compatible; a near-known-key typo warns. Warnings are sanitized, deterministic, visible, deduplicated, and capped at four rows (three concrete warnings plus a suppression summary).

```toml
theme = "dark"
accent = "#7aa2f7"
working = "ansi:220"
selection_fg = "black"
selection_bg = "light_cyan"
```

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Rust fallback notice | Run `make build` in the plugin directory or `make install`, then reload the plugin. |
| PATH install not found | Inspect the PATH inherited by the tmux server, or use a plugin-local build. Restarting or reloading a shell alone may not update server environment. |
| Explicit legacy notice | Remove the engine option to migrate; if keeping legacy, install fzf >=0.73.0. |
| Unsupported tmux | Upgrade to >=3.6. |
| Config warning | Correct the displayed path, key, or value, then reopen the popup. |
| Stale status | Verify the optional OpenCode plugin/process and heartbeat, or adjust the positive stale threshold. |
| Unexpected behavior after update | Rebuild the source binary and reload the plugin; there is no auto-build. |
| Wrong client or pane | Collect the tmux version and reproduce with the real routing test; do not rediscover a "best" client. |

## Local verification

Run local checks in dependency order:

```sh
make clean && make build
bats tests/readme.bats
bats tests/*.bats
shellcheck pane_dash.tmux scripts/*.sh tests/*.sh
cargo fmt --manifest-path pane-dash/Cargo.toml -- --check
cargo clippy --manifest-path pane-dash/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path pane-dash/Cargo.toml
cargo test --manifest-path pane-dash/Cargo.toml -- --ignored --nocapture --test-threads=1
(cd opencode-plugin && bun test)
tests/integration.sh
tests/pane_dash_integration.sh
tests/rust_engine_integration.sh
tests/rust_live_integration.sh
```

Some checks require installed tmux, fzf, Bats, Bun, or ShellCheck. Network, CI, and release automation are out of Phase 7.
