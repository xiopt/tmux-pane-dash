# tmux-pane-dash

`tmux-pane-dash` is a Rust dashboard for navigating OpenCode sessions and
manually tagged tmux panes. It opens in a tmux popup, shows live status, and
keeps pane actions literal and target-specific. OpenCode status is optional;
the dashboard is still useful for tagged panes without it.

## Requirements

| Dependency | Requirement | Used for |
| --- | --- | --- |
| tmux | >=3.6 | Dashboard runtime |
| Node.js | >=20 | `npx` commands only |
| Rust + Cargo | Rust edition 2024 toolchain | TPM and manual source builds |
| make + standard `install` utility | Available locally | TPM and manual source builds |
| OpenCode | optional | Companion status producer only |

Node.js is not needed for TPM or manual source builds. OpenCode is only needed
for companion status; the dashboard itself does not require it.

The current npm installer supports macOS arm64 only. TPM and manual builds are
still available on other supported tmux platforms.

## Install with npx

The npm CLI installs and manages the dashboard for the current user. The setup
command enables both the tmux dashboard and OpenCode integration by default:

```sh
npx @xiopt/tmux-pane-dash@latest setup
```

Use these setup options when one integration should be omitted or an existing
owned installation needs migration:

```sh
npx @xiopt/tmux-pane-dash@latest setup --no-tmux
npx @xiopt/tmux-pane-dash@latest setup --no-opencode
npx @xiopt/tmux-pane-dash@latest setup --migrate
```

`--allow-downgrade` is for deliberately invoking an older package version:

```sh
npx @xiopt/tmux-pane-dash@0.1.2 setup --allow-downgrade
```

Use the latest package explicitly for routine maintenance:

```sh
npx @xiopt/tmux-pane-dash@latest update
npx @xiopt/tmux-pane-dash@latest doctor
npx @xiopt/tmux-pane-dash@latest doctor --json
npx @xiopt/tmux-pane-dash@latest uninstall
```

`doctor` is read-only. `uninstall` removes only files recorded as owned by this package. It does not remove unrelated tmux or OpenCode settings or your TOML file. A conflicting or unowned entry stops before any mutation; use `--migrate` only for a recognized legacy ownership route.

The CLI keeps its per-user installation data under
`${XDG_DATA_HOME:-$HOME/.local/share}/tmux-pane-dash/`. The `current` link,
version directories, ownership record, and transaction state are managed there.

## TPM and manual source builds

TPM users can add the public repository to `~/.tmux.conf`:

```tmux
set -g @plugin 'xiopt/tmux-pane-dash'
```

Press `<prefix> I` to install and `<prefix> U` to update the plugin. TPM loads
the committed tmux entrypoint; it does not compile the Rust binary. Build after
installing or updating:

```sh
cd "$HOME/.tmux/plugins/tmux-pane-dash"
make build
```

For a manual checkout:

```sh
git clone https://github.com/xiopt/tmux-pane-dash.git "$HOME/.tmux/plugins/tmux-pane-dash"
cd "$HOME/.tmux/plugins/tmux-pane-dash"
make build
```

Load the entrypoint and reload tmux after changing the checkout:

```tmux
run-shell "$HOME/.tmux/plugins/tmux-pane-dash/pane_dash.tmux"
```

```sh
tmux source-file "$HOME/.tmux.conf"
```

`make install` optionally installs only `pane-dash` on `PATH`; it does not
install the tmux entrypoint or edit configuration:

```sh
make install
make install PREFIX=/usr/local
make install DESTDIR=/tmp/package PREFIX=/usr/local
```

The default destination is `$HOME/.local/bin/pane-dash`. `make uninstall`
removes that binary for the selected `PREFIX`, `BINDIR`, and `DESTDIR`. `make clean`
removes local Cargo output and `bin/pane-dash`.

There is no automatic build or update when the tmux popup opens, and tmux
startup does not run a package-manager operation or access the network.

## OpenCode integration

OpenCode integration is optional. The npm setup command adds the exact package
entry `@xiopt/pane-dash-opencode@0.1.7` to the selected global OpenCode config;
use `--no-opencode` to skip it. The companion package requires OpenCode >=1.17.20.
It does not edit a project-local OpenCode configuration file.

For a local checkout, install the companion entry explicitly:

```sh
mkdir -p "$HOME/.config/opencode/plugin"
ln -sf "$PWD/opencode-plugin/pane-dash.ts" "$HOME/.config/opencode/plugin/pane-dash.ts"
```

Restart or reopen the OpenCode process after changing the plugin. Remove the
local entry with:

```sh
rm "$HOME/.config/opencode/plugin/pane-dash.ts"
```

Without the plugin, command-matched panes remain visible with `? unknown` status.

## tmux notifications

Notifications are tmux-native and volatile for the tmux server/service lifetime;
they do not depend on Ghostty or macOS. When the entrypoint is loaded, pane-dash
owns the second status row (`status 2`, `status-format[1]`) and preserves row
zero. It also installs the root `MouseDown1Status` binding for notification
clicks. Load-order matters: a later custom second-row format or root mouse
binding overrides pane-dash's display or clicks, so reload the entrypoint after
those customizations when pane-dash should own them.

The row keeps one visible persistent notification and shows `+N more` for the
rest. Clicking the visible item dismisses it and routes to its pane; clicking
`+N more` opens the notification list. Ordering is deterministic and shared by
tmux clients: error > permission > question > finished, then oldest first.
Notifications from the focused origin are suppressed, and queued items for
exited panes are removed.

With the companion plugin installed, OpenCode automatically produces all four
notification kinds. Other producers can publish directly:

```sh
pane-dash notify publish --event-id <id> --kind <error|permission|question|finished> --message <text> [--pane <%id>]
```

The queue capacity is 64 notifications; outcomes `queued`, `duplicate`, and
`suppressed` exit zero.

`--pane` defaults to `TMUX_PANE`. A missing notification service or a full
queue returns a nonzero status. If the second row is missing, check that
`bin/pane-dash` is built and executable, then reload `pane_dash.tmux`; if the
service or binary is unavailable, run `make build` in the checkout and reload
the entrypoint.

## tmux options

| Option | Default | Meaning |
| --- | --- | --- |
| `@pane-dash-key` | `Tab` | Dashboard prefix binding |
| `@pane-dash-tag-key` | `T` | Tag-toggle prefix binding |
| `@pane-dash-label-key` | `M` | Typed-label prefix binding |
| `@pane-dash-notifications-key` | `j` | Notification-list prefix binding |
| `@pane-dash-width` | `90%` | Popup width; empty uses default |
| `@pane-dash-height` | `85%` | Popup height; empty uses default |
| `@pane-dash-match` | `opencode` | Command match for auto-discovery; explicit empty disables command matching |
| `@pane-dash-stale-secs` | `60` | Positive heartbeat staleness threshold; invalid or nonpositive uses default |
| `@pane-dash-new-command` | `opencode` | Initial command for new panes; explicit empty creates a plain pane and sends no Enter |
| `@pane-dash-theme` | `dark` | `dark`, `light`, or `terminal-native`; invalid or empty warns and uses dark before TOML |
| `@pane_dash_group` | `1` | `1` grouped, `0` flat; shared server state updated by `s` |

## Status legend

| Status | Meaning |
| --- | --- |
| `● needs_input` | Waiting for permission or a question response |
| `◐ working` | Busy or retrying |
| `○ idle` | Known idle |
| `✗ error` | Agent error latched until work or user activity clears it |
| `? unknown` | No companion-plugin status available |
| `⊘ stale` | Companion heartbeat exceeded `@pane-dash-stale-secs` |

## Dashboard keys

The default tmux bindings are `<prefix> Tab` for the dashboard, `<prefix> j` for
notifications, `<prefix> T` for a manual tag using the current command, and
`<prefix> M` for a prompted label.

| Key | Action |
| --- | --- |
| `<prefix> Tab` | Open dashboard |
| `<prefix> j` | Open notifications |
| `<prefix> T` | Toggle manual tag using the current command as label |
| `<prefix> M` | Prompt for and set a manual label |
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
| Send | text/`Backspace`; `Enter` sends a nonempty line (empty closes with no send); `Esc` cancels; `?` is inert |
| Kill | `y`/`Y` confirms; any other key cancels except inert `?` |
| Create choice | `j`/`k` or arrows; `Enter` chooses; `Esc` cancels; `?` is inert |
| Create form | text/`Backspace`; `Tab`/Down next field; `Shift-Tab`/Up previous; `Enter` submits; `Esc` cancels; `?` is inert |
| Locked create submission | `q`/`Esc` closes the popup; all other keys are inert |
| Help | `j`/`k` and unmodified arrows scroll one line; `Ctrl-u`/`Ctrl-d` scroll half a page; unmodified `PageUp`/`PageDown` scroll a page; `g`/`G` jump to top/bottom; `?`, `Esc`, or unmodified `q` closes help |

Printable unmodified/Shift text edits the query; `Backspace` deletes one Unicode scalar; `Esc` returns to navigation and retains the query. `?` is query text, not help.

## Configuration and safety

Configuration is read from `$XDG_CONFIG_HOME/tmux-pane-dash/config.toml`, or
`$HOME/.config/tmux-pane-dash/config.toml` when the XDG variable is absent. The
file is limited to 1024 bytes. The root is a flat TOML table. Built-in themes are exact lowercase `dark`, `light`, and `terminal-native`. Colors use
canonical lowercase ANSI names such as `reset`, `black`, and `white`,
`#RRGGBB` with exactly six hexadecimal digits, or `ansi:0` through `ansi:255`.

Invalid files reject the whole file; each invalid color retains only that slot.
Warnings are capped at four rows. tmux `@pane-dash-theme` base, then TOML `theme` replacement, then per-slot overrides. Config is read once per popup; reopen to reload it.

Color slots are text, dim, accent, needs_input, working, idle, error, unknown, stale,
warning, degrade, border, status_bar, selection_fg, selection_bg.

pane-dash intentionally does not paint a terminal background. The `light` theme expects a light terminal background. On a dark terminal background, use `dark` or `terminal-native`; selecting `light` may make dark foreground text appear blank or low contrast.

Actions are target-specific. Text entered in the send modal is sent literally
to the selected pane and is not treated as a shell or tmux command.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Binary is unavailable | Run `make build` in the source or TPM checkout and reload `pane_dash.tmux`. |
| Popup uses an old binary | Run `npx @xiopt/tmux-pane-dash@latest update`, or run `make build` for a source checkout. |
| OpenCode status is unknown | Check the global OpenCode package entry and reopen OpenCode. |
| Setup reports a conflict | Inspect the ownership and configuration paths; use `--migrate` only for a recognized legacy entry. |
| tmux is unsupported | Upgrade tmux to `3.6` or newer. |
| A transaction was interrupted | Run `doctor`, then rerun the same `setup`, `update`, or `uninstall` command after reviewing the report. |
| The light theme has poor contrast | Use `dark` or `terminal-native`, or use a light terminal background. |

## Optional window labels

If a personal tmux configuration needs an automatic window label, use this
prompt-free binding:

```tmux
set-hook -gu after-new-window
bind-key c new-window \; command-prompt -I "#{window_name}" "rename-window %%"
```

## License

Released under the [MIT License](LICENSE), Copyright (c) 2026 xiopt.
