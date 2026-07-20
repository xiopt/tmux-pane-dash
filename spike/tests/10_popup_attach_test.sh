#!/usr/bin/env bash
# End-to-end acceptance checks for the popup attach and argv transport probe.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$SPIKE_DIR/probes/10_popup_attach.sh"

if [[ ! -x "$probe" ]]; then
  echo "missing executable popup attach probe: $probe" >&2
  exit 1
fi

# Keep the argv check structural as well as end-to-end: the artifact must only
# report success after comparing the inner command's exact argument vector.
grep -q 'argv_form_passed' "$probe"
dollar='$'
grep -Fq "cmp -s \"${dollar}argv_expected\" \"${dollar}argv_out\"" "$probe"

bash "$probe"

tmux_version="$(TMUX='' "${TMUX_BIN:-tmux}" -V | tr ' ' '_')"
artifact="$SPIKE_DIR/results/$tmux_version/10_popup_attach.txt"

grep -q '^VERDICT: popup-interior control attach WORKS$' "$artifact"
grep -q '^FINDING: display-popup multi-argument argv preserves hostile args exactly ' "$artifact"
