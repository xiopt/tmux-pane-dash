#!/usr/bin/env bash
# End-to-end acceptance checks for the encoding round-trip probe.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$SPIKE_DIR/probes/50_encoding_roundtrip.sh"

[[ -x "$probe" ]]
grep -q '^encode_expanded()' "$probe"
grep -q '^encode_plain()' "$probe"
grep -q 'new-session -d -s' "$probe"
grep -q 'set-option -p' "$probe"

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

grep -Eq '^expanded/leading-dash: (ROUNDTRIP_OK|FIELD_CONSTRAINT:)' "$artifact"
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
