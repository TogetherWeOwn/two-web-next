#!/usr/bin/env bash
set -euo pipefail

# Keep fixtures under the project root so they use the real Biome configuration.
fixture_dir=$(mktemp -d .biome-selftest.XXXXXXXX)
trap 'rm -rf "$fixture_dir"' EXIT

expect_rejection() {
  local diagnostic=$1
  if npm run lint > "$fixture_dir/output.log" 2>&1; then
    printf 'FAIL: Biome accepted %s\n' "$diagnostic" >&2
    exit 1
  fi
  if ! grep -q "$diagnostic" "$fixture_dir/output.log"; then
    printf 'FAIL: expected %s diagnostic\n' "$diagnostic" >&2
    exit 1
  fi
  printf 'PASS: npm run lint rejects %s\n' "$diagnostic"
}

printf 'debugger;\n' > "$fixture_dir/probe.ts"
expect_rejection 'lint/suspicious/noDebugger'
printf 'const unused = 1;\n' > "$fixture_dir/probe.ts"
expect_rejection 'lint/correctness/noUnusedVariables'
printf 'export async function probe() {}\nprobe();\n' > "$fixture_dir/probe.ts"
expect_rejection 'lint/nursery/noFloatingPromises'
printf 'export const value={answer:42};\n' > "$fixture_dir/probe.ts"
expect_rejection 'format'
