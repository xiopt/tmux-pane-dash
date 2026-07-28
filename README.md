# tmux-pane-dash

`tmux-pane-dash` is a Rust dashboard for navigating OpenCode sessions and
manually tagged tmux panes. It opens in a tmux popup, shows live status, and
keeps pane actions literal and target-specific. OpenCode status is optional;
the dashboard remains useful for tagged panes without it.

The first public release is `0.1.0`. GitHub Releases are the immutable binary
channel and the npm CLI is the supported installer. The source and TPM channel
is available when you want to build locally.

## Requirements

| Dependency | Requirement | Used for |
| --- | --- | --- |
| tmux | >=3.6 | Always; v2 wire-format support floor |
| Rust + Cargo | toolchain supporting Rust edition 2024 | Source build only |
| make + standard `install` utility | Available locally | Source packaging |
| OpenCode | optional | Companion status producer only |

Requires tmux >=3.6. Rust and Cargo are needed only for source and TPM builds.
No Homebrew formula or platform-specific npm package is part of `0.1.0`.

## Choose a distribution channel

| Channel | Use it when | What owns the installation |
| --- | --- | --- |
| npm CLI | You want a verified release for the current platform | `@xiopt/tmux-pane-dash` owns its XDG data root and managed configuration |
| Source or TPM | You want to build from a checkout | Your checkout, `make`, and the tmux entry own the local build |
| OpenCode package | You want companion status in OpenCode | `@xiopt/pane-dash-opencode` is the exact plugin entry |

Do not combine a source-built checkout with an npm-managed `current` link unless
you deliberately manage the two installations separately. Each channel has
one owner; neither channel rewrites the other channel's files.

## Install with the npm CLI

The CLI is a Node `>=20` ESM package with no install-time filesystem mutation.
It downloads only the exact immutable release selected by its package version,
verifies the archive hash and size, checks the binary version, and then commits
the installation atomically.

npm resolves `@latest` to an immutable CLI package version; the CLI version
derives and accepts only the matching GitHub tag `v<same-version>` for its
release assets. It performs no GitHub latest-release lookup and never mixes
package, CLI, or release versions.

### First install

The default installs both tmux and OpenCode integration:

```sh
npx @xiopt/tmux-pane-dash@latest setup
```

Use these setup flags when one integration should be omitted or an existing
owned installation needs migration:

```sh
npx @xiopt/tmux-pane-dash@latest setup --no-tmux
npx @xiopt/tmux-pane-dash@latest setup --no-opencode
npx @xiopt/tmux-pane-dash@latest setup --migrate
```

`setup --allow-downgrade` is only for deliberately invoking an older package
version. A normal update never moves the installation backwards:

```sh
npx @xiopt/tmux-pane-dash@0.1.0 setup --allow-downgrade
```

### Update, inspect, and remove

Run the latest package explicitly for update and maintenance operations:

```sh
npx @xiopt/tmux-pane-dash@latest update
npx @xiopt/tmux-pane-dash@latest doctor
npx @xiopt/tmux-pane-dash@latest doctor --json
npx @xiopt/tmux-pane-dash@latest uninstall
```

`doctor` is read-only and offline. It reports the installed version, target,
hash, binary version, tmux version, managed configuration, and ownership. The
uninstall command removes only files recorded as owned by this package; it
does not remove an unrelated tmux setting, OpenCode setting, or user TOML.

## Source and TPM installation

The source channel builds the Rust binary in the checkout. It performs no
network operation on tmux startup and does not build or update when the popup
opens.

There is no automatic build, no automatic update, and no package-manager
operation at tmux startup.

### TPM

Add the public repository to `~/.tmux.conf`, then install it through TPM:

```tmux
set -g @plugin 'xiopt/tmux-pane-dash'
```

For an unconfigured checkout, the equivalent template is:

```tmux
set -g @plugin 'OWNER/tmux-pane-dash'
```

this checkout has no configured canonical remote; substitute the owner from the published repository URL before TPM use. Press `<prefix> I` to install and
`<prefix> U` to update the plugin.

Run `<prefix> I`, then build from the checkout TPM selected:

```sh
cd "$HOME/.tmux/plugins/tmux-pane-dash"
make build
```

After `<prefix> U`, run `make build` again. TPM loads the committed tmux
entrypoint; it does not compile on load.

### Manual source checkout

```sh
git clone https://github.com/xiopt/tmux-pane-dash.git "$HOME/.tmux/plugins/tmux-pane-dash"
git clone <repository-url> "$HOME/.tmux/plugins/tmux-pane-dash"
Replace `<repository-url>` with the published repository URL before cloning.
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

`make install` is an optional PATH installation of only `pane-dash`; it does
not install the tmux entrypoint or edit configuration:

```sh
make install
make install PREFIX=/usr/local
make install DESTDIR=/tmp/package PREFIX=/usr/local
```

The default destination is `$HOME/.local/bin/pane-dash`. `make uninstall`
removes that binary for the selected `PREFIX`, `BINDIR`, and `DESTDIR`.
`make clean` removes local Cargo output and `bin/pane-dash`.

## OpenCode integration

The npm setup command adds the exact package entry
`@xiopt/pane-dash-opencode@0.1.0` to the selected global OpenCode config. It
does not edit a project-local OpenCode file. Use `--no-opencode` if the
companion producer is not wanted.

There are no project-local OpenCode configuration edits.

When configuring the package manually, use the global OpenCode configuration
directory, not a project checkout:

```text
@xiopt/pane-dash-opencode@0.1.0
```

For a local checkout, install the companion entry explicitly:

```sh
mkdir -p "$HOME/.config/opencode/plugin"
ln -sf "$PWD/opencode-plugin/pane-dash.ts" "$HOME/.config/opencode/plugin/pane-dash.ts"
```

Restart or reopen the OpenCode process after changing the plugin. Remove it
with:

```sh
rm "$HOME/.config/opencode/plugin/pane-dash.ts"
```

Without the plugin, command-matched panes remain visible with `? unknown` status.

If the companion is absent, command-matched panes remain visible with
`? unknown`. The package requires OpenCode `>=1.17.20`, has no runtime
dependencies, and exports the same bundled module from `.` and `./server`.

## Managed filesystem and ownership

The CLI uses `XDG_DATA_HOME` when it is set, otherwise
`$HOME/.local/share/tmux-pane-dash`:

```text
<data-home>/tmux-pane-dash/
├── current -> versions/0.1.0
├── versions/0.1.0/
├── state/ownership.json
└── transactions/
```

A new version is staged and hashed before `current` changes. The previous
version remains available until the transaction and configuration updates
complete. The lock and journal make interrupted operations recoverable.

Setup backs up and atomically updates the managed block in `~/.tmux.conf` (or
the selected configuration path) and updates the global OpenCode JSON/JSONC
file while preserving unrelated text. Same-directory replacement preserves
file modes. Symlinked dotfiles are resolved and recorded; a true configuration
ambiguity or an unowned conflicting entry stops before any mutation. Use
`--migrate` only for the documented, recognized legacy ownership routes.

The CLI is per-user. tmux startup performs no network access, automatic build,
automatic update, or package-manager operation. There is no startup network.
`doctor` performs no write and does not contact a release service.

## tmux options

| Option | Default | Meaning |
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

| Key | Action |
| --- | --- |
| `<prefix> D` | Open dashboard |
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

## Configuration policy

Configuration is read from `$XDG_CONFIG_HOME/tmux-pane-dash/config.toml`, or
`$HOME/.config/tmux-pane-dash/config.toml` when the XDG variable is absent. The
file is limited to 1024 bytes. The root is a flat TOML table. Built-in themes are exact lowercase `dark`, `light`, and `terminal-native`. Colors use canonical lowercase ANSI names such as `reset`, `black`, and `white`, `#RRGGBB` with exactly six hexadecimal digits, or `ansi:0` through `ansi:255`. Invalid files
reject the whole file; each invalid color retains only that slot. Warnings are
capped at four rows. tmux `@pane-dash-theme` base, then TOML `theme` replacement, then per-slot overrides. Config is read once per popup; reopen to reload it.
Color slots are text, dim, accent, needs_input, working, idle, error, unknown, stale,
warning, degrade, border, status_bar, selection_fg, selection_bg.

pane-dash intentionally does not paint a terminal background. The `light` theme expects a light terminal background. On a dark terminal background, use `dark` or `terminal-native`; selecting `light` may make dark foreground text appear blank or low contrast.

## Release assets and verification

The `0.1.0` release has exactly four platform archives:

| Target | Asset |
| --- | --- |
| macOS arm64 | `tmux-pane-dash-v0.1.0-aarch64-apple-darwin.tar.gz` |
| macOS x64 | `tmux-pane-dash-v0.1.0-x86_64-apple-darwin.tar.gz` |
| Linux arm64 | `tmux-pane-dash-v0.1.0-aarch64-unknown-linux-musl.tar.gz` |
| Linux x64 | `tmux-pane-dash-v0.1.0-x86_64-unknown-linux-musl.tar.gz` |

The immutable asset URL prefix is:

```text
https://github.com/xiopt/tmux-pane-dash/releases/download/v0.1.0/
```

Each archive has a SHA-256 entry in `SHA256SUMS`, target/version metadata, and
GitHub artifact attestations. The release manifest, checksums, and all four
archives are attested. Both npm packages publish with npm provenance. Release
verification compares names, URLs, hashes, sizes, archive inventories, and
attestation subjects before a channel is promoted.

Local verification includes:

```sh
tests/rust_engine_quoting_integration.sh
```

If a personal tmux configuration needs an automatic window label, use this
manual, prompt-free binding. It deliberately does not inspect a client
predicate:

```tmux
set-hook -gu after-new-window
bind-key c new-window \; command-prompt -I "#{window_name}" "rename-window %%"
```

For the release operation matrix, publisher provenance, and rollback procedure,
see [Release distribution](docs/release-distribution.md).

## Dashboard controls

The default tmux bindings are:

| Binding | Action |
| --- | --- |
| `<prefix> D` | Open the dashboard |
| `<prefix> T` | Toggle a tag using the current command |
| `<prefix> M` | Prompt for a tag label |

Inside the dashboard, `j`/`k` or arrows navigate, `Enter` jumps to the selected
session or pane, `/` filters, `?` opens help, `x` confirms a pane kill, `n`
starts context-aware pane creation, and `q` closes the popup. Sending text is
literal and is followed by Enter only after confirmation; it is never treated
as a shell or tmux command.

Useful options include `@pane-dash-key`, `@pane-dash-tag-key`,
`@pane-dash-label-key`, `@pane-dash-width`, `@pane-dash-height`,
`@pane-dash-match`, `@pane-dash-stale-secs`, `@pane-dash-new-command`,
`@pane-dash-theme`, and `@pane_dash_group`. Run `doctor` for installation
state; run `make help` for source build variables.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Binary is unavailable | Run `make build` in the source/TPM checkout and reload `pane_dash.tmux`. |
| Popup uses an old binary | Check `current` with `doctor`, then run `npx @xiopt/tmux-pane-dash@latest update`. |
| OpenCode status is unknown | Check the global OpenCode package entry and reopen OpenCode. |
| Setup reports a conflict | Inspect the ownership and configuration paths; use `--migrate` only for a recognized legacy entry. |
| tmux is unsupported | Upgrade tmux to `3.6` or newer. |
| A transaction was interrupted | Run `doctor`, then rerun the same `setup`, `update`, or `uninstall` command after reviewing the report. |

## License

Released under the [MIT License](LICENSE), Copyright (c) 2026 xiopt.
