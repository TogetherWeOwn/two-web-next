#!/usr/bin/env bash
# One-shot local Worker test; the runner starts and stops its own dev server.
# Does not use Cloudflare credentials or the Hyperdrive origin pooler.
#
# The node runner bounds startup internally (exit 2 on never-ready startup),
# but only this wrapper can terminate a hung startup: it owns the runner's
# process group (set -m) and TERM/KILLs survivors whenever the runner exits
# (any status) and when this wrapper is interrupted, preserving the runner's
# exit status. A Promise.race alone would leave the workerd child running.
# TIMEOUT_S covers startup (180s) + readiness retries (~115s) + checks (30s)
# with margin.
#
# NODE_BIN / WRANGLER_BIN override the executables (defaults: the repo's node
# and wrangler) so the teardown boundary is testable offline with inert fakes.
set -euo pipefail
TIMEOUT_S=600
NODE_BIN="${NODE_BIN:-node}"
WRANGLER_BIN="${WRANGLER_BIN:-./node_modules/.bin/wrangler}"
"$WRANGLER_BIN" --version
set -m
"$NODE_BIN" spike/hyperdrive-semantics/worker-checks.mjs &
runner=$!
# Reap survivors in the runner's process group without masking the caller's
# saved exit status (always returns 0; callers exit explicitly afterwards).
cleanup_group() {
  kill -TERM -- "-$runner" 2>/dev/null || kill -TERM "$runner" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 -- "-$runner" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL -- "-$runner" 2>/dev/null || kill -KILL "$runner" 2>/dev/null || true
  wait "$runner" 2>/dev/null || true
}
on_interrupt() {
  trap '' INT TERM HUP
  cleanup_group
  exit 143
}
trap on_interrupt INT TERM HUP
deadline=$((SECONDS + TIMEOUT_S))
while kill -0 "$runner" 2>/dev/null; do
  if ((SECONDS >= deadline)); then
    echo "worker-checks.sh: runner exceeded ${TIMEOUT_S}s; terminating process group" >&2
    cleanup_group
    exit 124
  fi
  sleep 2
done
set +e
wait "$runner"
runner_exit=$?
set -e
cleanup_group
exit "$runner_exit"
