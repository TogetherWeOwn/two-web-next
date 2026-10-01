#!/usr/bin/env bash
# Staging acceptance only: ephemeral edge preview, not wrangler deploy/local control.
set -euo pipefail
scratch="${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-}}"
[[ -n "$scratch" && -d "$scratch" ]] || { printf '%s\n' 'Paperclip run scratch required' >&2; exit 2; }
./node_modules/.bin/esbuild spike/hyperdrive-semantics/remote-runner.ts \
  --bundle --platform=node --format=esm --outfile="$scratch/w1-remote-runner.mjs"
timeout --kill-after=10s 600s node "$scratch/w1-remote-runner.mjs" --run
