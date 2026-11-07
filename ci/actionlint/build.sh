#!/usr/bin/env bash
# Actions-only compatibility build; never install a patched checker on the host.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { printf '%s\n' 'Run this gate in GitHub Actions.' >&2; exit 1; }
root=$(git rev-parse --show-toplevel)
work=$(mktemp -d "${RUNNER_TEMP:?}/actionlint-queue.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
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
export GOFLAGS=-mod=readonly GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
export GOPRIVATE= GONOPROXY= GONOSUMDB=
export GOMODCACHE="$work/modules" GOCACHE="$work/cache"
"$go" version
src="$work/source"
sha256sum "$src/go.mod" "$src/go.sum" > "$work/modules.sha256"
# Build stock first from exactly the verified source, without executing scripts.
"$go" -C "$src" build -trimpath -o "$work/stock-actionlint" ./cmd/actionlint
"$go" -C "$src" mod verify
sha256sum -c "$work/modules.sha256"

git -C "$src" apply --check "$root/ci/actionlint/queue.patch"
git -C "$src" apply "$root/ci/actionlint/queue.patch"
cp "$root/ci/actionlint/concurrency_queue_test.go" "$src/concurrency_queue_test.go"
cp "$root/ci/actionlint/queue-cases.json" "$src/queue-cases.json"
# Run every upstream test unchanged, plus the added parser matrix.
"$go" -C "$src" test -count=1 -v ./...
"$go" -C "$src" build -trimpath -o "$work/actionlint" ./cmd/actionlint
"$go" -C "$src" mod verify
sha256sum -c "$work/modules.sha256"
node "$root/ci/actionlint/queue-cli.mjs" "$work/stock-actionlint" "$work/actionlint"
# Original workflow files, original lint scope and external-checker settings.
"$work/actionlint" -shellcheck= -pyflakes=
