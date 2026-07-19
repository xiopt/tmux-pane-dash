#!/usr/bin/env bash
# Validate the expanded and plain §8 encoders against their actual tmux fields.
set -euo pipefail

export TMUX=''
# shellcheck disable=SC1091 # The shared harness is resolved relative to this probe.
source "$(dirname "$0")/../lib.sh"

A="50_encoding_roundtrip.txt"
pd_reset_artifact "$A"

sock="$(pd_server enc)"
operational_failures=0
contract_failures=0
separator_supported=false

cleanup() {
  TMUX='' pd_kill_server "$sock"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

t() {
  TMUX='' "$TMUX_BIN" -L "$sock" "$@"
}

fresh_server() {
  TMUX='' pd_new_server "$sock"
}

encode_expanded() { # Format expansion consumes ## as one literal #.
  local value="${1//\#/##}"
  [[ "$value" == *';' ]] && value="${value%;}\\;"
  printf '%s' "$value"
}

encode_plain() { # Non-expanded fields still need their trailing semicolon escaped.
  local value="$1"
  [[ "$value" == *';' ]] && value="${value%;}\\;"
  printf '%s' "$value"
}

record_error() { # $1=label, remaining args=error text
  local label="$1"
  shift
  pd_record "$A" "ERROR: $label: $*"
  operational_failures=$((operational_failures + 1))
}

check_separator_support() {
  local error names

  fresh_server
  if error="$(t new-session -d -s -- pd_separator_probe 2>&1)" &&
    names="$(t list-sessions -F '#{session_name}')" &&
    grep -Fqx -- pd_separator_probe <<<"$names"; then
    separator_supported=true
    if ! error="$(t kill-session -t pd_separator_probe 2>&1)"; then
      record_error 'argv separator cleanup failed' "$error"
    fi
    pd_record "$A" 'FINDING: new-session -- supports leading-dash session names'
  else
    pd_record "$A" "FINDING: new-session -- unsupported or not an argv separator: [$error]"
  fi
}

new_session() { # $1=encoded name; uses -- only when it is a verified separator.
  if [[ "$separator_supported" == true ]]; then
    t new-session -d -s -- "$1"
  else
    t new-session -d -s "$1"
  fi
}

expanded_roundtrip() { # $1=label $2=raw value
  local label="$1"
  local raw="$2"
  local encoded error got

  fresh_server
  encoded="$(encode_expanded "$raw")"
  if [[ "$raw" == -* && "$separator_supported" != true ]]; then
    pd_record "$A" "expanded/$label: FIELD_CONSTRAINT: leading-dash requires unsupported --"
    return
  fi

  if ! error="$(new_session "$encoded" 2>&1)"; then
    if [[ "$label" == leading-dash ]]; then
      pd_record "$A" "expanded/$label: FIELD_CONSTRAINT: rejected raw=[$raw] error=[$error]"
    else
      pd_record "$A" "expanded/$label: REJECTED raw=[$raw] error=[$error]"
      contract_failures=$((contract_failures + 1))
    fi
    return
  fi

  if ! got="$(t list-sessions -F '#{session_name}' 2>&1)"; then
    record_error "expanded/$label readback failed" "$got"
  elif grep -Fqx -- "$raw" <<<"$got"; then
    pd_record "$A" "expanded/$label: ROUNDTRIP_OK"
  else
    pd_record "$A" "expanded/$label: MISMATCH raw=[$raw] encoded=[$encoded] got=[$got]"
  fi

  if ! error="$(t kill-session -t "$raw" 2>&1)"; then
    record_error "expanded/$label cleanup failed" "$error"
  fi
}

plain_roundtrip() { # $1=label $2=raw value
  local label="$1"
  local raw="$2"
  local encoded error got

  fresh_server
  encoded="$(encode_plain "$raw")"
  if ! error="$(t set-option -p -t base:0.0 @pd_rt "$encoded" 2>&1)"; then
    record_error "plain/$label action failed" "$error"
    return
  fi
  if ! got="$(t display-message -p -t base:0.0 '#{@pd_rt}' 2>&1)"; then
    record_error "plain/$label readback failed" "$got"
  elif [[ "$got" == "$raw" ]]; then
    pd_record "$A" "plain/$label: ROUNDTRIP_OK"
  else
    pd_record "$A" "plain/$label: MISMATCH raw=[$raw] encoded=[$encoded] got=[$got]"
  fi
}

record_expanded_backslash_finding() { # $1=label $2=raw value
  local label="$1"
  local raw="$2"
  local encoded error got

  fresh_server
  encoded="$(encode_expanded "$raw")"
  if ! error="$(new_session "$encoded" 2>&1)"; then
    pd_record "$A" "FINDING: backslash mangled in expanded name field on $TMUX_VERSION: $label: REJECTED raw=[$raw] got=[$error]"
    return
  fi
  got="$(t list-sessions -F '#{session_name}' | grep -Fvx base)"
  if [[ "$got" == "$raw" ]]; then
    pd_record "$A" "FINDING: backslash mangled in expanded name field on $TMUX_VERSION: $label: ROUNDTRIP raw=[$raw] got=[$got]"
    contract_failures=$((contract_failures + 1))
  else
    pd_record "$A" "FINDING: backslash mangled in expanded name field on $TMUX_VERSION: $label: MANGLED raw=[$raw] got=[$got]"
  fi
}

style_marker() {
  local raw='#[fg=red]x'
  local encoded got error outcome

  fresh_server
  encoded="$(encode_expanded "$raw")"
  if ! error="$(new_session "$encoded" 2>&1)"; then
    pd_record "$A" "style-marker: REJECTED raw=[$raw] encoded=[$encoded] got=[$error]"
    return
  fi
  if ! got="$(t list-sessions -F '#{session_name}' | grep -Fvx base)"; then
    record_error 'style-marker readback failed' "$got"
    return
  fi
  if [[ "$got" == "$raw" ]]; then
    outcome=ROUNDTRIP
    contract_failures=$((contract_failures + 1))
  else
    outcome=MANGLED
  fi
  pd_record "$A" "style-marker: $outcome raw=[$raw] encoded=[$encoded] got=[$got]"
}

sentinel_expanded() {
  local raw='x; new-window'
  local encoded before_windows before_sessions created_windows created_sessions after_windows after_sessions candidate error

  fresh_server
  encoded="$(encode_expanded "$raw")"
  before_windows="$(t list-windows -a | wc -l | tr -d ' ')"
  before_sessions="$(t list-sessions | wc -l | tr -d ' ')"
  if ! error="$(new_session "$encoded" 2>&1)"; then
    record_error 'sentinel/expanded action failed' "$error"
    return
  fi
  candidate="$(t list-sessions -F '#{session_name}' | grep -Fvx base)"
  created_windows="$(t list-windows -a | wc -l | tr -d ' ')"
  created_sessions="$(t list-sessions | wc -l | tr -d ' ')"
  if [[ "$candidate" != "$encoded" ]] ||
    (( created_windows != before_windows + 1 )) ||
    (( created_sessions != before_sessions + 1 )); then
    pd_record "$A" 'sentinel/expanded: INJECTION_DETECTED'
    pd_record "$A" "FINDING: sentinel/expanded before=(windows=$before_windows sessions=$before_sessions) created=(windows=$created_windows sessions=$created_sessions) name=[$candidate] expected=[$encoded]"
    contract_failures=$((contract_failures + 1))
    return
  fi
  if ! error="$(t kill-session -t "$candidate" 2>&1)"; then
    record_error 'sentinel/expanded cleanup failed' "$error"
    return
  fi
  after_windows="$(t list-windows -a | wc -l | tr -d ' ')"
  after_sessions="$(t list-sessions | wc -l | tr -d ' ')"
  if (( after_windows == before_windows && after_sessions == before_sessions )); then
    pd_record "$A" "FINDING: sentinel/expanded counts before=(windows=$before_windows sessions=$before_sessions) created=(windows=$created_windows sessions=$created_sessions) after=(windows=$after_windows sessions=$after_sessions) name=[$candidate] expected=[$encoded]"
    pd_record "$A" 'sentinel/expanded: NO_INJECTION'
  else
    pd_record "$A" 'sentinel/expanded: INJECTION_DETECTED'
    pd_record "$A" "FINDING: sentinel/expanded before=(windows=$before_windows sessions=$before_sessions) after=(windows=$after_windows sessions=$after_sessions)"
    contract_failures=$((contract_failures + 1))
  fi
}

sentinel_plain() {
  local raw='x; new-window'
  local encoded before_windows before_sessions after_windows after_sessions error

  fresh_server
  encoded="$(encode_plain "$raw")"
  before_windows="$(t list-windows -a | wc -l | tr -d ' ')"
  before_sessions="$(t list-sessions | wc -l | tr -d ' ')"
  if ! error="$(t set-option -p -t base:0.0 @pd_rt "$encoded" 2>&1)"; then
    record_error 'sentinel/plain action failed' "$error"
  fi
  after_windows="$(t list-windows -a | wc -l | tr -d ' ')"
  after_sessions="$(t list-sessions | wc -l | tr -d ' ')"
  if (( after_windows == before_windows && after_sessions == before_sessions )); then
    pd_record "$A" "FINDING: sentinel/plain counts before=(windows=$before_windows sessions=$before_sessions) after=(windows=$after_windows sessions=$after_sessions)"
    pd_record "$A" 'sentinel/plain: NO_INJECTION'
  else
    pd_record "$A" 'sentinel/plain: INJECTION_DETECTED'
    pd_record "$A" "FINDING: sentinel/plain before=(windows=$before_windows sessions=$before_sessions) after=(windows=$after_windows sessions=$after_sessions)"
    contract_failures=$((contract_failures + 1))
  fi
}

check_separator_support

expanded_labels=(
  plain interior-semi trailing-semi double-trailing hash
  hash-brace unmatched-open raw-close hash-close hash-paren cross-product
  unicode leading-dash spaces quotes
)
expanded_values=(
  'hello' 'a;b' 'a;' 'a;;' 'a#b' 'a#{x}b' 'a#{b' 'a}b' 'a#}b'
  'a#(echo hi)b' 'a#b;' 'ünïcödé—π' '-foo' 'a space b' 'a"quote"b'
)

for index in "${!expanded_labels[@]}"; do
  expanded_roundtrip "${expanded_labels[$index]}" "${expanded_values[$index]}"
  plain_roundtrip "${expanded_labels[$index]}" "${expanded_values[$index]}"
done

backslash_labels=(pre-backslashed lone-backslash double-backslash-semi interior-backslash)
backslash_values=('a\;' "a\\" 'a\\;' 'a\b;')
for index in "${!backslash_labels[@]}"; do
  record_expanded_backslash_finding "${backslash_labels[$index]}" "${backslash_values[$index]}"
  plain_roundtrip "${backslash_labels[$index]}" "${backslash_values[$index]}"
done

style_marker
sentinel_expanded
sentinel_plain

pd_record "$A" 'FINDINGS: encoder rules validated = trailing-; escape + ## doubling + reject #[ + reject \ (expanded fields only)'

if grep -qE 'MISMATCH|INJECTION_DETECTED|ERROR:' "$(pd_artifact "$A")"; then
  exit 1
fi
(( operational_failures == 0 ))
(( contract_failures == 0 ))
