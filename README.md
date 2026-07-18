# tmux-pane-dash

tmux-pane-dash is a tmux popup dashboard for OpenCode sessions (and panes you tag yourself): see live agent status, preview a pane, then jump, zoom, or send a one-shot command without hunting through windows.

> **Screenshot placeholder:** dashboard screenshot coming soon.

## Requirements

| Dependency | Minimum version | Why |
| --- | --- | --- |
| tmux | 3.2 | Popup dashboard support |
| fzf | 0.73.0 | Dashboard filtering, stable reloads, and live refresh |
| OpenCode | 1.17.20 | Required only for the companion status plugin; this is the minimum tested version |

## Install

### tmux plugin

With [TPM](https://github.com/tmux-plugins/tpm), add this to `~/.tmux.conf` and press `<prefix> I`:

```tmux
set -g @plugin 'youruser/tmux-pane-dash'
```

For a manual or local installation, add the following instead, then reload tmux with `tmux source-file ~/.tmux.conf`:

```tmux
run-shell ~/path/to/tmux-pane-dash/pane_dash.tmux
```

### OpenCode status plugin (optional)

Install the companion plugin from the repository root:

```bash
ln -sf "$PWD/opencode-plugin/pane-dash.ts" ~/.config/opencode/plugin/pane-dash.ts
```

The tmux plugin works without this plugin: panes whose running command matches
`opencode` still appear, but their status is `unknown`.

## Keys

### tmux

These keys use the tmux prefix and are configurable.

| Key | Action |
| --- | --- |
| `<prefix> D` | Open the dashboard |
| `<prefix> T` | Tag or untag the current pane (using its running command as the label) |
| `<prefix> M` | Tag the current pane with a typed label |

### Dashboard

| Key | Action |
| --- | --- |
| `j` / `k` (or arrow keys) | Move down / up in navigation mode |
| `g` / `G` | First / last row in navigation mode |
| `s` | Toggle status-priority and hierarchical session grouping in navigation mode |
| `/` | Enter filter mode |
| `esc` | In filter mode, return to navigation mode and keep the query; in navigation mode, close the dashboard |
| `enter` | Jump to the selected pane or session |
| `ctrl-s` | Send a one-shot command to the selected pane (session rows are a no-op) |
| `ctrl-z` | Zoom, then jump to the selected pane (session rows just jump) |
| `q` | Close the dashboard in navigation mode |

## Configuration

Set any of these global tmux options before loading the plugin:

```tmux
set -g @pane-dash-key        'D'
set -g @pane-dash-tag-key    'T'
set -g @pane-dash-label-key  'M'
set -g @pane-dash-width      '80%'
set -g @pane-dash-height     '70%'
set -g @pane-dash-match      'opencode' # process name for auto-discovery
set -g @pane-dash-stale-secs '60'       # heartbeat staleness threshold, in seconds
set -g @pane-dash-preview-layout     'right,55%,border-left'
set -g @pane-dash-preview-threshold  '100'
set -g @pane-dash-preview-alt-layout 'down,55%,border-top'
```

The dashboard opens with hierarchical session grouping by default. Pressing
`s` switches between that grouping and flat status sorting; the global
`@pane_dash_group` selection persists across dashboard reloads and future
opens, intentionally shared across all clients.

| Option | Default | Description |
| --- | --- | --- |
| `@pane-dash-key` | `D` | Dashboard key, used with the tmux prefix |
| `@pane-dash-tag-key` | `T` | Tag/untag key, used with the tmux prefix |
| `@pane-dash-label-key` | `M` | Key to tag the current pane with a typed label |
| `@pane-dash-width` | `80%` | Popup width |
| `@pane-dash-height` | `70%` | Popup height |
| `@pane-dash-match` | `opencode` | Process name for auto-discovery |
| `@pane-dash-stale-secs` | `60` | Heartbeat staleness threshold, in seconds |
| `@pane-dash-preview-layout` | `right,55%,border-left` | Preview layout at or above the threshold |
| `@pane-dash-preview-threshold` | `100` | Terminal columns below which the alternate layout is used |
| `@pane-dash-preview-alt-layout` | `down,55%,border-top` | Preview layout below the threshold |
| `@pane_dash_group` | `1` | Dashboard sort mode (`1` renders session headers with indented panes; `0` uses flat status sorting) |

### Portrait monitors

The preview automatically moves below the list when the popup is narrower than
100 columns, keeping list columns readable on tall, narrow monitors. Adjust the
three preview options above to suit a different popup size or preferred split.

### Troubleshooting

The dashboard caches a successful tmux/fzf version check to make later opens
faster. After upgrading either dependency, if the dashboard behaves strangely
or reports an unexpected compatibility problem, clear that cache once from a
tmux shell:

```bash
path/to/tmux-pane-dash/scripts/dash.sh --recheck
```

The next dashboard open performs the full version check again.

## Status legend

| Status | Glyph and color | Meaning |
| --- | --- | --- |
| `needs_input` | Red `●` (and red status text) | OpenCode is waiting for a permission or question response |
| `error` | Red `✖` | An error is latched until OpenCode starts work again or receives a new user message |
| `working` | Yellow `◐` | OpenCode is busy or retrying |
| `idle` | Green `○` | OpenCode is known to be idle |
| `unknown` | Gray `?` | No companion-plugin status is available |
| `stale` | Gray `~` | A pane still has plugin status data, but its heartbeat is no longer fresh |

The companion plugin refreshes its heartbeat about every 20 seconds. A pane is
marked `stale` when `now - @pane_dash_heartbeat` exceeds
`@pane-dash-stale-secs` (60 seconds by default). This catches panes whose
OpenCode process exited while tmux kept the pane alive.

## Status accuracy

Status is event-driven by OpenCode itself, not inferred from terminal output.
The active session is inferred from the most recent user activity in a top-level
session; its subagents are included, so a subagent permission request bubbles up
as `needs_input`. Before any user activity is seen, or if attribution cannot be
resolved, the dashboard uses an aggregate worst-status view across the OpenCode
instance. This behavior is based on the OpenCode 1.17.20 event traces used for
this project.

## Sending commands safely

Manually tagged panes may run arbitrary applications. `ctrl-s` shows the target
pane's current command before you type; read it before sending anything. Sending
is literal, but it still delivers your text and Enter to the selected program.

## v1.1 roadmap

- Broadcast to visible panes
- Kill-pane action
- Eligibility guards before sending to manually tagged, non-OpenCode panes
