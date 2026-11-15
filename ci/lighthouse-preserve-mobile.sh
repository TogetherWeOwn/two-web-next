#!/usr/bin/env bash
set -euo pipefail

# Snapshot partial mobile output before desktop clears the shared LHCI directory.
# This diagnostic copy is never used for sample accounting or budget verdicts.
dir=${1:-.lighthouseci}
if [[ ! -d "$dir" ]]; then
  exit 0
fi
mkdir -p "$dir/mobile-interrupted"
find "$dir" -maxdepth 1 -type f \
  \( -regextype posix-extended -regex '.*/lhr-[0-9]+\.(json|html)' -o -name assertion-results.json \) \
  -exec cp -- '{}' "$dir/mobile-interrupted/" \;
