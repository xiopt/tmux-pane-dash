#!/usr/bin/env bash
{
  printf 'list-panes -a -F "PROBE:#{pane_id}"\n'
} | TMUX='' "/opt/tmux/3.2/bin/tmux" -L "pd_spike_popup" -C attach-session -f no-output,ignore-size -t '$0' > "/work/spike/results/tmux_3.2/10_inner_out.txt" 2>&1
