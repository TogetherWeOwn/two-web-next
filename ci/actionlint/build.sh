#!/usr/bin/env bash
# Actions-only stock build; never install the checker on the host.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { printf '%s\n' 'Run this gate in GitHub Actions.' >&2; exit 1; }
root=$(git rev-parse --show-toplevel)
work=$(mktemp -d "${RUNNER_TEMP:?}/actionlint-queue.XXXXXX")
cleanup() {
  local status=$?
  # Go's module cache is read-only, including its versioned directories.
  if [[ -d "$work/modules" ]] && ! chmod -R u+w "$work/modules"; then
    status=1
  fi
  if ! rm -rf -- "$work" || [[ -e "$work" ]]; then
    printf '%s\n' 'Temporary directory cleanup failed.' >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
mkdir "$work/source" "$work/toolchain" "$work/modules" "$work/cache"

curl -fsSL --retry 2 --connect-timeout 20 --max-time 180 \
  https://codeload.github.com/rhysd/actionlint/tar.gz/03d0035246f3e81f36aed592ffb4bebf33a03106 \
  -o "$work/source.tgz"
printf '%s  %s\n' 3153872243dfa2c55b1d2d674fc29d90b06754605cd7ebc2a9d21231ba905704 "$work/source.tgz" | sha256sum -c -
tar -xzf "$work/source.tgz" -C "$work/source" --strip-components=1
curl -fsSL --retry 2 --connect-timeout 20 --max-time 180 \
  https://go.dev/dl/go1.26.10.linux-amd64.tar.gz -o "$work/go.tgz"
printf '%s  %s\n' ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5 "$work/go.tgz" | sha256sum -c -
tar -xzf "$work/go.tgz" -C "$work/toolchain"
export GOROOT="$work/toolchain/go"
go="$GOROOT/bin/go"
export GOENV=off GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0
# Archive provenance is the pinned checksum, not VCS metadata from the fixture marker.
export GOFLAGS='-mod=readonly -buildvcs=false' GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
export GOPRIVATE= GONOPROXY= GONOSUMDB=
export GOMODCACHE="$work/modules" GOCACHE="$work/cache"
"$go" version
src="$work/source"
sha256sum "$src/go.mod" "$src/go.sum" > "$work/modules.sha256"
# Build stock first from exactly the verified source, without executing scripts.
"$go" -C "$src" build -trimpath -o "$work/stock-actionlint" ./cmd/actionlint
"$go" -C "$src" mod verify
sha256sum -c "$work/modules.sha256"

# Archive-only fixture precondition; never initialize a repository or copy metadata.
[[ -d "$src/.github/workflows" && ! -e "$src/.git" ]]
mkdir "$src/.git"
printf '%s  %s\n' \
  3d2c2906c267b0954a2f634f7628e8ec3e4066884448384a43742ffaa9904d71 "$root/ci/actionlint/test-harness.patch" | sha256sum -c -
sha256sum "$src/ast.go" "$src/parse.go" > "$work/grammar.sha256"
apply_patch() {
  local patch="$root/ci/actionlint/$1.patch"
  git -C "$src" apply --check --verbose "$patch" > "$work/apply.log" 2>&1
  if grep -Ei 'offset|fuzz|already applied' "$work/apply.log"; then
    printf '%s\n' 'Patch requires exact source applicability.' >&2
    exit 1
  fi
  git -C "$src" apply "$patch"
}
run_tests() {
  local label="$1" status=0
  printf 'Full upstream inventory: %s\n' "$label"
  "$go" -C "$src" test -count=1 -v ./... | tee "$work/$label-tests.log" || status=$?
  node --input-type=module - "$work/$label-tests.log" <<'JS'
import { readFileSync } from 'node:fs';
const log = readFileSync(process.argv[2], 'utf8');
const count = (status) => [...log.matchAll(new RegExp(`^\\s*--- ${status}:`, 'gm'))].length;
console.log(`Upstream results (including subtests): ${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
JS
  "$go" -C "$src" mod verify
  sha256sum -c "$work/modules.sha256"
  return "$status"
}
# The scoped DefaultTransport fixture must never overlap a parallel test.
if grep -RnE '\.Parallel[[:space:]]*\(' "$src/scripts/generate-popular-actions" --include='*_test.go'; then
  printf '%s\n' 'HTTP fixture requires serial package tests.' >&2
  exit 1
fi
# Full inventory on stock grammar isolates the enumerated environment repair.
apply_patch test-harness
run_tests stock
sha256sum -c "$work/grammar.sha256"
