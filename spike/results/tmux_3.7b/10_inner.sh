#!/usr/bin/env bash
{
  printf 'list-panes -a -F "PROBE:#{pane_id}"\n'
} | TMUX='' "tmux" -L "pd_spike_popup" -C attach-session -f no-output,ignore-size -t '$0' > "/Users/ainz/Work/Personal/tmux-pane-dash/spike/results/tmux_3.7b/10_inner_out.txt" 2>&1
