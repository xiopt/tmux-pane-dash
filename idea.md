# tmux-pane-dash

Tag/mark arbitrary tmux panes, then open a popup dashboard (fzf + live preview)
to jump to them, send commands, broadcast to all of them, zoom, or kill.

State lives in a per-pane user option (`@dash`), so tags disappear on their own
when a pane closes. No external registry, no daemon.

## Requirements

- tmux >= 3.2 (for `display-popup`)
- fzf (for the dashboard). Without it, see the display-menu note below.

## Install (TPM)

```tmux
set -g @plugin 'youruser/tmux-pane-dash'
```

Then `<prefix> I`.

## Install (manual / local dev)

```tmux
run-shell ~/path/to/tmux-pane-dash/pane_dash.tmux
```

Reload: `tmux source ~/.tmux.conf`.

## Default keys

| key          | action                                           |
| ------------ | ------------------------------------------------ |
| `<prefix> T` | tag/untag current pane (label = running command) |
| `<prefix> M` | tag current pane with a label you type           |
| `<prefix> D` | open the dashboard                               |

Inside the dashboard:
| key | action |
|----------|------------------------------------------|
| `enter` | focus that pane |
| `ctrl-s` | send a command to that pane |
| `ctrl-a` | send a command to ALL tagged panes |
| `ctrl-z` | toggle zoom on that pane, then focus it |
| `ctrl-x` | kill that pane |
| `ctrl-r` | refresh the preview |

## Configuration

```tmux
set -g @pane-dash-tag-key   'T'
set -g @pane-dash-label-key 'M'
set -g @pane-dash-key       'D'
set -g @pane-dash-width     '80%'
set -g @pane-dash-height    '70%'
```

## No fzf? Native display-menu variant

`display-menu` builds an interactive menu from tmux commands, zero deps but no
fuzzy search / preview. Sketch — bind this and generate items on the fly:

```bash
items=()
while IFS=$'\t' read -r label pid target _ _; do
  items+=("$label ($target)" "" "select-pane -t $pid ; select-window -t $pid")
done < <(tmux list-panes -a -F '#{@dash}\t#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{pane_current_path}' | awk -F'\t' '$1!=""')
tmux display-menu -T ' tagged panes ' "${items[@]}"
```
