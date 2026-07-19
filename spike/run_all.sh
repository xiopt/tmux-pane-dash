#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")"
fail=0
for p in probes/*.sh; do
  echo "== $p"
  if bash "$p"; then echo "   ok"; else echo "   FAIL"; fail=1; fi
done
exit $fail
