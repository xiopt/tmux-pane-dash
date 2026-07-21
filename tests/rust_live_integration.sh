#!/usr/bin/env bash
# Real-tmux process harness.  It is intentionally isolated from a user's tmux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/spike/lib.sh"
REAL_TMUX="$(command -v "$TMUX_BIN")"
BIN="$ROOT/bin/pane-dash"
TMP='' SOCKET='' WRAP='' LOG='' REJECT='' TASK9_MARKER='' TASK9_DEGRADED_INDEX='' TASK9_HOOK_INDEX=''
CREATION_GATE='' CREATION_FAIL_STAGE='' CREATION_GONE=''
declare -a CLIENT_PIDS=() CLIENT_TTYS=() PRODUCER_PIDS=() WRITER_FDS=()
declare -a TRANSCRIPTS=() SESSIONS=() LABELS=() POPUP_CONTROLS=() POPUP_PIDS=()
declare -a TASK9_SOURCE_SESSIONS=() TASK9_TARGET_SESSIONS=() TASK9_SOURCE_PANES=()
declare -a TASK9_TARGET_PANES=() TASK9_TAGS=() TASK9_CLIENT_INDEXES=()

die() { printf 'FAIL: %s\n' "$*" >&2; diagnostics >&2 || true; exit 1; }
admin() { TMUX='' "$REAL_TMUX" -S "$SOCKET" "$@"; }
now() { perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'printf "%.9f",clock_gettime(CLOCK_MONOTONIC)'; }
elapsed_ms() { perl -e 'printf "%.0f", ($ARGV[1] - $ARGV[0]) * 1000' "$1" "$(now)"; }
cleanup() {
  set +e
  local fd pid
  task9_clear_causal_evidence
  if [[ -n "$TASK9_MARKER" ]]; then rm -f "$TASK9_MARKER"; TASK9_MARKER=''; fi
  if [[ -n "$REJECT" ]]; then rm -f "$REJECT"; REJECT=''; fi
  if [[ -n "$CREATION_GATE" ]]; then rm -rf "$CREATION_GATE"; CREATION_GATE=''; fi
  if [[ -n "$TASK9_DEGRADED_INDEX" ]]; then TASK9_DEGRADED_INDEX=''; fi
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
    printf 'owner[%s] label=%s session=%s client=%s tty=%s control=%s popup-pid=%s producer=%s transcript=%s\n' "$index" "${LABELS[index]}" "${SESSIONS[index]}" "${CLIENT_PIDS[index]}" "${CLIENT_TTYS[index]}" "${POPUP_CONTROLS[index]:-}" "${POPUP_PIDS[index]:-}" "${PRODUCER_PIDS[index]}" "${TRANSCRIPTS[index]}" >&2
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
  command_index=0
  while (( command_index < ${#args[@]} )); do
    case "${args[command_index]}" in
      -S|-f) ((command_index += 2)) ;;
      *) break ;;
    esac
  done
  command_name="${args[command_index]:-}"
  if [[ "${PD_CREATION_FAIL_STAGE:-}" == tag && "$command_name" == set-option ]]; then
    for x in "${args[@]}"; do
      if [[ "$x" == @pane_dash_tag ]]; then
        echo 'tag stage rejected by live wrapper' >&2
        exit 79
      fi
    done
  fi
  if [[ -n "${PD_CREATION_GATE:-}" && ( "$command_name" == new-session || "$command_name" == new-window || "$command_name" == split-window ) ]]; then
    printf '%s\n' "$$" >> "$PD_CREATION_GATE/pids"
    : > "$PD_CREATION_GATE/started"
    trap 'exit 143' HUP INT TERM
    while [[ ! -e "$PD_CREATION_GATE/release" ]]; do sleep .02; done
  fi
  if [[ "${PD_CREATION_GONE:-}" == 1 && ( "$command_name" == new-session || "$command_name" == new-window || "$command_name" == split-window ) ]]; then
    created="$(TMUX='' "$PD_REAL_TMUX" -S "$PD_SOCKET" "${args[@]}")" || exit $?
    TMUX='' "$PD_REAL_TMUX" -S "$PD_SOCKET" kill-pane -t "$created" || exit $?
    printf '%s\n' "$created"
    exit 0
  fi
  if [[ -n "${PD_TASK9_MARKER:-}" && -f "$PD_TASK9_MARKER" ]]; then
    read -r marker_kind marker_pane marker_victim < "$PD_TASK9_MARKER"
    command_index=0
    while (( command_index < ${#args[@]} )); do
      case "${args[command_index]}" in
        -S|-f) ((command_index += 2)) ;;
        *) break ;;
      esac
    done
    if [[ "$marker_kind" == causal && "${args[command_index]:-}" == resize-pane && "${args[command_index+1]:-}" == -Z && "${args[command_index+2]:-}" == -t && "${args[command_index+3]:-}" == "$marker_pane" ]]; then
      "$PD_REAL_TMUX" "${args[@]}" || exit $?
      TMUX='' "$PD_REAL_TMUX" -S "$PD_SOCKET" set-option -g @pane_dash_test_resize_complete 1 || exit $?
      rm -f "$PD_TASK9_MARKER"
      exit 0
    fi
    if [[ "$marker_kind" == kill && "${args[command_index]:-}" == resize-pane && "${args[command_index+1]:-}" == -Z && "${args[command_index+2]:-}" == -t && "${args[command_index+3]:-}" == "$marker_pane" ]]; then
      "$PD_REAL_TMUX" "${args[@]}" || exit $?
      TMUX='' "$PD_REAL_TMUX" -S "$PD_SOCKET" kill-pane -t "$marker_victim" || exit $?
      rm -f "$PD_TASK9_MARKER"
      exit 0
    fi
  fi
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
  cat "$fifo" | PD_REAL_TMUX="$REAL_TMUX" PD_SOCKET="$SOCKET" PD_LOG="$LOG" PD_REJECT="$REJECT" PD_CREATION_GATE="$CREATION_GATE" PD_CREATION_FAIL_STAGE="$CREATION_FAIL_STAGE" PD_CREATION_GONE="$CREATION_GONE" PATH="$WRAP:$PATH" TMUX='' pd_run_in_pty "$WRAP/tmux" attach-session -t "$session" >"$transcript" 2>&1 &
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
pid_is_numeric() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
pid_is_alive() {
  local pid="$1" state
  pid_is_numeric "$pid" && kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$state" && "$state" != *Z* ]]
}
pane_dash_process() {
  local pid="$1" command
  pid_is_alive "$pid" || return 1
  command="$(ps -o command= -p "$pid" 2>/dev/null)"
  [[ "$command" == "$BIN"* ]]
}
control_parent_pid() {
  local control="$1" parent
  pid_is_alive "$control" || return 1
  parent="$(ps -o ppid= -p "$control" 2>/dev/null | tr -d '[:space:]')"
  pid_is_numeric "$parent" || return 1
  printf '%s\n' "$parent"
}
popup_control_has_owner() {
  local index="$1" control="$2" parent
  parent="$(control_parent_pid "$control")" || return 1
  [[ "$parent" == "${POPUP_PIDS[index]:-}" ]] && pane_dash_process "$parent"
}
popup_open() { pane_dash_process "${POPUP_PIDS[$1]:-}"; }
popup_closed() { ! popup_open "$1"; }
popup_is_only_control() { popup_open "$1" && (( $(control_count)==1 )); }
popup_replaced() {
  local index="$1" old_control="$2" replacement
  [[ "${POPUP_CONTROLS[index]:-}" == "$old_control" ]] && ! control_present "$old_control" && (( $(control_count)==1 )) || return 1
  replacement="$(controls)"
  [[ "$replacement" != "$old_control" ]] && popup_control_has_owner "$index" "$replacement"
}
open_popup() {
  local index="$1" before popup_pid
  before="$(controls)"
  send_bytes "$index" '\002'; send_bytes "$index" D
  wait_for "popup $index control" 3 new_control "$before"
  POPUP_CONTROLS[index]="$NEW_CONTROL_PID"
  popup_pid="$(control_parent_pid "$NEW_CONTROL_PID")" || die "popup $index control pid invalid: $NEW_CONTROL_PID"
  pane_dash_process "$popup_pid" || die "popup $index parent is not pane-dash: control=$NEW_CONTROL_PID parent=$popup_pid"
  POPUP_PIDS[index]="$popup_pid"
}
close_popup() {
  local index="$1" control="${POPUP_CONTROLS[$1]:-}"
  send_bytes "$index" q
  wait_for "popup $index pane-dash exit" 2 popup_closed "$index"
  ! control_present "$control" || die "popup $index control survived pane-dash exit: $control"
  POPUP_CONTROLS[index]=''
}
target_gone() { ! admin list-panes -a -F '#{pane_id}' | grep -Fxq "$1"; }
target_present() { admin list-panes -a -F '#{pane_id}' | grep -Fxq "$1"; }
runtime_count() { local start="$1" end="$2"; local total=0 command; for command in capture-pane list-panes show-options -C; do total=$((total + $(record_count "$start" "$end" "$command"))); done; printf '%s\n' "$total"; }
assert_no_popup_runtime_after_exit() {
  local label="$1" popup_pid="$2" exited="$3" observed captures lists duration
  sleep 1.1
  observed="$(now)"
  captures="$(record_count "$exited" "$observed" capture-pane)"
  lists="$(record_count "$exited" "$observed" list-panes)"
  duration="$(perl -e 'printf "%.0f", ($ARGV[1] - $ARGV[0]) * 1000' "$exited" "$observed")"
  (( duration >= 1100 )) || die "$label post-exit observation shorter than fallback interval: ${duration}ms"
  (( captures == 0 && lists == 0 )) || die "$label popup runtime after pane-dash exit: capture-pane=$captures list-panes=$lists"
  printf '%s popup-pid=%s post-exit-observation=%sms capture-pane=%s list-panes=%s\n' "$label" "$popup_pid" "$duration" "$captures" "$lists"
}
pane_contains() { admin capture-pane -p -t "$1" | grep -aFq "$2"; }
client_snapshot() { admin list-clients -F '#{client_tty} #{session_id} #{pane_id}' | awk -v tty="$1" '$1==tty {print $2 " " $3; exit}'; }
client_is() { [[ "$(client_snapshot "$1")" == "$2 $3" ]]; }
client_gone() { [[ -z "$(client_snapshot "$1")" ]]; }
pane_zoom() { admin display-message -p -t "$1" '#{window_zoomed_flag}'; }
log_target_time_since() {
  perl -e 'use strict;my($d,$after,$wanted,$target)=@ARGV;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$after;my$i=0;while($i<@v){if($v[$i]eq q(-S)||$v[$i]eq q(-f)){$i+=2;next}last}next unless($v[$i]//q())eq$wanted;for(;$i<@v-1;$i++){if($v[$i]eq q(-t)&&$v[$i+1]eq$target){print"$t\n";exit 0}}}exit 1' "$LOG" "$1" "$2" "$3"
}
log_has_target_since() { log_target_time_since "$@" >/dev/null; }
log_exact_switch_client_since() {
  local after="$1" tty="$2" pane="$3"
  perl -e 'use strict;my($d,$after,$tty,$pane)=@ARGV;my$n=0;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$after;@v==7&&$v[0]eq q(switch-client)&&$v[1]eq q(-Z)&&$v[2]eq q(-c)&&$v[3]eq$tty&&$v[4]eq q(-t)&&$v[5]eq$pane&&$v[6]eq q() and $n++}print"$n\n"' "$LOG" "$after" "$tty" "$pane"
}
task9_write() { local fd="${WRITER_FDS[${TASK9_CLIENT_INDEXES[$1]}]}"; printf '%b' "$2" >&"$fd"; }
task9_popup_open() { popup_open "${TASK9_CLIENT_INDEXES[$1]}"; }
task9_popup_closed() { popup_closed "${TASK9_CLIENT_INDEXES[$1]}"; }
task9_clear_causal_evidence() {
  admin set-option -gu @pane_dash_test_resize_complete 2>/dev/null || true
  admin set-option -gu @pane_dash_test_switch_saw_resize 2>/dev/null || true
  if [[ -n "$TASK9_HOOK_INDEX" ]]; then
    admin set-hook -gu "client-session-changed[$TASK9_HOOK_INDEX]" 2>/dev/null || true
    TASK9_HOOK_INDEX=''
  fi
}
task9_install_causal_hook() {
  task9_clear_causal_evidence
  TASK9_HOOK_INDEX="$((100000 + RANDOM))"
  admin set-hook -g "client-session-changed[$TASK9_HOOK_INDEX]" 'set-option -gF @pane_dash_test_switch_saw_resize "#{@pane_dash_test_resize_complete}"'
}
task9_option_value() { admin show-options -gv "$1" 2>/dev/null || true; }
task9_target_present() { target_present "${TASK9_TARGET_PANES[$1]}"; }
task9_target_gone() { target_gone "${TASK9_TARGET_PANES[$1]}"; }
task9_ansi_grew() { ansi_grew_from "${TASK9_CLIENT_INDEXES[$1]}" "$2"; }
task9_selected_preview() { log_has_target_since "$2" capture-pane "${TASK9_TARGET_PANES[$1]}"; }
task9_setup() {
  local name="$1" index="${#TASK9_SOURCE_SESSIONS[@]}" nonce="${RANDOM}${RANDOM}" source target source_pane target_pane client_index
  source="task9-source-${name}-${nonce}"; target="task9-target-${name}-${nonce}"
  admin new-session -d -s "$source" -x 120 -y 40 'exec cat'
  admin new-session -d -s "$target" -x 120 -y 40 'exec cat'
  source_pane="$(admin display-message -p -t "$source:0.0" '#{pane_id}')"
  target_pane="$(admin split-window -d -P -F '#{pane_id}' -t "$target:0" 'exec cat')"
  TASK9_SOURCE_SESSIONS[index]="$(admin display-message -p -t "$source_pane" '#{session_id}')"
  TASK9_TARGET_SESSIONS[index]="$(admin display-message -p -t "$target_pane" '#{session_id}')"
  TASK9_SOURCE_PANES[index]="$source_pane"; TASK9_TARGET_PANES[index]="$target_pane"
  TASK9_TAGS[index]="task9-${name}-${nonce}"
  admin set-option -p -t "$target_pane" @pane_dash_tag "${TASK9_TAGS[index]}"
  start_client "$source" "task9-${name}-${nonce}"
  client_index=$((${#CLIENT_PIDS[@]} - 1)); TASK9_CLIENT_INDEXES[index]="$client_index"
  client_is "${CLIENT_TTYS[client_index]}" "${TASK9_SOURCE_SESSIONS[index]}" "$source_pane" || die "task9 $name source identity"
  open_popup "$client_index"; task9_popup_open "$index" || die "task9 $name popup owner"
  [[ -n "${POPUP_CONTROLS[client_index]:-}" ]] || die "task9 $name control pid"
  wait_for "task9 $name frame" 3 ansi_has "$client_index" "${TASK9_TAGS[index]}"
  TASK9_INDEX="$index"
}
task9_select_target() {
  local index="$1" before started
  before="$(ansi_size "${TASK9_CLIENT_INDEXES[index]}")"
  task9_write "$index" "/${TASK9_TAGS[index]}"
  wait_for "task9 ${TASK9_TAGS[index]} filter applied" 2 task9_ansi_grew "$index" "$before"
  before="$(ansi_size "${TASK9_CLIENT_INDEXES[index]}")"
  task9_write "$index" '\033'
  wait_for "task9 ${TASK9_TAGS[index]} navigation mode" 2 task9_ansi_grew "$index" "$before"
  before="$(ansi_size "${TASK9_CLIENT_INDEXES[index]}")"
  task9_write "$index" j
  wait_for "task9 ${TASK9_TAGS[index]} session selected" 2 task9_ansi_grew "$index" "$before"
  started="$(now)"; task9_write "$index" j
  wait_for "task9 ${TASK9_TAGS[index]} selected preview" 2 task9_selected_preview "$index" "$started"
}
task9_close_popup() {
  local index="$1" client_index="${TASK9_CLIENT_INDEXES[$1]}" control="${POPUP_CONTROLS[${TASK9_CLIENT_INDEXES[$1]}]:-}"
  task9_popup_open "$index" || return 0
  task9_write "$index" q
  wait_for "task9 ${TASK9_TAGS[index]} pane-dash exit" 2 task9_popup_closed "$index"
  ! control_present "$control" || die "task9 ${TASK9_TAGS[index]} control survived pane-dash exit: $control"
  POPUP_CONTROLS[client_index]=''
}
task9_teardown() {
  local index="$1" client_index tty fd
  client_index="${TASK9_CLIENT_INDEXES[index]}"; tty="${CLIENT_TTYS[client_index]}"; fd="${WRITER_FDS[client_index]}"
  task9_close_popup "$index"
  eval "exec ${fd}>&-"
  kill -TERM "${CLIENT_PIDS[client_index]}" "${PRODUCER_PIDS[client_index]}" 2>/dev/null || true
  wait_for "task9 ${TASK9_TAGS[index]} client close" 2 client_gone "$tty"
  admin kill-session -t "${TASK9_SOURCE_SESSIONS[index]}" 2>/dev/null || true
  admin kill-session -t "${TASK9_TARGET_SESSIONS[index]}" 2>/dev/null || true
  rm -f "$TASK9_MARKER"; task9_clear_causal_evidence
}
task9_normal_enter() {
  local index client_index tty control popup_pid
  task9_setup normal; index="$TASK9_INDEX"; client_index="${TASK9_CLIENT_INDEXES[index]}"; tty="${CLIENT_TTYS[client_index]}"; control="${POPUP_CONTROLS[client_index]}"; popup_pid="${POPUP_PIDS[client_index]}"
  [[ "$(pane_zoom "${TASK9_TARGET_PANES[index]}")" == 0 ]] || die 'task9 normal target initially zoomed'
  task9_select_target "$index"; task9_write "$index" '\r'
  wait_for 'task9 normal exact client jump' 2 client_is "$tty" "${TASK9_TARGET_SESSIONS[index]}" "${TASK9_TARGET_PANES[index]}"
  wait_for 'task9 normal pane-dash exit' 2 task9_popup_closed "$index"
  [[ "$(pane_zoom "${TASK9_TARGET_PANES[index]}")" == 0 ]] || die 'task9 normal changed target zoom'
  ! control_present "$control" || die 'task9 normal control survived'
  printf 'task9 normal session=%s pane=%s zoom=0 control=%s popup-pid=%s closed\n' "${TASK9_TARGET_SESSIONS[index]}" "${TASK9_TARGET_PANES[index]}" "$control" "$popup_pid"
  task9_teardown "$index"
}
task9_zoom_jump() {
  local index client_index tty control popup_pid started
  task9_setup zoom; index="$TASK9_INDEX"; client_index="${TASK9_CLIENT_INDEXES[index]}"; tty="${CLIENT_TTYS[client_index]}"; control="${POPUP_CONTROLS[client_index]}"; popup_pid="${POPUP_PIDS[client_index]}"
  task9_select_target "$index"; task9_install_causal_hook
  [[ -z "$(task9_option_value @pane_dash_test_resize_complete)" && -z "$(task9_option_value @pane_dash_test_switch_saw_resize)" ]] || die 'task9 zoom causal markers were not cleared'
  printf 'causal %s\n' "${TASK9_TARGET_PANES[index]}" > "$TASK9_MARKER"
  started="$(now)"; task9_write "$index" '\032'
  wait_for 'task9 zoom resize invocation' 2 log_has_target_since "$started" resize-pane "${TASK9_TARGET_PANES[index]}"
  wait_for 'task9 zoom exact client jump' 2 client_is "$tty" "${TASK9_TARGET_SESSIONS[index]}" "${TASK9_TARGET_PANES[index]}"
  [[ ! -e "$TASK9_MARKER" ]] || die 'task9 zoom causal marker was not consumed'
  [[ "$(task9_option_value @pane_dash_test_switch_saw_resize)" == 1 ]] || die 'task9 zoom switch did not observe completed resize'
  [[ "$(pane_zoom "${TASK9_TARGET_PANES[index]}")" == 1 ]] || die 'task9 zoom target not zoomed'
  wait_for 'task9 zoom pane-dash exit' 2 task9_popup_closed "$index"
  ! control_present "$control" || die 'task9 zoom control survived'
  printf 'task9 zoom session=%s pane=%s zoom=1 control=%s popup-pid=%s closed resize-before-switch=verified\n' "${TASK9_TARGET_SESSIONS[index]}" "${TASK9_TARGET_PANES[index]}" "$control" "$popup_pid"
  task9_teardown "$index"
}
task9_killed_before_jump() {
  local index client_index tty control
  task9_setup killed-before; index="$TASK9_INDEX"; client_index="${TASK9_CLIENT_INDEXES[index]}"; tty="${CLIENT_TTYS[client_index]}"; control="${POPUP_CONTROLS[client_index]}"
  task9_select_target "$index"; kill -STOP "$control"; task9_target_present "$index" || die 'task9 killed-before target missing early'
  admin kill-pane -t "${TASK9_TARGET_PANES[index]}"; wait_for 'task9 killed-before target gone' 2 task9_target_gone "$index"
  task9_write "$index" '\r'; kill -CONT "$control"
  wait_for 'task9 killed-before control stays open' 2 task9_popup_open "$index"
  client_is "$tty" "${TASK9_SOURCE_SESSIONS[index]}" "${TASK9_SOURCE_PANES[index]}" || die 'task9 killed-before source changed'
  printf 'task9 killed-before source-session=%s source-pane=%s control=%s open\n' "${TASK9_SOURCE_SESSIONS[index]}" "${TASK9_SOURCE_PANES[index]}" "$control"
  task9_close_popup "$index"; task9_teardown "$index"
}
task9_killed_between_resize_and_switch() {
  local index client_index tty control
  task9_setup killed-between; index="$TASK9_INDEX"; client_index="${TASK9_CLIENT_INDEXES[index]}"; tty="${CLIENT_TTYS[client_index]}"; control="${POPUP_CONTROLS[client_index]}"
  [[ ! -e "$TASK9_MARKER" ]] || die 'task9 marker unexpectedly present'
  task9_select_target "$index"; printf 'kill %s %s\n' "${TASK9_TARGET_PANES[index]}" "${TASK9_TARGET_PANES[index]}" > "$TASK9_MARKER"
  task9_write "$index" '\032'
  wait_for 'task9 killed-between target gone' 2 task9_target_gone "$index"
  [[ ! -e "$TASK9_MARKER" ]] || die 'task9 marker was not consumed'
  wait_for 'task9 killed-between control stays open' 2 task9_popup_open "$index"
  client_is "$tty" "${TASK9_SOURCE_SESSIONS[index]}" "${TASK9_SOURCE_PANES[index]}" || die 'task9 killed-between source changed'
  control_present "$control" || die 'task9 killed-between control changed'
  printf 'task9 killed-between source-session=%s source-pane=%s target=%s gone control=%s open\n' "${TASK9_SOURCE_SESSIONS[index]}" "${TASK9_SOURCE_PANES[index]}" "${TASK9_TARGET_PANES[index]}" "$control"
  task9_close_popup "$index"; task9_teardown "$index"
}
task9_degraded_jump() {
  local index client_index tty initial_control replacement_control popup_pid reconnect_started degraded_started transcript_offset exited
  [[ ! -e "$REJECT" ]] || die 'task9 degraded inherited global reject marker'
  task9_setup degraded-jump; index="$TASK9_INDEX"; TASK9_DEGRADED_INDEX="$index"; client_index="${TASK9_CLIENT_INDEXES[index]}"; tty="${CLIENT_TTYS[client_index]}"; initial_control="${POPUP_CONTROLS[client_index]}"; popup_pid="${POPUP_PIDS[client_index]}"
  reconnect_started="$(now)"
  admin run-shell "kill -TERM $initial_control"
  wait_for 'task9 degraded exactly one replacement control' 3 popup_replaced "$client_index" "$initial_control"
  replacement_control="$(controls)"; POPUP_CONTROLS[client_index]="$replacement_control"
  popup_control_has_owner "$client_index" "$replacement_control" || die 'task9 degraded replacement parent changed popup pid'
  (( $(record_count "$reconnect_started" "$(now)" -C)==1 )) || die 'task9 degraded initial control did not get exactly one replacement spawn'
  transcript_offset="$(ansi_size "$client_index")"; degraded_started="$(now)"; : > "$REJECT"
  admin run-shell "kill -TERM $replacement_control"
  wait_for 'task9 degraded new banner' 3 ansi_tail_has "$client_index" "$((transcript_offset+1))" 'live updates lost — polling'
  wait_for 'task9 degraded no persistent control' 2 control_is_zero
  task9_select_target "$index"; task9_write "$index" '\r'
  wait_for 'task9 degraded exact normal client jump' 2 client_is "$tty" "${TASK9_TARGET_SESSIONS[index]}" "${TASK9_TARGET_PANES[index]}"
  (( $(log_exact_switch_client_since "$degraded_started" "$tty" "${TASK9_TARGET_PANES[index]}")==1 )) || die 'task9 degraded missing exact one-shot owner switch-client'
  control_is_zero || die 'task9 degraded control returned after jump'
  [[ "$(pane_zoom "${TASK9_TARGET_PANES[index]}")" == 0 ]] || die 'task9 degraded normal jump changed target zoom'
  wait_for 'task9 degraded pane-dash exit' 2 task9_popup_closed "$index"
  exited="$(now)"
  assert_no_popup_runtime_after_exit 'task9 degraded-jump' "$popup_pid" "$exited"
  ! control_present "$replacement_control" || die 'task9 degraded replacement control survived'
  rm -f "$REJECT" "$TASK9_MARKER"; REJECT=''; TASK9_MARKER=''; TASK9_DEGRADED_INDEX=''
  printf 'task9 degraded-jump session=%s pane=%s owner=%s control=%s popup-pid=%s controls=0 reconnects=1+rejected1 closed\n' "${TASK9_TARGET_SESSIONS[index]}" "${TASK9_TARGET_PANES[index]}" "$tty" "$replacement_control" "$popup_pid"
  task9_teardown "$index"
}
task9_scenarios() {
  task9_normal_enter
  task9_zoom_jump
  task9_killed_before_jump
  task9_killed_between_resize_and_switch
  task9_degraded_jump
}

destroy_popup_setup() { # detach-on-destroy value label
  local mode="$1" label="$2" source pane index
  source="destroy-source-${label}-${RANDOM}${RANDOM}"
  admin new-session -d -s "$source" -x 120 -y 40 'exec cat'
  admin set-option -t "$source" detach-on-destroy "$mode"
  pane="$(admin display-message -p -t "$source:0.0" '#{pane_id}')"
  admin set-option -p -t "$pane" @pane_dash_tag "destroy-${label}"
  start_client "$source" "destroy-${label}"
  index=$((${#CLIENT_PIDS[@]} - 1))
  open_popup "$index"
  wait_for "destroy ${label} popup frame" 3 ansi_has "$index" "destroy-${label}"
  DESTROY_SOURCE="$source" DESTROY_INDEX="$index" DESTROY_TTY="${CLIENT_TTYS[index]}" DESTROY_CONTROL="${POPUP_CONTROLS[index]}" DESTROY_POPUP_PID="${POPUP_PIDS[index]}"
}

destroy_popup_detach_off() {
  local before started exited
  destroy_popup_setup off off
  before="$(record_count "$(now)" "$(now)" -C)"
  started="$(now)"
  admin kill-session -t "$DESTROY_SOURCE"
  wait_for 'destroy off pane-dash exits <=2s' 2 popup_closed "$DESTROY_INDEX"
  exited="$(now)"
  ! control_present "$DESTROY_CONTROL" || die 'destroy off control survived'
  ! client_gone "$DESTROY_TTY" || die 'destroy off normal client detached'
  [[ -n "$(client_snapshot "$DESTROY_TTY")" ]] || die 'destroy off normal client was not reassigned'
  (( $(record_count "$started" "$exited" -C)==before )) || die 'destroy off attempted control reconnect'
  sleep .2
  (( $(runtime_count "$exited" "$(now)")==0 )) || die 'destroy off popup runtime work after pane-dash exit'
  printf 'destroy-off popup-pid=%s closed<=2s control=%s normal-client=%s reassigned=%s reconnects=0 runtime=0\n' "$DESTROY_POPUP_PID" "$DESTROY_CONTROL" "$DESTROY_TTY" "$(client_snapshot "$DESTROY_TTY")"
}

destroy_popup_detach_on() {
  destroy_popup_setup on on
  admin kill-session -t "$DESTROY_SOURCE"
  wait_for 'destroy on pane-dash exits <=2s' 2 popup_closed "$DESTROY_INDEX"
  wait_for 'destroy on exact normal client detaches' 2 client_gone "$DESTROY_TTY"
  ! control_present "$DESTROY_CONTROL" || die 'destroy on control survived'
  printf 'destroy-on popup-pid=%s closed<=2s control=%s client=%s detached\n' "$DESTROY_POPUP_PID" "$DESTROY_CONTROL" "$DESTROY_TTY"
}

destroy_popup_while_degraded() {
  local started exited
  destroy_popup_setup off degraded
  : > "$REJECT"
  admin run-shell "kill -TERM $DESTROY_CONTROL"
  wait_for 'destroy degraded banner' 3 ansi_has "$DESTROY_INDEX" 'live updates lost — polling'
  wait_for 'destroy degraded no control' 2 control_is_zero
  started="$(now)"
  admin kill-session -t "$DESTROY_SOURCE"
  wait_for 'destroy degraded pane-dash exits <=1.1s' 1.1 popup_closed "$DESTROY_INDEX"
  exited="$(now)"
  assert_no_popup_runtime_after_exit 'destroy-degraded' "$DESTROY_POPUP_PID" "$exited"
  ! client_gone "$DESTROY_TTY" || die 'destroy degraded normal client detached'
  rm -f "$REJECT"
  printf 'destroy-degraded popup-pid=%s closed<=1.1s control=%s\n' "$DESTROY_POPUP_PID" "$DESTROY_CONTROL"
}

unrelated_session_changes_keep_popup_open() {
  local source pane index unrelated
  source="unrelated-source-${RANDOM}${RANDOM}"; unrelated="unrelated-other-${RANDOM}${RANDOM}"
  admin new-session -d -s "$source" 'exec cat'; admin new-session -d -s "$unrelated" 'exec cat'
  pane="$(admin display-message -p -t "$source:0.0" '#{pane_id}')"
  admin set-option -p -t "$pane" @pane_dash_tag unrelated-source
  start_client "$source" unrelated
  index=$((${#CLIENT_PIDS[@]} - 1)); open_popup "$index"; wait_for 'unrelated popup frame' 3 ansi_has "$index" unrelated-source
  admin rename-session -t "$source" "${source}-renamed"
  sleep .2; popup_open "$index" || die 'source session rename closed popup'
  admin kill-session -t "$unrelated"
  sleep .2; popup_open "$index" || die 'unrelated session kill closed popup'
  close_popup "$index"; admin kill-session -t "${source}-renamed"
  printf 'unrelated-kill/source-rename popup remained open\n'
}

# Phase 5 drives the installed production binding.  The wrapper gate blocks
# only stage-1 creation clients, so wrapper argv and tmux state are stronger
# evidence than repaint timing for creation sequencing.
creation_gate_begin() {
  [[ -z "$CREATION_GATE" ]] || rm -rf "$CREATION_GATE"
  CREATION_GATE="$TMP/creation-gate-${RANDOM}${RANDOM}"
  mkdir -p "$CREATION_GATE"
  admin set-environment -g PD_CREATION_GATE "$CREATION_GATE"
}
creation_gate_release() { : > "$CREATION_GATE/release"; }
creation_gate_started() { [[ -e "$CREATION_GATE/started" ]]; }
creation_control_argv_count_since() {
  perl -e 'use strict;my($d,$after)=@ARGV;my$n=0;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$after;my$i=0;while($i<@v&&($v[$i]eq q(-S)||$v[$i]eq q(-f))){$i+=2}next unless($v[$i]//q())=~/^(?:new-session|new-window|split-window|set-option|send-keys)$/;$n++ if grep {$_ eq q(-C)} @v}print"$n\n"' "$LOG" "$1"
}
creation_target_since() {
  perl -e 'use strict;my($d,$after)=@ARGV;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$after;my$i=0;while($i<@v&&($v[$i]eq q(-S)||$v[$i]eq q(-f))){$i+=2}next unless($v[$i]//q())eq q(set-option);for(;$i<@v-1;$i++){if($v[$i]eq q(-t)){print "$v[$i+1]\n";exit}}}exit 1' "$LOG" "$1"
}
creation_tag_count_since() {
  perl -e 'use strict;my($d,$after)=@ARGV;my$n=0;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$after;my$i=0;while($i<@v&&($v[$i]eq q(-S)||$v[$i]eq q(-f))){$i+=2}next unless($v[$i]//q())eq q(set-option);$n++ if ((grep {$_ eq q(@pane_dash_tag)} @v) && (grep {$_ eq q(dash-created)} @v))}print"$n\n"' "$LOG" "$1"
}
creation_no_control_argv_since() { (( $(creation_control_argv_count_since "$1")==0 )); }
creation_setup() { # label; expects any creation gate/failure setting before call
  local label="$1" source pane
  if [[ -n "$CREATION_GATE" ]]; then admin set-environment -g PD_CREATION_GATE "$CREATION_GATE"; else admin set-environment -gu PD_CREATION_GATE 2>/dev/null || true; fi
  if [[ -n "$CREATION_FAIL_STAGE" ]]; then admin set-environment -g PD_CREATION_FAIL_STAGE "$CREATION_FAIL_STAGE"; else admin set-environment -gu PD_CREATION_FAIL_STAGE 2>/dev/null || true; fi
  if [[ -n "$CREATION_GONE" ]]; then admin set-environment -g PD_CREATION_GONE "$CREATION_GONE"; else admin set-environment -gu PD_CREATION_GONE 2>/dev/null || true; fi
  source="creation-${label}-${RANDOM}${RANDOM}"
  admin new-session -d -s "$source" -x 120 -y 40 'exec cat'
  pane="$(admin display-message -p -t "$source:0.0" '#{pane_id}')"
  admin set-option -p -t "$pane" @pane_dash_tag "creation-${label}"
  admin set-option -g @pane-dash-new-command ''
  start_client "$source" "creation-${label}"
  CREATION_SOURCE="$source" CREATION_PANE="$pane" CREATION_INDEX=$((${#CLIENT_PIDS[@]} - 1))
  open_popup "$CREATION_INDEX"
  send_bytes "$CREATION_INDEX" j; send_bytes "$CREATION_INDEX" j
}
creation_open_first_split_form() {
  local index="$1" before
  before="$(ansi_size "$index")"; send_bytes "$index" n
  wait_for 'creation choice modal' 2 ansi_grew_from "$index" "$before"
  ansi_tail_has "$index" "$((before+1))" 'Split right' || die 'creation choice missing split-right context'
  send_bytes "$index" '\r'
}
creation_submit_first_split() { send_bytes "$1" '\r'; }
creation_choice_order_and_context() {
  local index before offset started
  creation_setup choices; index="$CREATION_INDEX"; before="$(ansi_size "$index")"
  send_bytes "$index" n; wait_for 'creation choices frame' 2 ansi_grew_from "$index" "$before"; offset="$((before+1))"
  for label in 'Split right' 'Split left' 'Split bottom' 'Split top' 'New window' 'New session'; do
    ansi_tail_has "$index" "$offset" "$label" || die "creation choices missing $label"
  done
  local ordered
  ordered="$(tail -c "+$offset" "${TRANSCRIPTS[index]}" | tr '\n' ' ')"
  [[ "${ordered%%Split right*}" != "$ordered" && "${ordered#*Split right}" == *'Split left'* && "${ordered#*Split left}" == *'Split bottom'* && "${ordered#*Split bottom}" == *'Split top'* && "${ordered#*Split top}" == *'New window'* && "${ordered#*New window}" == *'New session'* ]] || die 'creation choice order/context'
  started="$(now)"; send_bytes "$index" '\r'; send_bytes "$index" '\r'
  wait_for 'creation choice exact first argv' 3 creation_target_since "$started"
  (( $(record_count "$started" "$(now)" split-window)==1 )) || die 'creation choice first selection was not split-right'
  close_popup "$index"
  printf 'creation choices pane-context exact-order=right,left,bottom,top,window,session\n'
}
creation_success_responsive() {
  local index nav_index started target after nav_before snapshot_before
  creation_gate_begin; creation_setup success; index="$CREATION_INDEX"; creation_open_first_split_form "$index"
  started="$(now)"; creation_submit_first_split "$index"; wait_for 'creation pending gate' 2 creation_gate_started
  wait_for 'creation pending row' 2 ansi_has "$index" 'creating...'
  # A second popup proves navigation, preview capture, and 1s snapshots remain
  # live while the first popup holds a real creation subprocess.
  start_client "$CREATION_SOURCE" creation-navigation; nav_index=$((${#CLIENT_PIDS[@]} - 1)); open_popup "$nav_index"
  send_bytes "$nav_index" j; nav_before="$(ansi_size "$nav_index")"; after="$(now)"; send_bytes "$nav_index" j
  wait_for 'creation held navigation render' 2 ansi_grew_from "$nav_index" "$nav_before"
  wait_for 'creation held navigation preview' .5 has_capture_since "$after"
  snapshot_before="$(ansi_size "$nav_index")"
  admin set-option -p -t "$CREATION_PANE" @pane_dash_tag creation-held-snapshot
  wait_for 'creation held snapshot render' 1.1 ansi_grew_from "$nav_index" "$snapshot_before"
  creation_gate_release; wait_for 'creation tag target' 3 creation_target_since "$started"; target="$(creation_target_since "$started")"
  wait_for 'creation target tagged' 3 pane_contains "$target" ''
  [[ "$(admin show-options -pv -t "$target" @pane_dash_tag)" == dash-created ]] || die 'creation success tag missing'
  (( $(record_count "$started" "$(now)" split-window)==1 )) || die 'creation success replayed stage 1'
  (( $(creation_tag_count_since "$started")==1 )) || die 'creation success tag count'
  creation_no_control_argv_since "$started" || die 'creation argv used persistent control stdin'
  close_popup "$nav_index"; wait_for 'creation pending clears' 3 popup_open "$index"
  budget 'creation success follow' 10 0
  close_popup "$index"
  printf 'creation success pending-immediate responsive=nav+preview+snapshot target=%s argv=create,tag once control=0 closed\n' "$target"
}
creation_stage1_retry() {
  local index started target
  CREATION_GATE=''; CREATION_FAIL_STAGE=''; creation_setup retry; index="$CREATION_INDEX"
  send_bytes "$index" n; send_bytes "$index" j; send_bytes "$index" j; send_bytes "$index" j; send_bytes "$index" j; send_bytes "$index" j; send_bytes "$index" '\r'
  started="$(now)"; send_bytes "$index" "$CREATION_SOURCE"; send_bytes "$index" '\r'
  wait_for 'creation retry stage-1 error' 3 ansi_has "$index" 'duplicate session'
  popup_open "$index" || die 'stage-1 retry closed popup'
  send_bytes "$index" '-retry'; send_bytes "$index" '\r'
  wait_for 'creation retry tag' 3 creation_target_since "$started"; target="$(creation_target_since "$started")"
  [[ "$(admin show-options -pv -t "$target" @pane_dash_tag)" == dash-created ]] || die 'stage-1 retry never created corrected request'
  (( $(record_count "$started" "$(now)" new-session)==2 )) || die 'stage-1 retry creation count/correlation'
  (( $(creation_tag_count_since "$started")==1 )) || die 'stage-1 failure ran an unintended generation'
  creation_no_control_argv_since "$started" || die 'stage-1 retry used persistent control stdin'
  close_popup "$index"
  printf 'creation stage1 duplicate stayed-modal retry=monotonic two-create-one-tag target=%s\n' "$target"
}
creation_tag_failure_and_gone() {
  local index started target offset
  CREATION_GATE=''; CREATION_FAIL_STAGE=tag; creation_setup tag-failure; index="$CREATION_INDEX"; creation_open_first_split_form "$index"
  started="$(now)"; creation_submit_first_split "$index"; wait_for 'creation tag failure target' 3 creation_target_since "$started"; target="$(creation_target_since "$started")"
  wait_for 'creation tag failure toast' 3 ansi_has "$index" 'tagging failed'
  ansi_has "$index" "$target" || die 'tag failure did not expose live ephemeral pane'
  [[ -z "$(admin show-options -pv -t "$target" @pane_dash_tag 2>/dev/null || true)" ]] || die 'tag failure unexpectedly tagged pane'
  offset="$(ansi_size "$index")"; admin kill-pane -t "$target"; wait_for 'tag failure target gone' 2 target_gone "$target"
  wait_for 'tag failure prune redraw' 1.1 ansi_grew_from "$index" "$offset"; send_bytes "$index" '\014'
  ! ansi_tail_has "$index" "$((offset+1))" "$target" || die 'dead ephemeral pane survived raw snapshot prune'
  (( $(record_count "$started" "$(now)" send-keys)==0 )) || die 'tag failure ran later stage'
  CREATION_FAIL_STAGE=''; close_popup "$index"
  printf 'creation tag-failure ephemeral=%s live-only raw-pruned later-stages=0\n' "$target"
}
creation_created_then_gone() {
  local index started
  CREATION_GATE=''; CREATION_FAIL_STAGE=''; CREATION_GONE=1
  creation_setup gone; index="$CREATION_INDEX"; creation_open_first_split_form "$index"; started="$(now)"; creation_submit_first_split "$index"
  wait_for 'creation gone toast' 3 ansi_has "$index" 'pane exited before tagging'
  (( $(record_count "$started" "$(now)" send-keys)==0 )) || die 'created-then-gone ran later stage'
  ! ansi_has "$index" 'tagging failed' || die 'created-then-gone made ephemeral toast'
  CREATION_GONE=''; close_popup "$index"
  printf 'creation created-then-gone no-ephemeral exited-toast later-stages=0\n'
}
creation_concurrent_isolation() {
  local a b started
  creation_gate_begin; creation_setup concurrent-a; a="$CREATION_INDEX"; creation_open_first_split_form "$a"
  creation_setup concurrent-b; b="$CREATION_INDEX"; creation_open_first_split_form "$b"
  started="$(now)"; creation_submit_first_split "$a"; creation_submit_first_split "$b"
  wait_for 'concurrent creation gates' 2 creation_gate_started; wait_for 'concurrent pending a' 2 ansi_has "$a" 'creating...'; wait_for 'concurrent pending b' 2 ansi_has "$b" 'creating...'
  creation_gate_release; wait_for 'concurrent creation tags' 3 creation_target_since "$started"
  (( $(record_count "$started" "$(now)" split-window)==2 )) || die 'concurrent popup creation count'
  (( $(creation_tag_count_since "$started")==2 )) || die 'concurrent popup tag count'
  creation_no_control_argv_since "$started" || die 'concurrent creation used persistent control stdin'
  if ! popup_open "$a" || ! popup_open "$b"; then die 'concurrent workflow crossed popup lifecycle'; fi
  close_popup "$a"; close_popup "$b"
  printf 'creation concurrent popups=2 isolated-create=2 isolated-tag=2 control=0 closed\n'
}
creation_quit_reaps_blocked_stage() {
  local index started popup_pid
  creation_gate_begin; creation_setup quit; index="$CREATION_INDEX"; popup_pid="${POPUP_PIDS[index]}"; creation_open_first_split_form "$index"; started="$(now)"; creation_submit_first_split "$index"
  wait_for 'creation quit gate' 2 creation_gate_started; send_bytes "$index" q
  wait_for 'creation quit popup exit' 2 popup_closed "$index"
  (( $(record_count "$started" "$(now)" split-window)==1 )) || die 'creation quit stage-1 count'
  (( $(creation_tag_count_since "$started")==0 && $(record_count "$started" "$(now)" send-keys)==0 )) || die 'creation quit ran a later stage'
  creation_no_control_argv_since "$started" || die 'creation quit used persistent control stdin'
  assert_no_popup_runtime_after_exit 'creation quit-blocked' "$popup_pid" "$(now)"
  printf 'creation quit blocked-stage popup=%s later-stages=0 control=0 closed\n' "$popup_pid"
}

creation_scenarios() {
  creation_choice_order_and_context
  creation_success_responsive
  creation_stage1_retry
  creation_tag_failure_and_gone
  creation_created_then_gone
  creation_concurrent_isolation
  creation_quit_reaps_blocked_stage
}

main() {
  [[ -x "$BIN" ]] || die "missing $BIN; run make build"
  if ! command -v perl >/dev/null || ! command -v script >/dev/null; then die 'perl and script required'; fi
  perl -e 'exit($ARGV[0]=~/^(\d+)\.(\d+)/&&($1>3||$1==3&&$2>=6)?0:1)' "$($REAL_TMUX -V|awk '{print $2}')" || die 'tmux >=3.6 required'
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/pane-dash-live.XXXXXXXX")"; SOCKET="$TMP/socket"; WRAP="$TMP/wrap"; LOG="$TMP/log"; REJECT="$TMP/reject"; make_wrapper
  TMUX='' "$REAL_TMUX" -S "$SOCKET" -f /dev/null new-session -d -s live -x 120 -y 40 'exec cat'
  admin new-session -d -s other -x 120 -y 40 'exec cat'
  local pane target startup old_control t before after captures
  pane="$(admin display-message -p -t live:0.0 '#{pane_id}')"; target="$(admin split-window -d -P -F '#{pane_id}' -t live:0 'exec cat')"
  admin set-option -g @pane-dash-engine rust; admin set-option -g @pane-dash-width 100%; admin set-option -g @pane-dash-height 100%; admin set-option -p -t "$pane" @pane_dash_tag live-test; admin set-option -p -t "$target" @pane_dash_tag live-spare
  TASK9_MARKER="$TMP/task9-marker"
  admin set-environment -g PATH "$WRAP:$PATH"; admin set-environment -g PD_REAL_TMUX "$REAL_TMUX"; admin set-environment -g PD_SOCKET "$SOCKET"; admin set-environment -g PD_LOG "$LOG"; admin set-environment -g PD_REJECT "$REJECT"; admin set-environment -g PD_TASK9_MARKER "$TASK9_MARKER"
  # Install pane_dash.tmux through the wrapper; do not directly run pane-dash.
  PATH="$WRAP:$PATH" PD_REAL_TMUX="$REAL_TMUX" PD_SOCKET="$SOCKET" PD_LOG="$LOG" PD_REJECT="$REJECT" TMUX='' "$ROOT/pane_dash.tmux"
  [[ "$(admin show-options -gv focus-events)" == on ]] || die 'production plugin did not enable focus-events'
  terminal_features="$(admin show-options -sv terminal-features)"
  grep -Fxq '*:focus' <<< "$terminal_features" || die 'production plugin did not enable terminal focus feature'
  start_client live first; start_client live second
  [[ -n "${CLIENT_PIDS[0]:-}" && -n "${CLIENT_TTYS[0]:-}" && -n "${CLIENT_PIDS[1]:-}" && -n "${CLIENT_TTYS[1]:-}" ]] || die 'client identity mapping'
  open_popup 0; [[ -n "${POPUP_CONTROLS[0]:-}" && -n "${POPUP_PIDS[0]:-}" ]] || die 'first popup owner mapping'; wait_for 'first popup frame' 3 ansi_has 0 live-test; (( $(control_count)==1 )) || die 'first popup control count'
  open_popup 1; [[ -n "${POPUP_CONTROLS[1]:-}" && "${POPUP_CONTROLS[0]}" != "${POPUP_CONTROLS[1]}" && -n "${POPUP_PIDS[1]:-}" && "${POPUP_PIDS[0]}" != "${POPUP_PIDS[1]}" ]] || die 'independent popup control/pid mapping'; wait_for 'independent popup controls' 3 has_two_controls
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
  # Subscription changes converge within one second, so the first owner may
  # contribute up to two captures before it observes FocusOut.
  send_bytes 0 '\033[O'; t="$(now)"; budget 'focus-out first owner only second follows' 12 0; captures="$(record_count "$t" "$(now)" capture-pane)"; ((captures>=9)) || die 'second popup did not continue during first focus-out'
  close_popup 1; wait_for 'second popup independent close' 2 popup_is_only_control 0
  budget 'focus-out after convergence' 0 0
  t="$(now)"; send_bytes 0 '\033[I'; wait_for 'focus-in preview <=1.1s' 1.1 has_capture_since "$t"; focus_in_ms="$(elapsed_ms "$t")"; printf 'focus-in terminal-to-resumed-capture=%sms subscription-convergence<=1000ms immediate-on-relay\n' "$focus_in_ms"; budget 'healthy follow' 10 0
  (( $(record_count "$startup" "$(now)" show-options)==0 )) || die 'runtime show-options'
  old_control="${POPUP_CONTROLS[0]}"; admin run-shell "kill -TERM $old_control"; wait_for 'single replacement control with same popup parent' 3 popup_replaced 0 "$old_control"; POPUP_CONTROLS[0]="$(controls)"; popup_control_has_owner 0 "${POPUP_CONTROLS[0]}" || die 'healthy replacement parent changed popup pid'; t="$(now)"; : > "$REJECT"; admin run-shell "kill -TERM ${POPUP_CONTROLS[0]}"
  wait_for 'degraded banner' 3 ansi_has 0 'live updates lost — polling'; wait_for 'degraded list-panes' 2 has_list_since "$t"; wait_for 'no persistent control after rejected reconnect' 2 control_is_zero
  budget 'degraded follow' 10 5; send_bytes 0 '\025'; budget 'degraded inspect' 0 5
  # Status publishers write a coherent triple. A bare status is deliberately
  # stale, so it must not be used as evidence for degraded polling.
  local epoch status_offset
  epoch="$(date +%s)"; t="$(now)"; status_offset="$(ansi_size 0)"
  admin set-option -p -t "$pane" @pane_dash_status idle
  admin set-option -p -t "$pane" @pane_dash_status_since "$epoch"
  admin set-option -p -t "$pane" @pane_dash_heartbeat "$epoch"
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
   send_bytes 0 q; wait_for 'healthy popup pane-dash exit' 2 popup_closed 0; t="$(now)"; ! control_present "${POPUP_CONTROLS[0]}" || die 'healthy popup control survived pane-dash exit'; sleep .2; (( $(runtime_count "$t" "$(now)")==0 )) || die 'closed popup runtime work'
   rm -f "$REJECT"
   unrelated_session_changes_keep_popup_open
   destroy_popup_detach_off
    destroy_popup_detach_on
    destroy_popup_while_degraded
    task9_scenarios
    creation_scenarios
   printf 'ok: controls startup=2 replacement=1 rejected=1; process budgets passed\n'
}
session_gone() { ! admin has-session -t "$1" 2>/dev/null; }
control_is_zero() { (( $(control_count)==0 )); }
popup_pid_tracking_self_test() {
  local popup_pid
  sleep 5 & popup_pid=$!
  # shellcheck disable=SC2329 # popup_closed invokes this test override indirectly.
  control_present() { return 1; }
  pane_dash_process() { pid_is_alive "$1"; }
  POPUP_CONTROLS[0]=999999
  POPUP_PIDS[0]="$popup_pid"
  if popup_closed 0; then
    kill "$popup_pid" 2>/dev/null || true
    wait "$popup_pid" 2>/dev/null || true
    printf 'RED: control-only popup_closed passed while popup pid=%s remained alive\n' "$popup_pid" >&2
    return 1
  fi
  kill "$popup_pid" 2>/dev/null || true
  wait "$popup_pid" 2>/dev/null || true
}

resize_timestamp_ordering_self_test() {
  local resize_observed_at=10 switch_observed_at=11
  if perl -e 'exit(($ARGV[0] < $ARGV[1]) ? 0 : 1)' "$resize_observed_at" "$switch_observed_at"; then
    printf 'RED: observed timestamp ordering passes without proving switch observed resize completion\n'
    return 0
  fi
  return 1
}

if [[ "${1:-}" == --popup-pid-self-test ]]; then
  popup_pid_tracking_self_test
  exit
fi

if [[ "${1:-}" == --resize-timestamp-ordering-self-test ]]; then
  resize_timestamp_ordering_self_test
  exit
fi

main "$@"
