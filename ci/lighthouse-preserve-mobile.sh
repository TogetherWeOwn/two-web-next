#!/usr/bin/env bash
set -euo pipefail

# Snapshot mobile output before desktop clears the shared LHCI directory.
# This diagnostic copy is never used for sample accounting or budget verdicts.
dir=${1:-.lighthouseci}
if [[ ! -d "$dir" ]]; then
  exit 0
fi
if [[ ${2:-} == mobile-fixture ]]; then
  snapshot=$dir/mobile-fixture
  # Refuse to mix samples if this one-shot snapshot already exists.
  mkdir -- "$snapshot"
  find "$dir" -maxdepth 1 -type f \
    \( -regextype posix-extended -regex '.*/lhr-[0-9]+(-[0-9]+)?\.json' -o -name assertion-results.json \) \
    -exec cp -t "$snapshot" -- '{}' +
else
  mkdir -p "$dir/mobile-interrupted"
  find "$dir" -maxdepth 1 -type f \
    \( -regextype posix-extended -regex '.*/lhr-[0-9]+(-[0-9]+)?\.(json|html)' -o -name assertion-results.json \) \
    -exec cp -- '{}' "$dir/mobile-interrupted/" \;
fi
