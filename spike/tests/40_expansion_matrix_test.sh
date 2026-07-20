#!/usr/bin/env bash
# Regression checks for the expansion probe's compatibility contract gate.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$SPIKE_DIR/probes/40_expansion_matrix.sh"

if [[ ! -x "$probe" ]]; then
  echo "missing executable expansion-matrix probe: $probe" >&2
  exit 1
fi

# Local tmux versions may support hash doubling, so assert the failure path is
# wired structurally as well as executing the probe's supported-version path.
grep -q '^doubling_contract_failures=0$' "$probe"
grep -A1 'DOUBLING_BROKEN got=' "$probe" | grep -q 'doubling_contract_failures=.*+ 1'
grep -q 'if (( doubling_contract_failures > 0 )); then' "$probe"

bash "$probe"

tmux_version="$(TMUX='' "${TMUX_BIN:-tmux}" -V | tr ' ' '_')"
artifact="$SPIKE_DIR/results/$tmux_version/40_expansion_matrix.txt"

grep -q '^new-session -s: ' "$artifact"
! grep -q 'DOUBLING_BROKEN' "$artifact"
