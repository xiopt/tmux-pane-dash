#!/usr/bin/env bash
# Real-tmux process harness.  It is intentionally isolated from a user's tmux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/spike/lib.sh"
REAL_TMUX="$(command -v "$TMUX_BIN")"
BIN="$ROOT/bin/pane-dash"
TMP='' SOCKET='' WRAP='' LOG='' REJECT=''
declare -a CLIENT_PIDS=() CLIENT_TTYS=() PRODUCER_PIDS=() WRITER_FDS=()
declare -a TRANSCRIPTS=() SESSIONS=() LABELS=() POPUP_CONTROLS=()

die() { printf 'FAIL: %s\n' "$*" >&2; diagnostics >&2 || true; exit 1; }
admin() { TMUX='' "$REAL_TMUX" -S "$SOCKET" "$@"; }
now() { perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'printf "%.9f",clock_gettime(CLOCK_MONOTONIC)'; }
cleanup() {
  set +e
  local fd pid
  for fd in "${WRITER_FDS[@]:-}"; do eval "exec ${fd}>&-"; done
  for pid in "${POPUP_CONTROLS[@]:-}" "${CLIENT_PIDS[@]:-}" "${PRODUCER_PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  admin kill-server 2>/dev/null
  [[ -z "$TMP" ]] || rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM
diagnostics() {
  admin list-clients -F '#{client_pid} #{client_control_mode} #{client_tty}' 2>&1 || true
  local index
  for index in "${!CLIENT_PIDS[@]}"; do
    printf 'owner[%s] label=%s session=%s client=%s tty=%s popup=%s producer=%s transcript=%s\n' "$index" "${LABELS[index]}" "${SESSIONS[index]}" "${CLIENT_PIDS[index]}" "${CLIENT_TTYS[index]}" "${POPUP_CONTROLS[index]:-}" "${PRODUCER_PIDS[index]}" "${TRANSCRIPTS[index]}" >&2
  done
  [[ -z "$LOG" ]] || perl -e 'for(glob "$ARGV[0]/*"){open F,"<",$_ or next;binmode F;local$/;$_=<F>;s/\0/ | /g;print}' "$LOG" 2>/dev/null | tail -30 || true
}

wait_for() { local what="$1" budget="$2" start; shift 2; start="$(now)"; while ! "$@"; do perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'exit clock_gettime(CLOCK_MONOTONIC)-$ARGV[0]<$ARGV[1]?0:1' "$start" "$budget" || die "timeout: $what"; sleep .02; done; }
controls() { admin list-clients -F '#{client_pid} #{client_control_mode}' | awk '$2==1{print$1}' | sort -u; }
control_count() { controls | awk 'END{print NR+0}'; }
has_two_controls() { (( $(control_count)==2 )); }
normal_clients() { admin list-clients -F '#{client_pid} #{client_control_mode} #{client_tty}' | awk '$2==0 {print $1 " " $3}' | sort -u; }
new_normal_client() {
  local before="$1" rows pid tty
  rows="$(normal_clients)"
  while read -r pid tty; do
    [[ -n "$pid" ]] || continue
    if ! grep -Fqx "$pid $tty" <<< "$before"; then
      NEW_CLIENT_PID="$pid"
      NEW_CLIENT_TTY="$tty"
      return 0
    fi
  done <<< "$rows"
  return 1
}
ansi_has() { grep -aFq "$2" "${TRANSCRIPTS[$1]}"; }
ansi_size() { wc -c < "${TRANSCRIPTS[$1]}" | tr -d ' '; }
ansi_grew_from() { (( $(ansi_size "$1") > $2 )); }
ansi_tail_has() { tail -c "+$2" "${TRANSCRIPTS[$1]}" | grep -aFq "$3"; }
# Count the command word, not an arbitrary matching argv element: target text is
# untrusted and may itself contain words such as "capture-pane".
record_count() { perl -e 'use strict;my($d,$a,$b,$wanted)=@ARGV;my$n=0;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$a||$t>$b;while(@v){my$x=shift@v;if($x eq q(-S)||$x eq q(-f)){shift@v;next}if($x eq q(-C)){if($wanted eq q(-C)){$n++}next}if($x eq $wanted){$n++}last}}print"$n\n"' "$LOG" "$1" "$2" "$3"; }
has_capture_since() { (( $(record_count "$1" "$(now)" capture-pane)>0 )); }
has_list_since() { (( $(record_count "$1" "$(now)" list-panes)>0 )); }
budget() { local tag="$1" cap="$2" list="$3" a b c l; a="$(now)"; sleep 5; b="$(now)"; c="$(record_count "$a" "$b" capture-pane)"; l="$(record_count "$a" "$b" list-panes)"; printf 'budget %s capture=%s list=%s\n' "$tag" "$c" "$l"; ((c<=cap&&l<=list)) || die "$tag process budget"; }

make_wrapper() {
  mkdir -p "$WRAP" "$LOG"
  cat > "$WRAP/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args=("$@"); [[ -n "${TMUX:-}" ]] || args=(-S "$PD_SOCKET" "${args[@]}")
f="$(mktemp "$PD_LOG/invocation.XXXXXXXX")"
perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'my$f=shift;open my$o,">",$f or die$!;binmode$o;printf $o "%.9f\0",clock_gettime(CLOCK_MONOTONIC);print $o join("\0",@ARGV),"\0"' "$f" "${args[@]}"
if [[ -e "$PD_REJECT" ]]; then for x in "${args[@]}"; do [[ "$x" != -C ]] || exit 79; done; fi
exec "$PD_REAL_TMUX" "${args[@]}"
EOF
  chmod 755 "$WRAP/tmux"
}
start_client() { # session label
  local session="$1" label="$2" index="${#CLIENT_PIDS[@]}" before fifo transcript fd pid
  before="$(normal_clients)"
  fifo="$TMP/$label.fifo" transcript="$TMP/$label.ansi"
  mkfifo "$fifo"
  # cat turns the FIFO producer into the regular stdin pipeline supported by macOS script.
  cat "$fifo" | PD_REAL_TMUX="$REAL_TMUX" PD_SOCKET="$SOCKET" PD_LOG="$LOG" PD_REJECT="$REJECT" PATH="$WRAP:$PATH" TMUX='' pd_run_in_pty "$WRAP/tmux" attach-session -t "$session" >"$transcript" 2>&1 &
  pid=$!; exec {fd}>"$fifo"
  wait_for "client $label attach" 3 new_normal_client "$before"
  CLIENT_PIDS[index]="$NEW_CLIENT_PID"
  CLIENT_TTYS[index]="$NEW_CLIENT_TTY"
  PRODUCER_PIDS[index]="$pid"
  WRITER_FDS[index]="$fd"
  TRANSCRIPTS[index]="$transcript"
  SESSIONS[index]="$session"
  LABELS[index]="$label"
  sleep .2
}
send_bytes() { local fd="${WRITER_FDS[$1]}"; printf '%b' "$2" >&"$fd"; sleep .1; }
new_control() {
  local before="$1" pid
  while read -r pid; do
    if ! grep -Fqx "$pid" <<< "$before"; then
      NEW_CONTROL_PID="$pid"
      return 0
    fi
  done < <(controls)
  return 1
}
control_present() { controls | grep -Fxq "$1"; }
popup_open() { control_present "${POPUP_CONTROLS[$1]:-}"; }
popup_closed() { ! popup_open "$1"; }
popup_is_only_control() { popup_open "$1" && (( $(control_count)==1 )); }
popup_replaced() { [[ "${POPUP_CONTROLS[$1]:-}" == "$2" ]] && ! control_present "$2" && (( $(control_count)==1 )); }
open_popup() {
  local index="$1" before
  before="$(controls)"
  send_bytes "$index" '\002'; send_bytes "$index" D
  wait_for "popup $index control" 3 new_control "$before"
  POPUP_CONTROLS[index]="$NEW_CONTROL_PID"
}
close_popup() { send_bytes "$1" q; wait_for "popup $1 close" 2 popup_closed "$1"; POPUP_CONTROLS[$1]=''; }
target_gone() { ! admin list-panes -a -F '#{pane_id}' | grep -Fxq "$1"; }
target_present() { admin list-panes -a -F '#{pane_id}' | grep -Fxq "$1"; }
runtime_count() { local start="$1" end="$2"; local total=0 command; for command in capture-pane list-panes show-options -C; do total=$((total + $(record_count "$start" "$end" "$command"))); done; printf '%s\n' "$total"; }
pane_contains() { admin capture-pane -p -t "$1" | grep -aFq "$2"; }

main() {
  [[ -x "$BIN" ]] || die "missing $BIN; run make build"
  if ! command -v perl >/dev/null || ! command -v script >/dev/null; then die 'perl and script required'; fi
  perl -e 'exit($ARGV[0]=~/^(\d+)\.(\d+)/&&($1>3||$1==3&&$2>=6)?0:1)' "$($REAL_TMUX -V|awk '{print $2}')" || die 'tmux >=3.6 required'
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/pane-dash-live.XXXXXXXX")"; SOCKET="$TMP/socket"; WRAP="$TMP/wrap"; LOG="$TMP/log"; REJECT="$TMP/reject"; make_wrapper
  TMUX='' "$REAL_TMUX" -S "$SOCKET" -f /dev/null new-session -d -s live -x 120 -y 40 'exec cat'
  admin new-session -d -s other -x 120 -y 40 'exec cat'
  local pane target startup old_control t before after captures
  pane="$(admin display-message -p -t live:0.0 '#{pane_id}')"; target="$(admin split-window -d -P -F '#{pane_id}' -t live:0 'exec cat')"
  admin set-option -g @pane-dash-engine rust; admin set-option -g @pane-dash-width 100%; admin set-option -g @pane-dash-height 100%; admin set-option -g focus-events on; admin set-option -as terminal-features ',xterm*:focus'; admin set-option -p -t "$pane" @pane_dash_tag live-test; admin set-option -p -t "$target" @pane_dash_tag live-spare
  admin set-environment -g PATH "$WRAP:$PATH"; admin set-environment -g PD_REAL_TMUX "$REAL_TMUX"; admin set-environment -g PD_SOCKET "$SOCKET"; admin set-environment -g PD_LOG "$LOG"; admin set-environment -g PD_REJECT "$REJECT"
  # Install pane_dash.tmux through the wrapper; do not directly run pane-dash.
  PATH="$WRAP:$PATH" PD_REAL_TMUX="$REAL_TMUX" PD_SOCKET="$SOCKET" PD_LOG="$LOG" PD_REJECT="$REJECT" TMUX='' "$ROOT/pane_dash.tmux"
  start_client live first; start_client live second
  [[ -n "${CLIENT_PIDS[0]:-}" && -n "${CLIENT_TTYS[0]:-}" && -n "${CLIENT_PIDS[1]:-}" && -n "${CLIENT_TTYS[1]:-}" ]] || die 'client identity mapping'
  open_popup 0; [[ -n "${POPUP_CONTROLS[0]:-}" ]] || die 'first popup owner mapping'; wait_for 'first popup frame' 3 ansi_has 0 live-test; (( $(control_count)==1 )) || die 'first popup control count'
  open_popup 1; [[ -n "${POPUP_CONTROLS[1]:-}" && "${POPUP_CONTROLS[0]}" != "${POPUP_CONTROLS[1]}" ]] || die 'independent popup owner mapping'; wait_for 'independent popup controls' 3 has_two_controls
  before="$(ansi_size 0)"; admin resize-window -t live:0 -x 99 -y 32; send_bytes 0 '\014'; wait_for '99-column layout transcript' 2 ansi_grew_from 0 "$before"; ansi_tail_has 0 "$((before+1))" '─' || die '99-column transcript lacks vertical preview border'
  before="$(ansi_size 0)"; admin resize-window -t live:0 -x 100 -y 32; send_bytes 0 '\014'; wait_for '100-column layout transcript' 2 ansi_grew_from 0 "$before"; ansi_tail_has 0 "$((before+1))" '│' || die '100-column transcript lacks horizontal preview border'; has_two_controls || die 'resize panicked popup'
  # All open_v2/binary option reads must settle before the runtime assertion.
  startup="$(now)"
  send_bytes 0 j # None -> session header; the second j selects its first pane.
  t="$(now)"; send_bytes 0 j; wait_for 'selected-pane preview <=500ms' .5 has_capture_since "$t"
  send_bytes 0 '\025'; before="$(record_count "$startup" "$(now)" capture-pane)"; budget 'healthy inspect' 0 0; after="$(record_count "$startup" "$(now)" capture-pane)"; ((before==after)) || die 'Ctrl-U capture'
  send_bytes 0 '\022'; t="$(now)"; wait_for 'Ctrl-R preview' .5 has_capture_since "$t"
  # Prove the second owner has an independently running preview before the
  # first owner's focus transition. Pausing the first owner isolates that
  # capture to the second control client.
  send_bytes 0 '\025'; t="$(now)"; send_bytes 1 j; send_bytes 1 j; wait_for 'second popup preview' .5 has_capture_since "$t"
  send_bytes 0 '\022';
  # Subscription changes are sampled by tmux at most once a second, so the
  # first owner may contribute up to two captures before it observes FocusOut.
  send_bytes 0 '\033[O'; t="$(now)"; budget 'focus-out first owner only second follows' 12 0; captures="$(record_count "$t" "$(now)" capture-pane)"; ((captures>=9)) || die 'second popup did not continue during first focus-out'
  close_popup 1; wait_for 'second popup independent close' 2 popup_is_only_control 0
  before="$(record_count "$startup" "$(now)" capture-pane)"; budget 'focus-out inspect' 0 0; after="$(record_count "$startup" "$(now)" capture-pane)"; ((before==after)) || die 'focus-out capture'
  t="$(now)"; send_bytes 0 '\033[I'; wait_for 'focus-in preview' .5 has_capture_since "$t"; budget 'healthy follow' 10 0
  (( $(record_count "$startup" "$(now)" show-options)==0 )) || die 'runtime show-options'
  old_control="${POPUP_CONTROLS[0]}"; admin run-shell "kill -TERM $old_control"; wait_for 'single replacement control' 3 popup_replaced 0 "$old_control"; POPUP_CONTROLS[0]="$(controls)"; t="$(now)"; : > "$REJECT"; admin run-shell "kill -TERM ${POPUP_CONTROLS[0]}"
  wait_for 'degraded banner' 3 ansi_has 0 'live updates lost — polling'; wait_for 'degraded list-panes' 2 has_list_since "$t"; wait_for 'no persistent control after rejected reconnect' 2 control_is_zero
  budget 'degraded follow' 10 5; send_bytes 0 '\025'; budget 'degraded inspect' 0 5
  # Status publishers write a coherent triple. A bare status is deliberately
  # stale, so it must not be used as evidence for degraded polling.
  local epoch status_offset
  epoch="$(date +%s)"; t="$(now)"; status_offset="$(ansi_size 0)"
  admin set-option -p -t "$pane" @pane_dash_status idle
  admin set-option -p -t "$pane" @pane_dash_status_since "$epoch"
  admin set-option -p -t "$pane" @pane_dash_heartbeat "$epoch"
  sleep .1
  (( $(record_count "$t" "$(now)" list-panes)==0 )) || die 'status write unexpectedly consumed a notification'
  wait_for 'status fallback list-panes <=1.1s' 1.1 has_list_since "$t"
  ansi_tail_has 0 "$((status_offset+1))" idle || die 'new status snapshot did not render idle'
  (( $(record_count "$t" "$(now)" show-options)==0 )) || die 'status polling used show-options'
  # The selected visible cat pane receives literal hostile text before it is
  # killed. $target remains alive to keep the attached session/popup valid.
  local sentinel="$TMP/sentinel" hostile="; touch $TMP/sentinel #"
  send_bytes 0 '\023'; send_bytes 0 "$hostile"; send_bytes 0 '\r'
  wait_for 'literal hostile send reaches selected cat pane' 2 pane_contains "$pane" "$hostile"
  [[ ! -e "$sentinel" ]] || die 'hostile send sentinel'
  send_bytes 0 x; send_bytes 0 y; wait_for 'confirmed selected-pane kill' 2 target_gone "$pane"; target_present "$target" || die 'spare pane did not survive selected kill'
  # Dedicated attached-session destruction cases remain bounded for both options.
  for mode in off on; do admin new-session -d -s "destroy-$mode" 'exec cat'; admin set-option -t "destroy-$mode" detach-on-destroy "$mode"; admin kill-session -t "destroy-$mode"; wait_for "destroy $mode" 2 session_gone "destroy-$mode"; done
  t="$(now)"; send_bytes 0 q; sleep .2; (( $(runtime_count "$t" "$(now)")==0 )) || die 'closed popup runtime work'
  printf 'ok: controls startup=2 replacement=1 rejected=1; process budgets passed\n'
}
session_gone() { ! admin has-session -t "$1" 2>/dev/null; }
control_is_zero() { (( $(control_count)==0 )); }
main "$@"
