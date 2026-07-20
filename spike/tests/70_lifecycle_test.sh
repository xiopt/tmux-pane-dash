#!/usr/bin/env bash
# End-to-end acceptance checks for lifecycle transport findings.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$SPIKE_DIR/probes/70_lifecycle.sh"
fixture="$(mktemp "${TMPDIR:-/tmp}/tmux-pane-dash-zoom.XXXXXX")"

cleanup() {
  rm -f "$fixture"
}
trap cleanup EXIT

if [[ ! -x "$probe" ]]; then
  echo "missing executable lifecycle probe: $probe" >&2
  exit 1
fi

printf 'FINDING: switch-client -Z zoomed=1\n' > "$fixture"
if bash "$probe" --assert-switch-zoom "$fixture"; then
  echo "zoomed=1 fixture was accepted" >&2
  exit 1
fi

bash "$probe"

tmux_version="$(TMUX='' "${TMUX_BIN:-tmux}" -V | tr ' ' '_')"
artifact="$SPIKE_DIR/results/$tmux_version/70_lifecycle.txt"

bash "$probe" --assert-switch-zoom "$artifact"
dollar='$'
grep -Fq "[[ \"${dollar}switch_zoomed\" == 0 ]]" "$probe"
