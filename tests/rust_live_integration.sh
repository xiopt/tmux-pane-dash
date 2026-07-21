#!/usr/bin/env bash
# Real-tmux process harness.  It is intentionally isolated from a user's tmux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/spike/lib.sh"
REAL_TMUX="$(command -v "$TMUX_BIN")"
BIN="$ROOT/bin/pane-dash"
TMP='' SOCKET='' WRAP='' LOG='' REJECT=''
declare -a PIDS=() FDS=() ANSI=()

die() { printf 'FAIL: %s\n' "$*" >&2; diagnostics >&2 || true; exit 1; }
admin() { TMUX='' "$REAL_TMUX" -S "$SOCKET" "$@"; }
now() { perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'printf "%.9f",clock_gettime(CLOCK_MONOTONIC)'; }
cleanup() { set +e; local fd pid; for fd in "${FDS[@]:-}"; do eval "exec ${fd}>&-"; done; for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done; admin kill-server 2>/dev/null; [[ -z "$TMP" ]] || rm -rf "$TMP"; }
trap cleanup EXIT HUP INT TERM
diagnostics() { admin list-clients -F '#{client_pid} #{client_control_mode} #{client_tty}' 2>&1 || true; [[ -z "$LOG" ]] || perl -e 'for(glob "$ARGV[0]/*"){open F,"<",$_ or next;binmode F;local$/;$_=<F>;s/\0/ | /g;print}' "$LOG" 2>/dev/null | tail -30 || true; }

wait_for() { local what="$1" budget="$2" start; shift 2; start="$(now)"; while ! "$@"; do perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'exit clock_gettime(CLOCK_MONOTONIC)-$ARGV[0]<$ARGV[1]?0:1' "$start" "$budget" || die "timeout: $what"; sleep .02; done; }
controls() { admin list-clients -F '#{client_pid} #{client_control_mode}' | awk '$2==1{print$1}' | sort -u; }
control_count() { controls | awk 'END{print NR+0}'; }
has_control() { (( $(control_count)>0 )); }
has_two_controls() { (( $(control_count)==2 )); }
first_control() { controls | head -1; }
client_up() { admin list-clients -F '#{client_tty}' | grep -q .; }
ansi_has() { grep -aFq "$1" "${ANSI[0]}"; }
ansi_size() { wc -c < "${ANSI[0]}" | tr -d ' '; }
ansi_grew_from() { (( $(ansi_size) > $1 )); }
ansi_tail_has() { tail -c "+$1" "${ANSI[0]}" | grep -aFq "$2"; }
record_count() { perl -e 'use strict;my($d,$a,$b,$x)=@ARGV;my$n=0;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$a||$t>$b;$n++ if grep { $_ eq $x } @v}print"$n\n"' "$LOG" "$1" "$2" "$3"; }
has_capture_since() { (( $(record_count "$1" "$(now)" capture-pane)>0 )); }
has_list() { (( $(record_count 0 "$(now)" list-panes)>0 )); }
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
start_client() { # session name
  local fifo="$TMP/$2.fifo" transcript="$TMP/$2.ansi" fd pid
  mkfifo "$fifo"
  # cat turns the FIFO producer into the regular stdin pipeline supported by macOS script.
  cat "$fifo" | PD_REAL_TMUX="$REAL_TMUX" PD_SOCKET="$SOCKET" PD_LOG="$LOG" PD_REJECT="$REJECT" PATH="$WRAP:$PATH" TMUX='' pd_run_in_pty "$WRAP/tmux" attach-session -t "$1" >"$transcript" 2>&1 &
  pid=$!; exec {fd}>"$fifo"; PIDS+=("$pid"); FDS+=("$fd"); ANSI+=("$transcript")
  wait_for "client $2 attach" 3 client_up; sleep .2
}
send_bytes() { local fd="${FDS[$1]}"; printf '%b' "$2" >&"$fd"; sleep .1; }
open_popup() { send_bytes "$1" '\002'; send_bytes "$1" D; wait_for "popup $1 control" 3 has_control; }
replacement() { [[ "$(first_control)" != "$1" && $(control_count) -eq 1 ]]; }
only_control() { [[ "$(first_control)" == "$1" && $(control_count) -eq 1 ]]; }
target_gone() { ! admin list-panes -a -F '#{pane_id}' | grep -Fxq "$1"; }

main() {
  [[ -x "$BIN" ]] || die "missing $BIN; run make build"
  if ! command -v perl >/dev/null || ! command -v script >/dev/null; then die 'perl and script required'; fi
  perl -e 'exit($ARGV[0]=~/^(\d+)\.(\d+)/&&($1>3||$1==3&&$2>=6)?0:1)' "$($REAL_TMUX -V|awk '{print $2}')" || die 'tmux >=3.6 required'
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/pane-dash-live.XXXXXXXX")"; SOCKET="$TMP/socket"; WRAP="$TMP/wrap"; LOG="$TMP/log"; REJECT="$TMP/reject"; make_wrapper
  TMUX='' "$REAL_TMUX" -S "$SOCKET" -f /dev/null new-session -d -s live -x 120 -y 40 'exec cat'
  admin new-session -d -s other -x 120 -y 40 'exec cat'
  local pane target startup first second t before after
  pane="$(admin display-message -p -t live:0.0 '#{pane_id}')"; target="$(admin split-window -d -P -F '#{pane_id}' -t live:0 'exec cat')"
  admin set-option -g @pane-dash-engine rust; admin set-option -g @pane-dash-width 100%; admin set-option -g @pane-dash-height 100%; admin set-option -p -t "$pane" @pane_dash_tag live-test
  admin set-environment -g PATH "$WRAP:$PATH"; admin set-environment -g PD_REAL_TMUX "$REAL_TMUX"; admin set-environment -g PD_SOCKET "$SOCKET"; admin set-environment -g PD_LOG "$LOG"; admin set-environment -g PD_REJECT "$REJECT"
  # Install pane_dash.tmux through the wrapper; do not directly run pane-dash.
  PATH="$WRAP:$PATH" PD_REAL_TMUX="$REAL_TMUX" PD_SOCKET="$SOCKET" PD_LOG="$LOG" PD_REJECT="$REJECT" TMUX='' "$ROOT/pane_dash.tmux"
  start_client live first; start_client live second; startup="$(now)"
  open_popup 0; wait_for 'first popup frame' 3 ansi_has live-test; (( $(control_count)==1 )) || die 'first popup control count'; first="$(first_control)"
  open_popup 1; wait_for 'independent popup controls' 3 has_two_controls
  before="$(ansi_size)"; admin resize-window -t live:0 -x 99 -y 32; send_bytes 0 '\014'; wait_for '99-column layout transcript' 2 ansi_grew_from "$before"; ansi_tail_has "$((before+1))" '─' || die '99-column transcript lacks vertical preview border'
  before="$(ansi_size)"; admin resize-window -t live:0 -x 100 -y 32; send_bytes 0 '\014'; wait_for '100-column layout transcript' 2 ansi_grew_from "$before"; ansi_tail_has "$((before+1))" '│' || die '100-column transcript lacks horizontal preview border'; has_two_controls || die 'resize panicked popup'
  send_bytes 1 q; wait_for 'second popup independent close' 2 only_control "$first"
  t="$(now)"; send_bytes 0 j; wait_for 'selected-pane preview <=500ms' .5 has_capture_since "$t"
  send_bytes 0 '\025'; before="$(record_count "$startup" "$(now)" capture-pane)"; budget 'healthy inspect' 0 0; after="$(record_count "$startup" "$(now)" capture-pane)"; ((before==after)) || die 'Ctrl-U capture'
  send_bytes 0 '\022'; t="$(now)"; wait_for 'Ctrl-R preview' .5 has_capture_since "$t"
  send_bytes 0 '\033[O'; before="$(record_count "$startup" "$(now)" capture-pane)"; budget 'focus-out inspect' 0 0; after="$(record_count "$startup" "$(now)" capture-pane)"; ((before==after)) || die 'focus-out capture'
  t="$(now)"; send_bytes 0 '\033[I'; wait_for 'focus-in preview' .5 has_capture_since "$t"; budget 'healthy follow' 10 0
  (( $(record_count "$startup" "$(now)" show-options)==0 )) || die 'runtime show-options'
  admin run-shell "kill -TERM $first"; wait_for 'single replacement control' 3 replacement "$first"; second="$(first_control)"; : > "$REJECT"; admin run-shell "kill -TERM $second"
  wait_for 'degraded banner' 3 ansi_has 'live updates lost — polling'; wait_for 'degraded list-panes' 2 has_list; (( $(control_count)==1 )) || die 'rejected control resurrected'
  budget 'degraded follow' 10 5; send_bytes 0 '\025'; budget 'degraded inspect' 0 5
  t="$(now)"; admin set-option -p -t "$pane" @pane_dash_status idle; wait_for 'pane status <=1.1s' 1.1 ansi_has idle; (( $(record_count "$t" "$(now)" show-options)==0 )) || die 'status write consumed notification'
  # Popup action cases: kill confirmation and hostile literal send use actual key input.
  send_bytes 0 x; send_bytes 0 y; wait_for 'confirmed kill' 2 target_gone "$target"
  local sentinel="$TMP/sentinel" hostile="; touch $TMP/sentinel #"; send_bytes 0 '\023'; send_bytes 0 "$hostile"; send_bytes 0 '\r'; [[ ! -e "$sentinel" ]] || die 'hostile send sentinel'
  # Dedicated attached-session destruction cases remain bounded for both options.
  for mode in off on; do admin new-session -d -s "destroy-$mode" 'exec cat'; admin set-option -t "destroy-$mode" detach-on-destroy "$mode"; admin kill-session -t "destroy-$mode"; wait_for "destroy $mode" 2 session_gone "destroy-$mode"; done
  t="$(now)"; send_bytes 0 q; send_bytes 1 q; sleep .2; (( $(record_count "$t" "$(now)" pane-dash)==0 )) || die 'closed popup work'
  printf 'ok: controls startup=2 replacement=1 rejected=1; process budgets passed\n'
}
session_gone() { ! admin has-session -t "$1" 2>/dev/null; }
main "$@"
