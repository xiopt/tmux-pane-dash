#!/usr/bin/env bash
# End-to-end acceptance checks for the wire/framing transport probe.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$SPIKE_DIR/probes/30_wire_framing.sh"

if [[ ! -x "$probe" ]]; then
  echo "missing executable wire/framing probe: $probe" >&2
  exit 1
fi

# Keep the regression gates structural as well as end-to-end: the local tmux
# version happens to pass both constructions, so a weakened one-of-two gate
# would otherwise be invisible in the recorded artifact.
grep -q '(( channel_passes == 2 ))' "$probe"
grep -q 'fake_seen = 0' "$probe"
grep -q 'guard-mimicking frame: SKIP (synthetic fixture only' "$probe"

bash "$probe"

tmux_version="$(TMUX='' "${TMUX_BIN:-tmux}" -V | tr ' ' '_')"
artifact="$SPIKE_DIR/results/$tmux_version/30_wire_framing.txt"

grep -q '^FINDING: channel double-quoted octal: PASS ' "$artifact"
grep -q '^FINDING: channel raw control bytes: PASS ' "$artifact"
grep -q '^FINDING: one-shot argv raw bytes: PASS ' "$artifact"
grep -q '^FINDING: select-pane -T rejects embedded newlines on tmux ' "$artifact"
grep -q '^FINDING: pane option @pd_evil preserves embedded newlines on tmux ' "$artifact"
grep -q '^FINDING: guard-mimicking frame: PASS ' "$artifact"
! grep -q '^FINDING: guard-mimicking frame: SKIP ' "$artifact"
