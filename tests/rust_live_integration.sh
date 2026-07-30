#!/usr/bin/env bash
# Real-tmux process harness.  It is intentionally isolated from a user's tmux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/spike/lib.sh"
REAL_TMUX="$(command -v "$TMUX_BIN")"
BIN="$ROOT/bin/pane-dash"
TMP='' SOCKET='' WRAP='' LOG='' OWNER_LOG='' REJECT='' TASK9_MARKER='' TASK9_DEGRADED_INDEX='' TASK9_HOOK_INDEX=''
PHASE6_XDG_WAS_SET=0 PHASE6_XDG_VALUE='' PHASE6_RGB_SET=0 PHASE6_TERMINAL_FEATURES_BEFORE=''
CREATION_GATE='' CREATION_TOKEN='' CREATION_FAIL_STAGE='' CREATION_GONE='' CREATION_NEW_COMMAND='' CREATION_POPUP_WORK_OFFSET=0 FAILED=0
declare -a CLIENT_PIDS=() CLIENT_TTYS=() PRODUCER_PIDS=() WRITER_FDS=() WRITER_SLOTS=() OPEN_WRITER_SLOTS=()
declare -a TRANSCRIPTS=() SESSIONS=() LABELS=() POPUP_CONTROLS=() POPUP_PIDS=()
declare -a TASK9_SOURCE_SESSIONS=() TASK9_TARGET_SESSIONS=() TASK9_SOURCE_PANES=() CREATION_GATES=()
declare -a TASK9_TARGET_PANES=() TASK9_TAGS=() TASK9_CLIENT_INDEXES=()
declare -a CREATION_SOURCE_TAGS=() CREATION_SOURCE_SESSIONS=()

die() { FAILED=1; printf 'FAIL: %s\n' "$*" >&2; diagnostics >&2 || true; exit 1; }
admin() { TMUX='' "$REAL_TMUX" -S "$SOCKET" "$@"; }
now() { perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'printf "%.9f",clock_gettime(CLOCK_MONOTONIC)'; }
elapsed_ms() { perl -e 'printf "%.0f", ($ARGV[1] - $ARGV[0]) * 1000' "$1" "$(now)"; }
cleanup() {
  set +e
  local fd pid token wrapper gate records_valid
  task9_clear_causal_evidence
  phase6_restore_xdg || true
  phase6_restore_rgb || true
  if [[ -n "$TASK9_MARKER" ]]; then rm -f "$TASK9_MARKER"; TASK9_MARKER=''; fi
  if [[ -n "$REJECT" ]]; then rm -f "$REJECT"; REJECT=''; fi
  for gate in "${CREATION_GATES[@]:-}"; do
    [[ -d "$gate" ]] || continue
    if [[ -f "$gate/pids" ]]; then
      records_valid=1
      while read -r pid token wrapper; do
        creation_gate_wrapper_matches "$gate" "$pid" "$token" "$wrapper" || { records_valid=0; break; }
      done < "$gate/pids"
      if (( records_valid )); then
        while read -r pid token wrapper; do kill -TERM "$pid" 2>/dev/null || true; done < "$gate/pids"
      fi
      rm -f "$gate/pids"
    fi
    (( FAILED )) || rm -rf "$gate"
  done
  CREATION_GATES=(); CREATION_GATE=''
  if [[ -n "$TASK9_DEGRADED_INDEX" ]]; then TASK9_DEGRADED_INDEX=''; fi
  for fd in "${WRITER_FDS[@]:-}"; do eval "exec ${fd}>&-"; done
  for pid in "${POPUP_CONTROLS[@]:-}" "${CLIENT_PIDS[@]:-}" "${PRODUCER_PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  admin kill-server 2>/dev/null
  if (( FAILED )); then
    printf 'diagnostic artifacts retained: %s\n' "$TMP" >&2
  else
    [[ -z "$TMP" ]] || rm -rf "$TMP"
  fi
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
ansi_tail_compact_has() { # index offset canonical-text; normalize terminal-diff escapes and skipped spaces.
  tail -c "+$2" "${TRANSCRIPTS[$1]}" | perl -0777 -pe 's/\e\[[0-?]*[ -\/]*[@-~]//g; s/\e\][^\a\e]*(?:\a|\e\\)//g; s/\s+//g' | grep -aFq "$(tr -d '[:space:]' <<< "$3")"
}
ansi_tail_has_rgb() { # index offset r g b; accepts standard semicolon/colon SGR forms.
  local index="$1" offset="$2" red="$3" green="$4" blue="$5"
  tail -c "+$offset" "${TRANSCRIPTS[index]}" | perl -0777 -e '$_=<STDIN>;my($r,$g,$b)=@ARGV;exit !/\e\[[^m]*?(?:38;2;$r;$g;${b}|38:2::?$r:$g:${b})(?:;[0-9:]+)*m/' "$red" "$green" "$blue"
}
write_bytes() { local fd="${WRITER_FDS[$1]}"; printf '%b' "$2" >&"$fd"; }
open_writer() {
  local fifo="$2" slot
  for slot in {0..31}; do
    [[ -z "${OPEN_WRITER_SLOTS[slot]:-}" ]] || continue
    WRITER_FD=$((9 + slot))
    printf -v writer_command 'exec %s>%q' "$WRITER_FD" "$fifo"
    eval "$writer_command"
    OPEN_WRITER_SLOTS[slot]=1
    WRITER_FD_SLOT="$slot"
    return 0
  done
  die "too many live clients for the portable writer descriptor table"
}
popup_tail_has() { # popup offset text
  popup_open "$1" && ansi_tail_has "$1" "$2" "$3"
}
# Count the command word, not an arbitrary matching argv element: target text is
# untrusted and may itself contain words such as "capture-pane".
record_count() { perl -e 'use strict;my($d,$a,$b,$wanted)=@ARGV;my$n=0;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$a||$t>$b;while(@v){my$x=shift@v;if($x eq q(-S)||$x eq q(-f)){shift@v;next}if($x eq q(-C)){if($wanted eq q(-C)){$n++}next}if($x eq $wanted){$n++}last}}print"$n\n"' "$LOG" "$1" "$2" "$3"; }
phase6_read_only_classes_since() { # timestamp: report only permitted scheduled runtime reads.
  perl -e 'use strict;my($d,$after)=@ARGV;my%seen;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$after;my$i=0;while($i<@v&&($v[$i]eq q(-S)||$v[$i]eq q(-f))){$i+=2}next if$i>=@v;my$c=$v[$i];$seen{$c}++;}for my$c(sort keys%seen){print "$c=$seen{$c}\n";exit 1 unless$c eq q(capture-pane)||$c eq q(list-panes)}' "$LOG" "$1"; }
has_capture_since() { (( $(record_count "$1" "$(now)" capture-pane)>0 )); }
has_list_since() { (( $(record_count "$1" "$(now)" list-panes)>0 )); }
budget() { local tag="$1" cap="$2" list="$3" a b c l; a="$(now)"; sleep 5; b="$(now)"; c="$(record_count "$a" "$b" capture-pane)"; l="$(record_count "$a" "$b" list-panes)"; printf 'budget %s capture=%s list=%s\n' "$tag" "$c" "$l"; ((c<=cap&&l<=list)) || die "$tag process budget"; }

make_wrapper() {
  mkdir -p "$WRAP" "$LOG"
  cat > "$WRAP/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
gate_wrapper_token=''
gate_wrapper_path=''
if [[ "${1:-}" == --pane-dash-gate-token ]]; then
  gate_wrapper_token="${2:?missing gate wrapper token}"
  [[ "${3:-}" == --pane-dash-gate-path ]] || { echo 'missing gate wrapper path flag' >&2; exit 79; }
  gate_wrapper_path="${4:?missing gate wrapper path}"
  shift 4
fi
args=("$@"); [[ -n "${TMUX:-}" ]] || args=(-S "$PD_SOCKET" "${args[@]}")
command_index=0
  while (( command_index < ${#args[@]} )); do
    case "${args[command_index]}" in
      -S|-f) ((command_index += 2)) ;;
      *) break ;;
    esac
  done
  command_name="${args[command_index]:-}"
if [[ -n "${PD_CREATION_GATE:-}" && -z "$gate_wrapper_token" && ( "$command_name" == new-session || "$command_name" == new-window || "$command_name" == split-window ) ]]; then
  exec "$0" --pane-dash-gate-token "${PD_CREATION_TOKEN:?missing creation token}" --pane-dash-gate-path "$PD_CREATION_GATE" "$@"
fi
f="$(mktemp "$PD_LOG/invocation.XXXXXXXX")"
  perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'my$f=shift;open my$o,">",$f or die$!;binmode$o;printf $o "%.9f\0",clock_gettime(CLOCK_MONOTONIC);print $o join("\0",@ARGV),"\0"' "$f" "${args[@]}"
  target=''
  for ((i=0; i<${#args[@]}-1; i++)); do [[ "${args[i]}" != -t ]] || { target="${args[i+1]}"; break; }; done
  if [[ "$command_name" == -C ]]; then
    owner_class=control; owner_command=control
  else
    owner_command="$command_name"
    case "$command_name" in capture-pane|list-panes|show-options|show-option) owner_class=read ;; *) owner_class=action ;; esac
  fi
  owner_record="$(perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'printf "%.9f",clock_gettime(CLOCK_MONOTONIC)')"$'\t'"$$"$'\t'"$PPID"$'\t'"$owner_command"$'\t'"$target"$'\t'"$owner_class"
  # A single sub-PIPE_BUF append follows complete construction; readers never
  # use partial records and the legacy NUL argv log above is unchanged.
  printf '%s\n' "$owner_record" >> "$PD_OWNER_LOG"
  if [[ -e "$PD_REJECT" ]]; then for x in "${args[@]}"; do [[ "$x" != -C ]] || exit 79; done; fi
if [[ -n "$gate_wrapper_token" && ( "$gate_wrapper_token" != "${PD_CREATION_TOKEN:-}" || "$gate_wrapper_path" != "${PD_CREATION_GATE:-}" ) ]]; then
    echo 'gate wrapper token mismatch' >&2
    exit 79
  fi
  if [[ "${PD_CREATION_FAIL_STAGE:-}" == tag && "$command_name" == set-option ]]; then
    for x in "${args[@]}"; do
      if [[ "$x" == @pane_dash_tag ]]; then
        echo 'tag stage rejected by live wrapper' >&2
        exit 79
      fi
    done
  fi
  if [[ -n "${PD_CREATION_GATE:-}" && ( "$command_name" == new-session || "$command_name" == new-window || "$command_name" == split-window ) ]]; then
    [[ -n "$gate_wrapper_token" ]] || { echo 'creation wrapper did not re-exec with token' >&2; exit 79; }
    printf '%s %s %s\n' "$$" "$gate_wrapper_token" "$0" >> "$PD_CREATION_GATE/pids"
    : > "$PD_CREATION_GATE/started"
    trap 'exit 143' HUP INT TERM
    while [[ ! -e "$PD_CREATION_GATE/release" ]]; do sleep .02; done
  fi
  if [[ -n "${PD_CREATION_GATE:-}" && ( "$command_name" == capture-pane || "$command_name" == list-panes ) ]]; then
    target=''
    for ((i=0; i<${#args[@]}-1; i++)); do [[ "${args[i]}" != -t ]] || { target="${args[i+1]}"; break; }; done
    printf '%s %s %s %s %s\n' "$$" "$PPID" "${PD_CREATION_TOKEN:?missing creation token}" "$command_name" "$target" >> "$PD_CREATION_GATE/popup-work"
  fi
  if [[ -n "${PD_CREATION_GATE:-}" && "$command_name" == set-option ]] && [[ " ${args[*]} " == *' @pane_dash_tag '* && " ${args[*]} " == *' dash-created '* ]]; then
    target=''
    for ((i=0; i<${#args[@]}-1; i++)); do [[ "${args[i]}" != -t ]] || { target="${args[i+1]}"; break; }; done
    printf '%s %s %s set-option %s\n' "$$" "$PPID" "${PD_CREATION_TOKEN:?missing creation token}" "$target" >> "$PD_CREATION_GATE/popup-work"
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
owner_has() { # start end owner command target
  OWNER_START="$1" OWNER_END="$2" OWNER_PID="$3" OWNER_COMMAND="$4" OWNER_TARGET="$5" perl -F'\t' -ane 'next if @F < 6 || $F[0] < $ENV{OWNER_START} || $F[0] > $ENV{OWNER_END}; $found=1 if $F[2] == $ENV{OWNER_PID} && $F[3] eq $ENV{OWNER_COMMAND} && $F[4] eq $ENV{OWNER_TARGET}; END { exit !$found }' < "$OWNER_LOG"
}
owner_has_since() { owner_has "$1" "$(now)" "$2" "$3" "$4"; }
status_snapshot_rendered() { # committed-at transcript-offset popup-owner status
  owner_has_since "$1" "$3" list-panes '' && ansi_tail_has 0 "$2" "$4"
}
owner_only_read_or_control() { # start end owner
  OWNER_START="$1" OWNER_END="$2" OWNER_PID="$3" perl -F'\t' -ane 'next if @F < 6 || $F[0] < $ENV{OWNER_START} || $F[0] > $ENV{OWNER_END} || $F[2] != $ENV{OWNER_PID}; chomp $F[5]; print "$F[3]=$F[4] class=$F[5]\n"; exit 1 unless $F[5] eq q(read) || $F[5] eq q(control)' < "$OWNER_LOG"
}
owner_pids() { OWNER_START="$1" OWNER_END="$2" OWNER_PID="$3" perl -F'\t' -ane 'next if @F < 6 || $F[0] < $ENV{OWNER_START} || $F[0] > $ENV{OWNER_END} || $F[2] != $ENV{OWNER_PID}; print "$F[1]\n"' < "$OWNER_LOG" | sort -un; }
owner_count() { OWNER_START="$1" OWNER_END="$2" OWNER_PID="$3" perl -F'\t' -ane 'BEGIN { $n = 0 } next if @F < 6 || $F[0] < $ENV{OWNER_START} || $F[0] > $ENV{OWNER_END} || $F[2] != $ENV{OWNER_PID}; $n++; END { print "$n\n" }' < "$OWNER_LOG"; }
process_identity() { local pid="$1"; ps -o lstart= -o command= -p "$pid" 2>/dev/null | tr -s ' ' || true; }
identity_is_dead() { local pid="$1" identity="$2"; ! pid_is_alive "$pid" || [[ "$(process_identity "$pid")" != "$identity" ]]; }
wait_for_elapsed() { local started="$1" minimum="$2"; perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'exit clock_gettime(CLOCK_MONOTONIC)-$ARGV[0] >= $ARGV[1] ? 0 : 1' "$started" "$minimum"; }
start_client() { # session label
  local session="$1" label="$2" index="${#CLIENT_PIDS[@]}" before fifo transcript fd pid
  before="$(normal_clients)"
  fifo="$TMP/$label.fifo" transcript="$TMP/$label.ansi"
  mkfifo "$fifo"
  # Keep a pipe-backed pump per client because macOS script rejects FIFO stdin.
  PD_REAL_TMUX="$REAL_TMUX" PD_SOCKET="$SOCKET" PD_LOG="$LOG" PD_OWNER_LOG="$OWNER_LOG" PD_REJECT="$REJECT" PD_CREATION_GATE="$CREATION_GATE" PD_CREATION_TOKEN="$CREATION_TOKEN" PD_CREATION_FAIL_STAGE="$CREATION_FAIL_STAGE" PD_CREATION_GONE="$CREATION_GONE" PATH="$WRAP:$PATH" TERM=xterm-256color COLORTERM=truecolor TMUX='' pd_run_in_pty "$WRAP/tmux" attach-session -t "$session" < <(cat <"$fifo") >"$transcript" 2>&1 &
  pid=$!; open_writer "$index" "$fifo"; fd="$WRITER_FD"; WRITER_SLOTS[index]="$WRITER_FD_SLOT"
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
client_stopped() { ! pid_is_alive "$1"; }
stop_client() { # index; close FIFO, reap producer, and detach tmux client
  local index="$1"
  local fd="${WRITER_FDS[index]:-}" slot="${WRITER_SLOTS[index]:-}" producer="${PRODUCER_PIDS[index]:-}" client="${CLIENT_PIDS[index]:-}"
  [[ -z "$fd" ]] || eval "exec ${fd}>&-"
  [[ -z "$producer" ]] || kill -TERM "$producer" 2>/dev/null || true
  [[ -z "$client" ]] || kill -TERM "$client" 2>/dev/null || true
  [[ -z "$producer" ]] || wait_for "client ${LABELS[index]:-unknown} producer teardown" 2 client_stopped "$producer"
  [[ -z "$client" ]] || wait_for "client ${LABELS[index]:-unknown} teardown" 2 client_stopped "$client"
  [[ -z "$slot" ]] || OPEN_WRITER_SLOTS[slot]=''
  CLIENT_PIDS[index]=''; CLIENT_TTYS[index]=''; PRODUCER_PIDS[index]=''; WRITER_FDS[index]=''
  WRITER_SLOTS[index]=''
  TRANSCRIPTS[index]=''; SESSIONS[index]=''; LABELS[index]=''; POPUP_CONTROLS[index]=''; POPUP_PIDS[index]=''
}
send_bytes() { write_bytes "$@"; sleep .1; }
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
wrapper_pid_matches() {
  local pid="$1" command
  pid_is_alive "$pid" || return 1
  command="$(ps -o command= -p "$pid" 2>/dev/null)"
  [[ "$command" == *"$WRAP/tmux"* ]]
}
creation_gate_wrapper_matches() { # gate pid token wrapper
  local gate="$1" pid="$2" token="$3" wrapper="$4" command
  pid_is_alive "$pid" || return 1
  command="$(ps -o command= -p "$pid" 2>/dev/null)"
  [[ "$command" == *"$wrapper"* && "$command" == *"--pane-dash-gate-token $token"* && "$command" == *"--pane-dash-gate-path $gate"* ]]
}
pane_dash_process() {
  local pid="$1" command
  pid_is_alive "$pid" || return 1
  command="$(ps -o command= -p "$pid" 2>/dev/null)"
  [[ "$command" == "$BIN"* ]]
}
notification_service_count() {
  ps -axo pid=,command= | awk -v binary="$BIN" -v socket="$SOCKET" \
    'index($0, binary) && index($0, socket) && $0 ~ / notify serve --tmux-socket / { count++ } END { print count + 0 }'
}
notification_service_one() { (( $(notification_service_count) == 1 )); }
notification_service_gone() { (( $(notification_service_count) == 0 )); }
notification_identity() { printf '%s,%s,0\n' "$SOCKET" "$(admin display-message -p '#{pid}')"; }
notify_client() {
  local pane="$1"
  shift
  TMUX="$(notification_identity)" TMUX_PANE="$pane" "$BIN" notify "$@"
}
notification_run_shell() {
  local server_pid command argument
  server_pid="$(admin display-message -p '#{pid}')"
  command="TMUX=$(pd_posix_shell_quote "$SOCKET,$server_pid,0") $(pd_posix_shell_quote "$BIN")"
  for argument in notify "$@"; do
    command+=" $(pd_posix_shell_quote "$argument")"
  done
  admin run-shell -b "$command"
}
notification_list_pids() {
  local pid command
  while read -r pid command; do
    [[ "$command" == "$BIN --notification-list "* ]] || continue
    printf '%s\n' "$pid"
  done < <(ps -axo pid=,command=)
}
new_notification_list_process() {
  local before="$1" pid
  while read -r pid; do
    grep -Fqx "$pid" <<< "$before" || {
      NEW_NOTIFICATION_LIST_PID="$pid"
      return 0
    }
  done < <(notification_list_pids)
  return 1
}
notification_open_list_popup() {
  local index="$1" session_id="$2" pane_id="$3" tty="$4" before server_pid command popup_pid
  before="$(notification_list_pids)"
  server_pid="$(admin display-message -p '#{pid}')"
  command="TMUX=$(pd_posix_shell_quote "$SOCKET,$server_pid,0") $(pd_posix_shell_quote "$BIN") notify click --range m --client $(pd_posix_shell_quote "$tty") >/dev/null 2>&1 && $(pd_posix_shell_quote "$ROOT/scripts/open.sh") --notification-list $(pd_posix_shell_quote "$BIN") $(pd_posix_shell_quote "$tty") $(pd_posix_shell_quote "$session_id") $(pd_posix_shell_quote "$pane_id")"
  admin run-shell -b "$command"
  wait_for 'notification list popup process' 3 new_notification_list_process "$before"
  popup_pid="$NEW_NOTIFICATION_LIST_PID"
  pane_dash_process "$popup_pid" || die "notification list popup process is not pane-dash: $popup_pid"
  POPUP_CONTROLS[index]=''
  POPUP_PIDS[index]="$popup_pid"
}
notification_status() { admin show-options -gv @pane_dash_notify_status 2>/dev/null || true; }
notification_status_contains() { [[ "$(notification_status)" == *"$1"* ]]; }
notification_list_count() {
  notify_client "$1" list | perl -MJSON::PP -0777 -e \
    '$value = decode_json(<STDIN>); print scalar @{$value->{snapshot} // []}'
}
notification_list_has_event() {
  local pane="$1" event="$2" expected="$3"
  [[ "$(notify_client "$pane" list | perl -MJSON::PP -0777 -e \
    '$value = decode_json(<STDIN>); print scalar grep { $_->{event_id} eq $ARGV[0] } @{$value->{snapshot} // []}' "$event")" == "$expected" ]]
}
tmux_hook_failure_count() {
  admin show-messages -t "$1" 2>/dev/null | grep -Ec 'returned 1|hook.*(failed|returned)' || true
}
transcript_has_hook_failure_since() {
  tail -c "+$2" "${TRANSCRIPTS[$1]}" | grep -aEq 'returned 1|hook.*(failed|returned)'
}
notification_scenario() {
  local session session_id origin target exit_target tty status list_tag list_offset list_popup_pid list_control list_exited
  local selection_offset hook_failures_before hook_failures_after
  session="notify-$RANDOM-$RANDOM"
  list_tag="notification-list-$RANDOM$RANDOM"
  admin new-session -d -s "$session" -x 120 -y 40 'exec cat'
  session_id="$(admin display-message -p -t "$session:0.0" '#{session_id}')"
  origin="$(admin display-message -p -t "$session:0.0" '#{pane_id}')"
  target="$(admin split-window -d -P -F '#{pane_id}' -t "$origin" 'exec cat')"
  exit_target="$(admin split-window -d -P -F '#{pane_id}' -t "$origin" 'exec cat')"
  tty="${CLIENT_TTYS[0]}"
  [[ -n "$tty" && -n "$target" ]] || die 'notification selection identities were empty'

  admin switch-client -c "$tty" -t "$session"
  # switch-client deterministically runs the installed client-session-changed
  # hook; allow its background run-shell notification command to complete.
  sleep .2
  status="$(notify_client "$origin" publish --event-id focused-origin --kind question --message suppressed --pane "$origin")"
  [[ "$status" == *'"outcome":"suppressed"'* ]] || die "focused origin was not suppressed: $status"

  # A real attached-client pane switch must expand the generic client_tty and
  # pane_id formats supplied by after-select-pane.  The old hook used the
  # unavailable hook_client/hook_pane formats and left the service focused on
  # the previous pane while painting a tmux run-shell failure.
  selection_offset="$(ansi_size 0)"
  hook_failures_before="$(tmux_hook_failure_count "$tty")"
  admin select-pane -t "$target"
  sleep .2
  status="$(notify_client "$target" publish --event-id focused-target-by-selection --kind question --message suppressed --pane "$target")"
  [[ "$status" == *'"outcome":"suppressed"'* ]] || die "selected target was not suppressed: $status"
  admin select-pane -t "$origin"
  sleep .2
  hook_failures_after="$(tmux_hook_failure_count "$tty")"
  [[ "$hook_failures_after" == "$hook_failures_before" ]] || die 'pane selection added a tmux hook failure message'
  ! transcript_has_hook_failure_since 0 "$((selection_offset + 1))" || die 'pane selection displayed a tmux hook failure message'

  notify_client "$origin" publish --event-id finished-oldest --kind finished --message oldest-finished --pane "$target" >/dev/null
  notify_client "$origin" publish --event-id error-oldest --kind error --message oldest-error --pane "$target" >/dev/null
  notify_client "$origin" publish --event-id error-newer --kind error --message newer-error --pane "$exit_target" >/dev/null
  notify_client "$origin" publish --event-id question-newer --kind question --message "newer-question-$list_tag" --pane "$target" >/dev/null
  wait_for 'priority and oldest notification status' 3 notification_status_contains 'range=user|v2'
  notification_status_contains 'error: oldest-error' || die 'visible notification was not the oldest highest-priority item'
  notification_status_contains 'range=user|m' || die 'notification more range missing'
  notification_status_contains '+3 more' || die 'notification more count missing'
  ! notification_status_contains 'range=user|v3' || die 'newer equal-priority notification was visible'
  [[ "$(notification_list_count "$origin")" == 4 ]] || die 'notification list publish count'

  # This is the same tmux run-shell action used by the visible status binding;
  # a PTY mouse escape is not deterministic across the macOS script harness.
  notification_run_shell click --range v2 --client "$tty"
  wait_for 'notification click routes client' 3 client_is "$tty" "$session_id" "$target"
  wait_for 'notification click dismisses one item' 3 notification_list_count "$origin"
  [[ "$(notification_list_count "$origin")" == 3 ]] || die 'notification click dismissed the wrong number of items'
  notification_list_has_event "$origin" error-oldest 0 || die 'clicked notification remained queued'
  notification_list_has_event "$origin" finished-oldest 1 || die 'older lower-priority notification disappeared'
  notification_list_has_event "$origin" error-newer 1 || die 'newer notification disappeared with clicked item'
  notification_list_has_event "$origin" question-newer 1 || die 'question notification disappeared with clicked item'

  # Exercise the installed +N branch and the real notification-list popup. The
  # unique message plus transcript byte offset keeps this assertion causal.
  list_offset="$(ansi_size 0)"
  notification_open_list_popup 0 "$session_id" "$origin" "$tty"
  list_popup_pid="${POPUP_PIDS[0]}"; list_control="${POPUP_CONTROLS[0]}"
  wait_for 'notification list popup first frame' 3 ansi_tail_has 0 "$((list_offset + 1))" "$list_tag"
  send_bytes 0 j; send_bytes 0 '\r'
  wait_for 'notification list selection routes client' 3 client_is "$tty" "$session_id" "$target"
  wait_for 'notification list popup exits after selection' 3 popup_closed 0
  [[ -z "$list_control" ]] || ! control_present "$list_control" || die 'notification list control survived selection'
  ! pane_dash_process "$list_popup_pid" || die 'notification list pane-dash process survived selection'
  list_exited="$(now)"
  assert_no_popup_runtime_after_exit 'notification-list' "$list_popup_pid" "$list_exited"
  [[ "$(notification_list_count "$origin")" == 2 ]] || die 'notification list selection count'
  notification_list_has_event "$origin" question-newer 0 || die 'selected notification remained queued'
  notification_list_has_event "$origin" error-newer 1 || die 'unselected error notification disappeared'
  notification_list_has_event "$origin" finished-oldest 1 || die 'unselected finished notification disappeared'

  notify_client "$target" hook focus --client "$tty" --pane "$target" --width 120 --focused 1 >/dev/null
  status="$(notify_client "$target" publish --event-id focused-target --kind question --message suppressed --pane "$target")"
  [[ "$status" == *'"outcome":"suppressed"'* ]] || die "focused routed target was not suppressed: $status"

  notify_client "$origin" publish --event-id exited-target --kind permission --message gone --pane "$exit_target" >/dev/null
  [[ "$(notification_list_count "$origin")" == 3 ]] || die 'pane-exit setup count'
  admin send-keys -t "$exit_target" C-d
  wait_for 'exited pane closes' 3 target_gone "$exit_target"
  wait_for 'pane-exited notification cleanup' 3 notification_list_has_event "$origin" exited-target 0
  notification_list_has_event "$origin" error-newer 0 || die 'pane-exited cleanup left stale target'

  admin kill-session -a -t "$session"
  admin kill-session -t "$session"
  wait_for 'notification service teardown' 3 notification_service_gone
  printf 'notifications origin=%s target=%s click=visible-2 list=j+enter route=dismissed pane-exit=clean service=gone\n' "$origin" "$target"
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
phase6_restore_xdg() {
  [[ -n "$SOCKET" && "$PHASE6_XDG_WAS_SET" != 0 ]] || return 0
  if (( PHASE6_XDG_WAS_SET == 2 )); then
    admin set-environment -g XDG_CONFIG_HOME "$PHASE6_XDG_VALUE"
  else
    admin set-environment -gu XDG_CONFIG_HOME
  fi
  PHASE6_XDG_WAS_SET=0
  PHASE6_XDG_VALUE=''
}
phase6_enable_rgb() {
  PHASE6_TERMINAL_FEATURES_BEFORE="$(admin show-options -sv terminal-features)"
  if [[ -n "$(admin show-options -sqv 'terminal-features[31338]')" ]]; then
    die 'phase6 RGB isolation index terminal-features[31338] was already set'
  fi
  admin set-option -s 'terminal-features[31338]' '*:RGB'
  PHASE6_RGB_SET=1
  [[ "$(admin show-options -sqv 'terminal-features[31338]')" == '*:RGB' ]] || die 'phase6 RGB isolation index was not set'
}
phase6_restore_rgb() {
  [[ -n "$SOCKET" && "$PHASE6_RGB_SET" != 0 ]] || return 0
  admin set-option -su 'terminal-features[31338]'
  if [[ -n "$(admin show-options -sqv 'terminal-features[31338]')" ]]; then
    die 'phase6 RGB isolation index survived cleanup'
  fi
  [[ "$(admin show-options -sv terminal-features)" == "$PHASE6_TERMINAL_FEATURES_BEFORE" ]] || die 'phase6 RGB cleanup did not restore terminal-features'
  PHASE6_RGB_SET=0
  PHASE6_TERMINAL_FEATURES_BEFORE=''
}
phase6_theme_help_isolation() {
  local home_a="$TMP/phase6-xdg-a" home_b="$TMP/phase6-xdg-b" prior_xdg a_offset b_offset help_offset action_start b_start close_help_offset a_popup b_popup closed b_source reopened_offset quiescence_start quiescence_end owner_start a_control b_control
  mkdir -p "$home_a/tmux-pane-dash" "$home_b/tmux-pane-dash"
  printf 'accent = "#010203"\nborder = "#040506"\n' > "$home_a/tmux-pane-dash/config.toml"
  printf 'accent = "#070809"\nborder = "#0a0b0c"\n' > "$home_b/tmux-pane-dash/config.toml"
  if prior_xdg="$(admin show-environment -g XDG_CONFIG_HOME 2>/dev/null)"; then
    PHASE6_XDG_WAS_SET=2
    PHASE6_XDG_VALUE="${prior_xdg#XDG_CONFIG_HOME=}"
  else
    PHASE6_XDG_WAS_SET=1
  fi

  # RGB capability is relevant only to the semantic RGB scenario below. Keeping
  # it out of the prior harness phases prevents its terminal-diff timing from
  # perturbing their independent assertions.
  phase6_enable_rgb
  admin set-environment -g XDG_CONFIG_HOME "$home_a"
  owner_start="$(now)"
  a_offset="$(ansi_size 0)"
  open_popup 0
  a_popup="${POPUP_PIDS[0]}"
  wait_for 'phase6 popup A first frame' 3 ansi_tail_has_rgb 0 "$((a_offset + 1))" 1 2 3
  ansi_tail_has_rgb 0 "$((a_offset + 1))" 4 5 6 || die 'phase6 popup A missing configured border'
  ! ansi_tail_has_rgb 0 "$((a_offset + 1))" 7 8 9 || die 'phase6 popup A inherited popup B accent'
  ! ansi_tail_has_rgb 0 "$((a_offset + 1))" 10 11 12 || die 'phase6 popup A inherited popup B border'

  admin set-environment -g XDG_CONFIG_HOME "$home_b"
  b_offset="$(ansi_size 1)"
  open_popup 1
  b_popup="${POPUP_PIDS[1]}"
  wait_for 'phase6 popup B first frame' 3 ansi_tail_has_rgb 1 "$((b_offset + 1))" 7 8 9
  ansi_tail_has_rgb 1 "$((b_offset + 1))" 10 11 12 || die 'phase6 popup B missing configured border'
  ! ansi_tail_has_rgb 1 "$((b_offset + 1))" 1 2 3 || die 'phase6 popup B inherited popup A accent'
  ! ansi_tail_has_rgb 1 "$((b_offset + 1))" 4 5 6 || die 'phase6 popup B inherited popup A border'
  has_two_controls || die 'phase6 expected two popup-local controls'
  popup_control_has_owner 0 "${POPUP_CONTROLS[0]}" || die 'phase6 popup A control owner'
  popup_control_has_owner 1 "${POPUP_CONTROLS[1]}" || die 'phase6 popup B control owner'

  help_offset="$(ansi_size 0)"
  write_bytes 0 '?'
  wait_for 'phase6 help A canonical keys' 2 popup_tail_has 0 "$((help_offset + 1))" 'Keys — navigation and modes'
  popup_tail_has 0 "$((help_offset + 1))" 'Six statuses and glyphs' || die 'phase6 help missing statuses heading'
  # Terminal diffs can split style runs or omit unchanged spaces, so normalize
  # only control sequences/whitespace before matching canonical help text.
  ansi_tail_compact_has 0 "$((help_offset + 1))" 'j/k scroll | Ctrl-u/d half | PgUp/Dn page | g/G ends | ?, Esc, q close' || die 'phase6 help missing scroll footer'
  action_start="$(now)"
  write_bytes 0 $'nx\r\023sj'
  close_help_offset="$(ansi_size 0)"
  write_bytes 0 '?'
  wait_for 'phase6 inert barrier closes Help to dashboard' 2 popup_tail_has 0 "$((close_help_offset + 1))" live-spare
  reopened_offset="$(ansi_size 0)"
  write_bytes 0 '?'
  wait_for 'phase6 inert barrier reopens Help' 2 popup_tail_has 0 "$((reopened_offset + 1))" 'Keys — navigation and modes'
  ansi_tail_compact_has 0 "$((reopened_offset + 1))" 'j/k scroll | Ctrl-u/d half | PgUp/Dn page | g/G ends | ?, Esc, q close' || die 'phase6 inert barrier lost Help footer'
  popup_open 0 || die 'phase6 inert barrier closed popup A'
  quiescence_start="$(now)"
  wait_for 'phase6 Help quiescence >=1.1s' 1.3 wait_for_elapsed "$quiescence_start" 1.1
  if ! popup_open 0 || ! popup_tail_has 0 "$((reopened_offset + 1))" 'Keys — navigation and modes'; then
    die 'phase6 Help was not current after quiescence'
  fi
  quiescence_end="$(now)"
  owner_only_read_or_control "$action_start" "$quiescence_end" "$a_popup" || die 'phase6 Help emitted owner-specific write/action tmux argv'

  b_source="$(client_snapshot "${CLIENT_TTYS[1]}")"; b_source="${b_source#* }"
  [[ -n "$b_source" ]] || die 'phase6 popup B source pane identity'
  b_start="$(now)"
  write_bytes 1 $'jj\022'
  wait_for 'phase6 popup B owner preview while A help is open' .5 owner_has_since "$b_start" "$b_popup" capture-pane "$b_source"
  popup_open 1 || die 'phase6 popup B became unusable while A help open'
  ansi_grew_from 1 "$b_offset" || die 'phase6 popup B dashboard did not redraw after navigation'
  popup_tail_has 0 "$((help_offset + 1))" 'Keys — navigation and modes' || die 'phase6 popup A left help while B navigated'
  # Pause B's selected-pane preview before attributing A's post-close quiescence;
  # topology reads remain permitted, but no other popup may contribute captures.
  write_bytes 1 '\025'

  close_help_offset="$(ansi_size 0)"
  write_bytes 0 q
  wait_for 'phase6 q closes help only' 2 popup_tail_has 0 "$((close_help_offset + 1))" live-spare
  if ! popup_open 0 || [[ "${POPUP_PIDS[0]}" != "$a_popup" ]]; then
    die 'phase6 first q did not retain popup A'
  fi
  control_present "${POPUP_CONTROLS[0]}" || die 'phase6 first q replaced popup A control'
  a_control="${POPUP_CONTROLS[0]}"
  close_popup 0
  closed="$(now)"
  assert_phase6_owner_stopped 'phase6 popup A' "$a_popup" "$a_control" "$owner_start" "$closed"
  (( $(control_count) == 1 )) || die 'phase6 popup A close did not leave exactly popup B control'
  if ! popup_open 1 || [[ "${POPUP_PIDS[1]}" != "$b_popup" ]]; then
    die 'phase6 popup B did not remain open after popup A close'
  fi
  b_control="${POPUP_CONTROLS[1]}"
  close_popup 1
  closed="$(now)"
  assert_phase6_owner_stopped 'phase6 popup B' "$b_popup" "$b_control" "$owner_start" "$closed"
  (( $(control_count) == 0 )) || die 'phase6 popup close left a control client'
  phase6_restore_xdg
  phase6_restore_rgb
  printf 'phase6 themes A=%s B=%s controls=2->0 help=local read-only-classes=attributed post-close-runtime=0\n' "$a_popup" "$b_popup"
}
target_gone() { ! admin list-panes -a -F '#{pane_id}' | grep -Fxq "$1"; }
target_present() { admin list-panes -a -F '#{pane_id}' | grep -Fxq "$1"; }
selected_pane_contains() {
  if pane_contains "$pane" "$hostile"; then selected_pane="$pane"; return 0; fi
  if pane_contains "$target" "$hostile"; then selected_pane="$target"; return 0; fi
  return 1
}
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
assert_phase6_owner_stopped() { # label popup-owner control start exit
  local label="$1" owner="$2" control="$3" started="$4" exited="$5" observed control_identity child child_identity
  control_identity="$(process_identity "$control")"
  wait_for "$label owner quiescence >=1.1s" 1.3 wait_for_elapsed "$exited" 1.1
  observed="$(now)"
  (( $(owner_count "$exited" "$observed" "$owner") == 0 )) || die "$label owner emitted tmux argv after exit"
  [[ -z "$control_identity" ]] || identity_is_dead "$control" "$control_identity" || die "$label control PID survived or was reused"
  while read -r child; do
    [[ -n "$child" ]] || continue
    child_identity="$(process_identity "$child")"
    [[ -z "$child_identity" ]] || identity_is_dead "$child" "$child_identity" || die "$label wrapper child PID survived or was reused"
  done < <(owner_pids "$started" "$exited" "$owner")
  ! pane_dash_process "$owner" || die "$label pane-dash owner survived exit"
  printf '%s owner=%s control=%s post-exit-owner-records=0 children-dead=1 owner-dead=1\n' "$label" "$owner" "$control"
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
creation_gate_begin() { # unique source/popup label
  local label="$1"
  CREATION_TOKEN="${label}-${RANDOM}${RANDOM}"
  CREATION_GATE="$TMP/creation-gate-$CREATION_TOKEN"
  mkdir -p "$CREATION_GATE"
  CREATION_GATES+=("$CREATION_GATE")
}
creation_gate_release() { : > "$CREATION_GATE/release"; }
creation_gate_release_path() { : > "$1/release"; }
creation_gate_started() { [[ -e "$CREATION_GATE/started" ]]; }
creation_gate_started_path() { [[ -e "$1/started" ]]; }
creation_gate_pid() { awk -v token="$2" '$2==token {print $1; exit}' "$1/pids"; }
creation_gate_pid_reaped() { ! pid_is_alive "$1"; }
creation_gate_reap() { # gate token pid
  local gate="$1" token="$2" pid="$3" wrapper
  wrapper="$(awk -v pid="$pid" -v token="$token" '$1==pid && $2==token {print $3; exit}' "$gate/pids")"
  [[ -n "$wrapper" ]] || die "creation gate record missing before reap: $gate $token $pid"
  if pid_is_alive "$pid"; then
    creation_gate_wrapper_matches "$gate" "$pid" "$token" "$wrapper" || die "creation gate identity changed before reap: $gate $token $pid"
  fi
  rm -f "$gate/pids"
  wait_for "creation wrapper $pid reap" 2 creation_gate_pid_reaped "$pid"
}
creation_gate_forget_path() { # only remove records after the recorded wrapper identities have exited
  local gate="$1" token pid wrapper
  [[ -f "$gate/pids" ]] || return 0
  while read -r pid token wrapper; do
    if pid_is_alive "$pid"; then
      creation_gate_wrapper_matches "$gate" "$pid" "$token" "$wrapper" || die "creation gate identity changed while cleaning $gate: $pid"
      die "creation gate wrapper still alive while cleaning $gate: $pid"
    fi
  done < "$gate/pids"
  rm -f "$gate/pids"
}
creation_popup_work_offset() { [[ -f "$1/popup-work" ]] && wc -c < "$1/popup-work" | tr -d ' ' || printf 0; }
creation_popup_work_since() { # gate byte-offset token popup-pid command
  perl -e 'use strict;my($path,$offset,$token,$popup,$command)=@ARGV;open my$fh,"<",$path or exit 1;binmode$fh;seek($fh,$offset,0) or exit 1;while(<$fh>){my@v=split;exit 0 if$#v>=3&&$v[1]eq$popup&&$v[2]eq$token&&$v[3]eq$command}exit 1' "$1/popup-work" "$2" "$3" "$4" "$5"; }
creation_popup_work_since_with_live_child() { # gate byte-offset token popup-pid child-pid command
  pid_is_alive "$5" && creation_popup_work_since "$1" "$2" "$3" "$4" "$6"
}
creation_gate_tag_target() { awk -v token="$2" '$3==token && $4=="set-option" && $5!="" { found=1; print $5; exit } END { exit !found }' "$1/popup-work" 2>/dev/null; }
creation_split_target() {
  local target
  target="$(admin list-panes -t "$1" -F '#{pane_id}' | grep -Fvx "$2" | tail -n 1)"
  [[ -n "$target" ]] || return 1
  printf '%s\n' "$target"
}
creation_control_argv_count_since() {
  perl -e 'use strict;my($d,$after)=@ARGV;my$n=0;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$after;my$i=0;while($i<@v&&($v[$i]eq q(-S)||$v[$i]eq q(-f))){$i+=2}next unless($v[$i]//q())=~/^(?:new-session|new-window|split-window|set-option|send-keys)$/;$n++ if grep {$_ eq q(-C)} @v}print"$n\n"' "$LOG" "$1"
}
creation_target_since() {
  perl -e 'use strict;my($d,$after)=@ARGV;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$after;my$i=0;while($i<@v&&($v[$i]eq q(-S)||$v[$i]eq q(-f))){$i+=2}next unless($v[$i]//q())eq q(set-option);my($target,$tag,$value);for(;$i<@v-1;$i++){ $target=$v[$i+1] if $v[$i]eq q(-t); $tag=1 if $v[$i]eq q(@pane_dash_tag); $value=1 if $v[$i]eq q(dash-created) }if($tag&&$value&&defined$target&&length$target){print "$target\n";exit}}exit 1' "$LOG" "$1"
}
creation_tag_count_since() {
  perl -e 'use strict;my($d,$after)=@ARGV;my$n=0;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$after;my$i=0;while($i<@v&&($v[$i]eq q(-S)||$v[$i]eq q(-f))){$i+=2}next unless($v[$i]//q())eq q(set-option);$n++ if ((grep {$_ eq q(@pane_dash_tag)} @v) && (grep {$_ eq q(dash-created)} @v))}print"$n\n"' "$LOG" "$1"
}
creation_no_control_argv_since() { (( $(creation_control_argv_count_since "$1")==0 )); }
creation_send_command_is_exact_since() { # timestamp pane encoded-command
  perl -e 'use strict;my($d,$after,$target,$command)=@ARGV;for my$f(glob "$d/*"){open my$h,"<",$f or die$!;binmode$h;local$/;my@v=split/\0/,<$h>,-1;my$t=shift@v;next if$t<$after;my$i=0;while($i<@v&&($v[$i]eq q(-S)||$v[$i]eq q(-f))){$i+=2}next unless($v[$i]//q())eq q(send-keys);next unless join("\0",@v[$i..$#v]) eq join("\0",q(send-keys),q(-l),q(-t),$target,q(--),$command,q());exit 0}exit 1' "$LOG" "$1" "$2" "$3"
}
creation_form_or_choice_visible() { ansi_has "$1" 'Create session' || ansi_has "$1" 'New session'; }
creation_suite_begin() {
  local pane
  REJECT="$TMP/reject"
  admin set-option -g @pane-dash-match '__pane_dash_creation_baseline_hidden__'
  admin set-option -g @pane_dash_group 1
  while read -r pane; do
    [[ -n "$pane" ]] || continue
    admin set-option -p -t "$pane" -u @pane_dash_tag 2>/dev/null || true
    admin set-option -p -t "$pane" -u @pane_dash_status 2>/dev/null || true
    admin set-option -p -t "$pane" -u @pane_dash_status_since 2>/dev/null || true
    admin set-option -p -t "$pane" -u @pane_dash_heartbeat 2>/dev/null || true
    admin set-option -p -t "$pane" -u @pane_dash_title 2>/dev/null || true
    admin set-option -p -t "$pane" -u @pane_dash_model 2>/dev/null || true
  done < <(admin list-panes -a -F '#{pane_id}')
}
creation_open_deferred_source() { # label [required startup tag]
  local label="$1" required_tag="${2:-}"
  CREATION_POPUP_WORK_OFFSET=0
  [[ -z "$CREATION_GATE" ]] || CREATION_POPUP_WORK_OFFSET="$(creation_popup_work_offset "$CREATION_GATE")"
  start_client "$CREATION_SOURCE" "creation-${label}"
  CREATION_INDEX=$((${#CLIENT_PIDS[@]} - 1))
  CREATION_SOURCE_TAGS[CREATION_INDEX]="$CREATION_DEFERRED_TAG"
  CREATION_SOURCE_SESSIONS[CREATION_INDEX]="$CREATION_SOURCE"
  open_popup "$CREATION_INDEX"
  wait_for "creation $label first popup frame" 3 ansi_has "$CREATION_INDEX" "$CREATION_DEFERRED_TAG"
  [[ -z "$required_tag" ]] || wait_for "creation $label startup sees prior source" 3 ansi_has "$CREATION_INDEX" "$required_tag"
}
creation_setup() { # label [deterministically ordered source session] [required startup tag] [defer popup]; expects gate/failure setting before call
  local label="$1" source="${2:-}" required_tag="${3:-}" defer_popup="${4:-}" pane source_tag nonce
  if [[ -n "$CREATION_GATE" ]]; then admin set-environment -g PD_CREATION_GATE "$CREATION_GATE"; else admin set-environment -gu PD_CREATION_GATE 2>/dev/null || true; fi
  if [[ -n "$CREATION_TOKEN" ]]; then admin set-environment -g PD_CREATION_TOKEN "$CREATION_TOKEN"; else admin set-environment -gu PD_CREATION_TOKEN 2>/dev/null || true; fi
  if [[ -n "$CREATION_FAIL_STAGE" ]]; then admin set-environment -g PD_CREATION_FAIL_STAGE "$CREATION_FAIL_STAGE"; else admin set-environment -gu PD_CREATION_FAIL_STAGE 2>/dev/null || true; fi
  if [[ -n "$CREATION_GONE" ]]; then admin set-environment -g PD_CREATION_GONE "$CREATION_GONE"; else admin set-environment -gu PD_CREATION_GONE 2>/dev/null || true; fi
  [[ -n "$source" ]] || source="creation-${label}-${RANDOM}${RANDOM}"
  admin new-session -d -s "$source" -x 120 -y 40 'exec cat'
  pane="$(admin display-message -p -t "$source:0.0" '#{pane_id}')"
  admin set-option -g @pane-dash-new-command "$CREATION_NEW_COMMAND"
  nonce="$(od -An -N6 -tx1 /dev/urandom | tr -d '[:space:]')"
  source_tag="creation-${label}-${nonce}"
  admin set-option -p -t "$pane" @pane_dash_tag "$source_tag"
  CREATION_SOURCE="$source" CREATION_PANE="$pane" CREATION_DEFERRED_TAG="$source_tag"
  [[ "$defer_popup" == 1 ]] || creation_open_deferred_source "$label" "$required_tag"
}
creation_choice_ordered_since() { # popup offset
  local index="$1" offset="$2" ordered
  popup_open "$index" || return 1
  for label in 'Split right' 'Split left' 'Split bottom' 'Split top' 'New window' 'New session'; do
    ansi_tail_has "$index" "$offset" "$label" || return 1
  done
  ordered="$(tail -c "+$offset" "${TRANSCRIPTS[index]}" | tr '\n' ' ')"
  [[ "${ordered%%Split right*}" != "$ordered" && "${ordered#*Split right}" == *'Split left'* && "${ordered#*Split left}" == *'Split bottom'* && "${ordered#*Split bottom}" == *'Split top'* && "${ordered#*Split top}" == *'New window'* && "${ordered#*New window}" == *'New session'* ]]
}
creation_open_choice_modal() { # popup j-count; start at first grouped header with g
  local index="$1" pane_steps="$2" before step
  # `g` is idempotent when the first header is already focused; the fresh modal
  # assertion below is the observable boundary rather than a repaint heuristic.
  write_bytes "$index" g
  for ((step = 0; step < pane_steps; step++)); do
    before="$(ansi_size "$index")"; write_bytes "$index" j
    wait_for 'creation deterministic reducer navigation redraw' 2 ansi_grew_from "$index" "$before"
  done
  before="$(( $(ansi_size "$index") + 1 ))"; write_bytes "$index" n
  wait_for 'creation choice modal exact labels/order' 2 creation_choice_ordered_since "$index" "$before"
}
creation_cleanup() { # popup [separate new-session target]
  local index="$1" target
  shift
  if popup_open "$index"; then close_popup "$index"; fi
  stop_client "$index"
  for target in "${CREATION_SOURCE_SESSIONS[index]:-}" "$@"; do
    [[ -n "$target" ]] || continue
    admin kill-session -t "$target" 2>/dev/null || true
  done
  CREATION_SOURCE_SESSIONS[index]=''
  CREATION_SOURCE_TAGS[index]=''
}
creation_submit_first_split() { send_bytes "$1" '\r'; }
creation_choice_order_and_context() {
  local index before offset started
  creation_setup choices; index="$CREATION_INDEX"; before="$(( $(ansi_size "$index") + 1 ))"
  creation_open_choice_modal "$index" 1; offset="$before"
  started="$(now)"; send_bytes "$index" '\r'; send_bytes "$index" '\r'
  wait_for 'creation choice exact first argv' 3 creation_target_since "$started"
  (( $(record_count "$started" "$(now)" split-window)==1 )) || die 'creation choice first selection was not split-right'
  creation_cleanup "$index"
  printf 'creation choices pane-context exact-order=right,left,bottom,top,window,session\n'
}
creation_success_responsive() {
  local index started target snapshot_before selection_started modal_before work_offset popup_pid control_pid child_pid
  creation_gate_begin success; creation_setup success; index="$CREATION_INDEX"
  wait_for 'creation startup same-popup list' 1.1 creation_popup_work_since "$CREATION_GATE" "$CREATION_POPUP_WORK_OFFSET" "$CREATION_TOKEN" "${POPUP_PIDS[index]}" list-panes
  # The gated child, its wrapper work, and the control client must all belong
  # to this popup. Do not prove responsiveness with a second popup.
  popup_control_has_owner "$index" "${POPUP_CONTROLS[index]}" || die 'creation held popup/control lineage'
  creation_open_choice_modal "$index" 1; write_bytes "$index" '\r'
  : > "$REJECT"; admin run-shell "kill -TERM ${POPUP_CONTROLS[index]}"
  wait_for 'creation held degraded snapshot timer' 3 ansi_has "$index" 'live updates lost — polling'
  wait_for 'creation held no persistent control' 2 control_is_zero
  started="$(now)"; creation_submit_first_split "$index"; wait_for 'creation pending gate' 2 creation_gate_started
  child_pid="$(creation_gate_pid "$CREATION_GATE" "$CREATION_TOKEN")"
  wait_for 'creation pending row' 2 ansi_has "$index" 'creating...'
  work_offset="$(creation_popup_work_offset "$CREATION_GATE")"
  wait_for 'creation held same-popup preview' 1.1 creation_popup_work_since "$CREATION_GATE" "$work_offset" "$CREATION_TOKEN" "${POPUP_PIDS[index]}" capture-pane
  snapshot_before="$(( $(ansi_size "$index") + 1 ))"; work_offset="$(creation_popup_work_offset "$CREATION_GATE")"
  admin set-option -p -t "$CREATION_PANE" @pane_dash_tag creation-held-snapshot
  wait_for 'creation held same-popup list snapshot while child lives' 1.1 creation_popup_work_since_with_live_child "$CREATION_GATE" "$work_offset" "$CREATION_TOKEN" "${POPUP_PIDS[index]}" "$child_pid" list-panes
  creation_gate_release; wait_for 'creation tag target' 3 creation_target_since "$started"; target="$(creation_target_since "$started")"; creation_gate_forget_path "$CREATION_GATE"
  rm -f "$REJECT"
  wait_for 'creation mutation render exact tag' 3 popup_tail_has "$index" "$snapshot_before" creation-held-snapshot
  wait_for 'creation target tagged' 3 pane_contains "$target" ''
  [[ "$(admin show-options -pv -t "$target" @pane_dash_tag)" == dash-created ]] || die 'creation success tag missing'
  selection_started="$(now)"; send_bytes "$index" '\022'
  wait_for 'creation selected row targets created pane' .5 log_has_target_since "$selection_started" capture-pane "$target"
  (( $(record_count "$started" "$(now)" split-window)==1 )) || die 'creation success replayed stage 1'
  (( $(creation_tag_count_since "$started")==1 )) || die 'creation success tag count'
  creation_no_control_argv_since "$started" || die 'creation argv used persistent control stdin'
  modal_before="$(ansi_size "$index")"; send_bytes "$index" n
  wait_for 'creation pending clears into create modal' 3 ansi_grew_from "$index" "$modal_before"
  ansi_tail_has "$index" "$((modal_before+1))" 'Split right' || die 'creation pending did not clear into create modal'
  send_bytes "$index" '\033'
  budget 'creation success follow' 10 5
  popup_pid="${POPUP_PIDS[index]}"; control_pid="${POPUP_CONTROLS[index]}"
  creation_cleanup "$index"
  printf 'creation success pending-immediate same-popup=%s control=%s preview+snapshot=causal target=%s argv=create,tag once control=0 closed\n' "$popup_pid" "$control_pid" "$target"
}
creation_stage1_retry() {
  local index started target
  CREATION_GATE=''; CREATION_FAIL_STAGE=''; creation_setup retry; index="$CREATION_INDEX"
  creation_open_choice_modal "$index" 1
  send_bytes "$index" j; send_bytes "$index" j; send_bytes "$index" j; send_bytes "$index" j; send_bytes "$index" j; send_bytes "$index" '\r'
  started="$(now)"; send_bytes "$index" "$CREATION_SOURCE"; send_bytes "$index" '\r'
  wait_for 'creation retry stage-1 error' 3 ansi_has "$index" 'duplicate session'
  popup_open "$index" || die 'stage-1 retry closed popup'
  send_bytes "$index" '-retry'; send_bytes "$index" '\r'
  wait_for 'creation retry tag' 3 creation_target_since "$started"; target="$(creation_target_since "$started")"
  [[ "$(admin show-options -pv -t "$target" @pane_dash_tag)" == dash-created ]] || die 'stage-1 retry never created corrected request'
  (( $(record_count "$started" "$(now)" new-session)==2 )) || die 'stage-1 retry creation count/correlation'
  (( $(creation_tag_count_since "$started")==1 )) || die 'stage-1 failure ran an unintended generation'
  creation_no_control_argv_since "$started" || die 'stage-1 retry used persistent control stdin'
  creation_cleanup "$index" "$(admin display-message -p -t "$target" '#{session_name}')"
  printf 'creation stage1 duplicate stayed-modal retry=monotonic two-create-one-tag target=%s\n' "$target"
}
creation_configured_command() {
  local index started target command='printf pane-dash' modal_before
  CREATION_GATE=''; CREATION_FAIL_STAGE=''; CREATION_NEW_COMMAND="$command"
  creation_setup configured-command '' '' 1
  start_client "$CREATION_SOURCE" 'creation-configured-command'; CREATION_INDEX=$((${#CLIENT_PIDS[@]} - 1)); index="$CREATION_INDEX"
  CREATION_SOURCE_TAGS[CREATION_INDEX]="$CREATION_DEFERRED_TAG"; CREATION_SOURCE_SESSIONS[CREATION_INDEX]="$CREATION_SOURCE"
  open_popup "$index"; wait_for 'creation configured command popup open' 3 popup_open "$index"
  wait_for 'creation configured command navigation frame' 3 ansi_has "$index" 'NAV'
  send_bytes "$index" n; wait_for 'creation configured command form or choice' 3 creation_form_or_choice_visible "$index"
  if ! ansi_has "$index" 'Create session'; then modal_before="$(ansi_size "$index")"; write_bytes "$index" '\r'; wait_for 'creation configured command form' 3 ansi_grew_from "$index" "$modal_before"; fi
  started="$(now)"; send_bytes "$index" '\r'
  wait_for 'creation configured command target' 3 creation_target_since "$started"; target="$(creation_target_since "$started")"
  wait_for 'creation configured command exact argv' 3 creation_send_command_is_exact_since "$started" "$target" "$command"
  (( $(record_count "$started" "$(now)" send-keys)==2 )) || die 'configured command did not run send command and enter exactly once'
  creation_no_control_argv_since "$started" || die 'configured command used persistent control stdin'
  CREATION_NEW_COMMAND=''; admin set-option -g @pane-dash-new-command ''
  creation_cleanup "$index"
  printf 'creation configured-command exact-send-argv target=%s command=%s stages3-4=once\n' "$target" "$command"
}
creation_tag_failure_and_gone() {
  local index started target offset
  CREATION_GATE=''; CREATION_FAIL_STAGE=tag; creation_setup tag-failure; index="$CREATION_INDEX"; creation_open_choice_modal "$index" 1; write_bytes "$index" '\r'
  started="$(now)"; creation_submit_first_split "$index"; wait_for 'creation tag failure target' 3 creation_target_since "$started"; target="$(creation_target_since "$started")"
  wait_for 'creation tag failure toast' 3 ansi_has "$index" 'tagging failed'
  ansi_has "$index" "$target" || die 'tag failure did not expose live ephemeral pane'
  [[ -z "$(admin show-options -pv -t "$target" @pane_dash_tag 2>/dev/null || true)" ]] || die 'tag failure unexpectedly tagged pane'
  offset="$(ansi_size "$index")"; admin kill-pane -t "$target"; wait_for 'tag failure target gone' 2 target_gone "$target"
  wait_for 'tag failure prune redraw' 1.1 ansi_grew_from "$index" "$offset"; send_bytes "$index" '\014'
  ! ansi_tail_has "$index" "$((offset+1))" "$target" || die 'dead ephemeral pane survived raw snapshot prune'
  (( $(record_count "$started" "$(now)" send-keys)==0 )) || die 'tag failure ran later stage'
  CREATION_FAIL_STAGE=''; creation_cleanup "$index"
  printf 'creation tag-failure ephemeral=%s live-only raw-pruned later-stages=0\n' "$target"
}
creation_created_then_gone() {
  local index started
  CREATION_GATE=''; CREATION_FAIL_STAGE=''; CREATION_GONE=1
  creation_setup gone; index="$CREATION_INDEX"; creation_open_choice_modal "$index" 1; write_bytes "$index" '\r'; started="$(now)"; creation_submit_first_split "$index"
  wait_for 'creation gone toast' 3 ansi_has "$index" 'pane exited before tagging'
  (( $(record_count "$started" "$(now)" send-keys)==0 )) || die 'created-then-gone ran later stage'
  ! ansi_has "$index" 'tagging failed' || die 'created-then-gone made ephemeral toast'
  CREATION_GONE=''; creation_cleanup "$index"
  printf 'creation created-then-gone no-ephemeral exited-toast later-stages=0\n'
}
creation_concurrent_isolation() {
  local a b started target_a target_b tagged_a tagged_b session_a session_b a_work_offset a_transcript_offset b_work_offset
  local nonce="${RANDOM}${RANDOM}" token_a token_b
  creation_gate_begin concurrent-a; local gate_a="$CREATION_GATE"; token_a="$CREATION_TOKEN"; creation_setup concurrent-a "creation-A-$nonce"; a="$CREATION_INDEX"; local pane_a="$CREATION_PANE" tag_a="${CREATION_SOURCE_TAGS[a]}"
  a_work_offset="$CREATION_POPUP_WORK_OFFSET"
  wait_for 'concurrent popup A initial snapshot provenance' 1.1 creation_popup_work_since "$gate_a" "$a_work_offset" "$token_a" "${POPUP_PIDS[a]}" list-panes
  a_work_offset="$(creation_popup_work_offset "$gate_a")"; a_transcript_offset="$(( $(ansi_size "$a") + 1 ))"
  creation_gate_begin concurrent-b; local gate_b="$CREATION_GATE"; token_b="$CREATION_TOKEN"; creation_setup concurrent-b "creation-B-$nonce" '' 1; local tag_b="$CREATION_DEFERRED_TAG"
  # B is now discoverable but has not opened its own popup, so the recorded
  # query is attributable to A's existing popup/control lineage.
  wait_for 'concurrent popup A transcript includes B tag' 1.1 popup_tail_has "$a" "$a_transcript_offset" "$tag_b"
  creation_open_deferred_source concurrent-b "$tag_a"; b="$CREATION_INDEX"; b_work_offset="$CREATION_POPUP_WORK_OFFSET"; local pane_b="$CREATION_PANE"
  wait_for 'concurrent popup B snapshot provenance' 1.1 creation_popup_work_since "$gate_b" "$b_work_offset" "$token_b" "${POPUP_PIDS[b]}" list-panes
  ansi_has "$b" "$tag_b" || die 'concurrent popup B lost its own tagged source frame'
  creation_open_choice_modal "$a" 1; write_bytes "$a" '\r'
  creation_open_choice_modal "$b" 3; write_bytes "$b" '\r'
  started="$(now)"; creation_submit_first_split "$a"; creation_submit_first_split "$b"
  wait_for 'concurrent creation gate a' 2 creation_gate_started_path "$gate_a"; wait_for 'concurrent creation gate b' 2 creation_gate_started_path "$gate_b"; wait_for 'concurrent pending a' 2 ansi_has "$a" 'creating...'; wait_for 'concurrent pending b' 2 ansi_has "$b" 'creating...'
  session_a="$(admin display-message -p -t "$pane_a" '#{session_id}')"
  session_b="$(admin display-message -p -t "$pane_b" '#{session_id}')"
  creation_gate_release_path "$gate_a"; wait_for 'concurrent creation target a' 3 creation_split_target "$session_a" "$pane_a"
  creation_gate_release_path "$gate_b"
  wait_for 'concurrent creation target b' 3 creation_split_target "$session_b" "$pane_b"
  target_a="$(creation_split_target "$session_a" "$pane_a")"; target_b="$(creation_split_target "$session_b" "$pane_b")"
  wait_for 'concurrent token A tag target' 3 creation_gate_tag_target "$gate_a" "$token_a"
  wait_for 'concurrent token B tag target' 3 creation_gate_tag_target "$gate_b" "$token_b"
  tagged_a="$(creation_gate_tag_target "$gate_a" "$token_a")"; tagged_b="$(creation_gate_tag_target "$gate_b" "$token_b")"
  [[ "$tagged_a" == "$target_a" ]] || die "concurrent token A tagged wrong target: $tagged_a != $target_a"
  [[ "$tagged_b" == "$target_b" ]] || die "concurrent token B tagged wrong target: $tagged_b != $target_b"
  creation_gate_forget_path "$gate_a"; creation_gate_forget_path "$gate_b"
  [[ "$target_a" != "$target_b" ]] || die 'concurrent popups tagged the same target'
  [[ "$(admin display-message -p -t "$target_a" '#{session_id}')" == "$session_a" ]] || die 'concurrent a target/session correlation'
  [[ "$(admin display-message -p -t "$target_b" '#{session_id}')" == "$session_b" ]] || die 'concurrent b target/session correlation'
  (( $(record_count "$started" "$(now)" split-window)==2 )) || die 'concurrent popup creation count'
  (( $(creation_tag_count_since "$started")==2 )) || die 'concurrent popup tag count'
  creation_no_control_argv_since "$started" || die 'concurrent creation used persistent control stdin'
  if ! popup_open "$a" || ! popup_open "$b"; then die 'concurrent workflow crossed popup lifecycle'; fi
  creation_cleanup "$a"; creation_cleanup "$b"
  printf 'creation concurrent popups=2 targets=%s,%s source-sessions=%s,%s isolated-create=2 isolated-tag=2 control=0 closed\n' "$target_a" "$target_b" "$session_a" "$session_b"
}
creation_quit_reaps_blocked_stage() {
  local index started popup_pid child_pid exited
  creation_gate_begin quit; creation_setup quit; index="$CREATION_INDEX"; popup_pid="${POPUP_PIDS[index]}"; creation_open_choice_modal "$index" 1; write_bytes "$index" '\r'; started="$(now)"; creation_submit_first_split "$index"
  wait_for 'creation quit gate' 2 creation_gate_started; child_pid="$(creation_gate_pid "$CREATION_GATE" "$CREATION_TOKEN")"; creation_gate_wrapper_matches "$CREATION_GATE" "$child_pid" "$CREATION_TOKEN" "$WRAP/tmux" || die 'creation quit gate did not expose a unique direct wrapper child'; send_bytes "$index" q
  wait_for 'creation quit popup exit' 2 popup_closed "$index"
  creation_gate_reap "$CREATION_GATE" "$CREATION_TOKEN" "$child_pid"
  (( $(record_count "$started" "$(now)" split-window)==1 )) || die 'creation quit stage-1 count'
  (( $(creation_tag_count_since "$started")==0 && $(record_count "$started" "$(now)" send-keys)==0 )) || die 'creation quit ran a later stage'
  creation_no_control_argv_since "$started" || die 'creation quit used persistent control stdin'
  exited="$(now)"; assert_no_popup_runtime_after_exit 'creation quit-blocked' "$popup_pid" "$exited"
  creation_cleanup "$index"
  printf 'creation quit direct-child=%s reaped popup=%s later-stages=0 control=0 closed\n' "$child_pid" "$popup_pid"
}

creation_scenarios() {
  creation_suite_begin
  creation_choice_order_and_context
  creation_success_responsive
  creation_stage1_retry
  creation_tag_failure_and_gone
  creation_created_then_gone
  creation_concurrent_isolation
  creation_quit_reaps_blocked_stage
  creation_configured_command
}

main() {
  [[ -x "$BIN" ]] || die "missing $BIN; run make build"
  if ! command -v perl >/dev/null || ! command -v script >/dev/null; then die 'perl and script required'; fi
  perl -e 'exit($ARGV[0]=~/^(\d+)\.(\d+)/&&($1>3||$1==3&&$2>=6)?0:1)' "$($REAL_TMUX -V|awk '{print $2}')" || die 'tmux >=3.6 required'
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/pane-dash-live.XXXXXXXX")"; SOCKET="$TMP/socket"; WRAP="$TMP/wrap"; LOG="$TMP/log"; OWNER_LOG="$TMP/owners.tsv"; REJECT="$TMP/reject"; : > "$OWNER_LOG"; make_wrapper
  TMUX='' "$REAL_TMUX" -S "$SOCKET" -f /dev/null new-session -d -s live -x 120 -y 40 'exec cat'
  admin new-session -d -s other -x 120 -y 40 'exec cat'
  local pane target startup old_control t before after captures status_commit
  local status_format_before status_left_before status_right_before status_style_before
  local window_status_before window_status_current_before window_style_before window_current_style_before
  pane="$(admin display-message -p -t live:0.0 '#{pane_id}')"; target="$(admin split-window -d -P -F '#{pane_id}' -t live:0 'exec cat')"
  admin set-option -g @pane-dash-width 100%; admin set-option -g @pane-dash-height 100%; admin set-option -p -t "$pane" @pane_dash_tag live-test; admin set-option -p -t "$target" @pane_dash_tag live-spare
  admin set-option -g 'status-format[0]' '#[fg=colour123]task3-first-row #{session_name}'
  admin set-option -g status-left 'task3-left'
  admin set-option -g status-right 'task3-right'
  admin set-option -g status-style 'fg=colour45,bg=colour234'
  admin set-option -g window-status-format 'task3-window-#I'
  admin set-option -g window-status-current-format 'task3-current-#I'
  admin set-option -g window-status-style 'fg=colour33'
  admin set-option -g window-status-current-style 'fg=colour44'
  status_format_before="$(admin show-options -gv 'status-format[0]')"
  status_left_before="$(admin show-options -gv status-left)"
  status_right_before="$(admin show-options -gv status-right)"
  status_style_before="$(admin show-options -gv status-style)"
  window_status_before="$(admin show-options -gv window-status-format)"
  window_status_current_before="$(admin show-options -gv window-status-current-format)"
  window_style_before="$(admin show-options -gv window-status-style)"
  window_current_style_before="$(admin show-options -gv window-status-current-style)"
  TASK9_MARKER="$TMP/task9-marker"
  admin set-environment -g PATH "$WRAP:$PATH"; admin set-environment -g PD_REAL_TMUX "$REAL_TMUX"; admin set-environment -g PD_SOCKET "$SOCKET"; admin set-environment -g PD_LOG "$LOG"; admin set-environment -g PD_OWNER_LOG "$OWNER_LOG"; admin set-environment -g PD_REJECT "$REJECT"; admin set-environment -g PD_TASK9_MARKER "$TASK9_MARKER"
  # Install pane_dash.tmux through the wrapper; do not directly run pane-dash.
  PATH="$WRAP:$PATH" PD_REAL_TMUX="$REAL_TMUX" PD_SOCKET="$SOCKET" PD_LOG="$LOG" PD_OWNER_LOG="$OWNER_LOG" PD_REJECT="$REJECT" TMUX='' "$ROOT/pane_dash.tmux"
  PATH="$WRAP:$PATH" PD_REAL_TMUX="$REAL_TMUX" PD_SOCKET="$SOCKET" PD_LOG="$LOG" PD_OWNER_LOG="$OWNER_LOG" PD_REJECT="$REJECT" TMUX='' "$ROOT/pane_dash.tmux"
  [[ "$(admin show-options -gv 'status-format[0]')" == "$status_format_before" ]] || die 'notification row changed status-format[0]'
  [[ "$(admin show-options -gv status-left)" == "$status_left_before" ]] || die 'notification row changed status-left'
  [[ "$(admin show-options -gv status-right)" == "$status_right_before" ]] || die 'notification row changed status-right'
  [[ "$(admin show-options -gv status-style)" == "$status_style_before" ]] || die 'notification row changed status-style'
  [[ "$(admin show-options -gv window-status-format)" == "$window_status_before" ]] || die 'notification row changed window-status-format'
  [[ "$(admin show-options -gv window-status-current-format)" == "$window_status_current_before" ]] || die 'notification row changed window-status-current-format'
  [[ "$(admin show-options -gv window-status-style)" == "$window_style_before" ]] || die 'notification row changed window-status-style'
  [[ "$(admin show-options -gv window-status-current-style)" == "$window_current_style_before" ]] || die 'notification row changed window-status-current-style'
  [[ "$(admin show-options -gv status)" == 2 ]] || die 'notification status line count is not exactly two'
  wait_for 'one notification service after idempotent reload' 3 notification_service_one
  [[ -z "$(notification_status)" ]] || die 'empty notification queue rendered a nonblank row'
  [[ "$(admin show-options -gv focus-events)" == on ]] || die 'production plugin did not enable focus-events'
  terminal_features="$(admin show-options -sv terminal-features)"
  grep -Fxq '*:focus' <<< "$terminal_features" || die 'production plugin did not enable terminal focus feature'
  start_client live first; start_client live second
  [[ -n "${CLIENT_PIDS[0]:-}" && -n "${CLIENT_TTYS[0]:-}" && -n "${CLIENT_PIDS[1]:-}" && -n "${CLIENT_TTYS[1]:-}" ]] || die 'client identity mapping'
  open_popup 0; [[ -n "${POPUP_CONTROLS[0]:-}" && -n "${POPUP_PIDS[0]:-}" ]] || die 'first popup owner mapping'; wait_for 'first popup frame' 3 ansi_has 0 live-test; (( $(control_count)==1 )) || die 'first popup control count'
  open_popup 1; [[ -n "${POPUP_CONTROLS[1]:-}" && "${POPUP_CONTROLS[0]}" != "${POPUP_CONTROLS[1]}" && -n "${POPUP_PIDS[1]:-}" && "${POPUP_PIDS[0]}" != "${POPUP_PIDS[1]}" ]] || die 'independent popup control/pid mapping'; wait_for 'independent popup controls' 3 has_two_controls
  before="$(ansi_size 0)"; admin resize-window -t live:0 -x 99 -y 32; send_bytes 0 '\014'; wait_for '99-column layout transcript' 2 ansi_grew_from 0 "$before"; ansi_tail_has 0 "$((before+1))" '─' || die '99-column transcript lacks vertical preview border'
  before="$(ansi_size 0)"; admin resize-window -t live:0 -x 100 -y 32; send_bytes 0 '\014'; wait_for '100-column layout transcript' 2 ansi_grew_from 0 "$before"; ansi_tail_has 0 "$((before+1))" '│' || die '100-column transcript lacks horizontal preview border'; has_two_controls || die 'resize panicked popup'
  # All open/binary option reads must settle before the runtime assertion.
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
  status_commit="$(now)"
  # A list-panes request that races the first two option writes can legitimately
  # render the prior incoherent status. Require a snapshot started after the
  # coherent triple was committed and its fresh frame from this popup owner.
  wait_for 'fresh coherent status snapshot <=1.1s' 1.1 status_snapshot_rendered "$status_commit" "$((status_offset + 1))" "${POPUP_PIDS[0]}" idle
  (( $(record_count "$t" "$(now)" show-options)==0 )) || die 'status polling used show-options'
  # The selected visible cat pane receives literal hostile text before it is
  # killed. $target remains alive to keep the attached session/popup valid.
  local sentinel="$TMP/sentinel" hostile="; touch $TMP/sentinel #" selected_pane
  send_bytes 0 '\023'; send_bytes 0 "$hostile"; sleep .25; send_bytes 0 '\r'
  wait_for 'literal hostile send reaches selected cat pane' 2 selected_pane_contains
  [[ ! -e "$sentinel" ]] || die 'hostile send sentinel'
  [[ "$selected_pane" == "$pane" ]] || send_bytes 0 k
  send_bytes 0 x; send_bytes 0 y; wait_for 'confirmed selected-pane kill' 2 target_gone "$pane"; target_present "$target" || die 'spare pane did not survive selected kill'
  send_bytes 0 q; wait_for 'healthy popup pane-dash exit' 2 popup_closed 0; t="$(now)"; ! control_present "${POPUP_CONTROLS[0]}" || die 'healthy popup control survived pane-dash exit'; sleep .2; (( $(runtime_count "$t" "$(now)")==0 )) || die 'closed popup runtime work'
  rm -f "$REJECT"
  unrelated_session_changes_keep_popup_open
  destroy_popup_detach_off
  destroy_popup_detach_on
  destroy_popup_while_degraded
  task9_scenarios
  phase6_theme_help_isolation
  terminal_features="$(admin show-options -sv terminal-features)"
  ! grep -Fxq '*:RGB' <<< "$terminal_features" || die 'phase6 RGB capability leaked after scenario cleanup'
  grep -Fxq '*:focus' <<< "$terminal_features" || die 'phase6 RGB cleanup did not preserve terminal-features entries'
  creation_scenarios
  notification_scenario
   printf 'ok: controls startup=2 replacement=1 rejected=1; process budgets passed\n'
}
session_gone() { ! admin has-session -t "$1" 2>/dev/null; }
control_is_zero() { (( $(control_count)==0 )); }
popup_pid_tracking_self_test() {
  local popup_pid
  sleep 5 & popup_pid=$!
  # shellcheck disable=SC2317,SC2329 # popup_closed invokes this test override indirectly.
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
