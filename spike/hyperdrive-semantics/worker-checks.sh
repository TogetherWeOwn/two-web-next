#!/usr/bin/env bash
# One-shot local Worker test; the runner starts and stops its own dev server.
# Does not use Cloudflare credentials or the Hyperdrive origin pooler.
#
# The node runner bounds startup internally (exit 2 on never-ready startup),
# but only this wrapper can terminate a hung startup: it owns the runner's
# process group (set -m) and TERM/KILLs it on expiry. A Promise.race alone
# would leave the workerd child running. TIMEOUT_S covers startup (180s) +
# readiness retries (~115s) + checks (30s) with margin.
set -euo pipefail
TIMEOUT_S=600
./node_modules/.bin/wrangler --version
set -m
node spike/hyperdrive-semantics/worker-checks.mjs &
runner=$!
cleanup() {
  kill -TERM -- "-$runner" 2>/dev/null || kill -TERM "$runner" 2>/dev/null || true
  sleep 5
  kill -KILL -- "-$runner" 2>/dev/null || kill -KILL "$runner" 2>/dev/null || true
  wait "$runner" 2>/dev/null || true
}
deadline=$((SECONDS + TIMEOUT_S))
while kill -0 "$runner" 2>/dev/null; do
  if ((SECONDS >= deadline)); then
    echo "worker-checks.sh: runner exceeded ${TIMEOUT_S}s; terminating process group" >&2
    cleanup
    exit 124
  fi
  sleep 2
done
wait "$runner"
