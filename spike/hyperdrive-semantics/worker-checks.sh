#!/usr/bin/env bash
# One-shot local Worker test; the runner starts and stops its own dev server.
# Does not use Cloudflare credentials or the Hyperdrive origin pooler.
set -euo pipefail
./node_modules/.bin/wrangler --version
node spike/hyperdrive-semantics/worker-checks.mjs
