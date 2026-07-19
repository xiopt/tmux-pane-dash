#!/usr/bin/env bash
# End-to-end acceptance checks for the encoding round-trip probe.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$SPIKE_DIR/probes/50_encoding_roundtrip.sh"

assert_leading_dash_consistency() { # $1=artifact
  local artifact="$1"

  if grep -q '^FINDING: new-session -s leading-dash probe: ROUNDTRIP_OK$' "$artifact"; then
    grep -q '^expanded/leading-dash: ROUNDTRIP_OK$' "$artifact"
  elif grep -q '^FINDING: new-session -s leading-dash probe: REJECTED ' "$artifact"; then
    grep -q '^expanded/leading-dash: FIELD_CONSTRAINT:' "$artifact"
  else
    echo "leading-dash capability probe has no supported/rejected verdict" >&2
    return 1
  fi
}

inconsistent_fixture="$(mktemp)"
trap 'rm -f "$inconsistent_fixture"' EXIT
printf '%s\n' \
  'FINDING: new-session -s leading-dash probe: ROUNDTRIP_OK' \
  'expanded/leading-dash: FIELD_CONSTRAINT: rejected' > "$inconsistent_fixture"
if assert_leading_dash_consistency "$inconsistent_fixture"; then
  echo 'leading-dash consistency assertion accepted an inconsistent fixture' >&2
  exit 1
fi

[[ -x "$probe" ]]
grep -q '^encode_expanded()' "$probe"
grep -q '^encode_plain()' "$probe"
grep -q 'new-session -d -s' "$probe"
grep -q "new-session -d -s '-pd_separator_probe'" "$probe"
grep -q 'set-option -p' "$probe"
awk '/^style_marker\(\)/,/^sentinel_expanded\(\)/' "$probe" | grep -q 'grep -Fvx base'
awk '/^style_marker\(\)/,/^sentinel_expanded\(\)/' "$probe" | grep -q "record_error 'style-marker readback failed'"

bash "$probe"

tmux_version="$(TMUX='' "${TMUX_BIN:-tmux}" -V | tr ' ' '_')"
artifact="$SPIKE_DIR/results/$tmux_version/50_encoding_roundtrip.txt"

for label in \
  plain interior-semi trailing-semi double-trailing hash \
  hash-brace unmatched-open raw-close hash-close hash-paren cross-product \
  unicode spaces quotes; do
  grep -q "^expanded/$label: ROUNDTRIP_OK$" "$artifact"
  grep -q "^plain/$label: ROUNDTRIP_OK$" "$artifact"
done

assert_leading_dash_consistency "$artifact"
grep -q '^plain/leading-dash: ROUNDTRIP_OK$' "$artifact"

for label in pre-backslashed lone-backslash double-backslash-semi interior-backslash; do
  grep -q "^plain/$label: ROUNDTRIP_OK$" "$artifact"
  grep -Eq "^FINDING: backslash mangled in expanded name field on $tmux_version: $label: (MANGLED|REJECTED|ROUNDTRIP) " "$artifact"
done

grep -Eq '^style-marker: (MANGLED|REJECTED|ROUNDTRIP) ' "$artifact"
grep -q '^FINDING: sentinel/expanded counts .*name=\[x; new-window\] expected=\[x; new-window\]$' "$artifact"
grep -q '^FINDING: sentinel/plain counts ' "$artifact"
grep -q '^sentinel/expanded: NO_INJECTION$' "$artifact"
grep -q '^sentinel/plain: NO_INJECTION$' "$artifact"
grep -Fqx 'FINDINGS: encoder rules validated = trailing-; escape + ## doubling + reject #[ + reject \ (expanded fields only)' "$artifact"
! grep -qE 'MISMATCH|INJECTION_DETECTED|ERROR:' "$artifact"
