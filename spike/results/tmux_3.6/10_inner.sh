#!/usr/bin/env bash
{
  printf 'list-panes -a -F "PROBE:#{pane_id}"\n'
} | TMUX='' "/tmp/tmux-pane-dash-compat-macos-arm64/build/tmux-3.6/install/bin/tmux" -L "pd_spike_popup" -C attach-session -f no-output,ignore-size -t '$0' > "/Users/ainz/Work/Personal/tmux-pane-dash/spike/results/tmux_3.6/10_inner_out.txt" 2>&1
