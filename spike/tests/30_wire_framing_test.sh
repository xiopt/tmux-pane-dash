#!/usr/bin/env bash
# End-to-end acceptance checks for the wire/framing transport probe.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$SPIKE_DIR/probes/30_wire_framing.sh"

if [[ ! -x "$probe" ]]; then
  echo "missing executable wire/framing probe: $probe" >&2
  exit 1
fi

bash "$probe"

tmux_version="$(TMUX='' "${TMUX_BIN:-tmux}" -V | tr ' ' '_')"
artifact="$SPIKE_DIR/results/$tmux_version/30_wire_framing.txt"

grep -q '^FINDING: channel double-quoted octal: PASS ' "$artifact" ||
  grep -q '^FINDING: channel raw control bytes: PASS ' "$artifact"
grep -q '^FINDING: one-shot argv raw bytes: PASS ' "$artifact"
grep -q '^FINDING: select-pane -T rejects embedded newlines on tmux ' "$artifact"
grep -q '^FINDING: guard-mimicking frame: PASS ' "$artifact"
