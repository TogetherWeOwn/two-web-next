#!/usr/bin/env bash
# Run inside xfs-qualification-fixture.sh; its mounts outlive the Workers.
set -euo pipefail

expect_refusal() {
  local expected=$1 output
  shift
  if output=$("$@" node ci/kit-worker-e2e.mjs --installed-output 2>&1); then
    printf '%s\n' 'Installed-output invocation unexpectedly succeeded' >&2
    return 1
  fi
  printf '%s\n' "$output"
  grep -Fq "$expected" <<< "$output"
  if grep -Fq 'Launching loopback' <<< "$output"; then
    printf '%s\n' 'Refused invocation attempted to start a Worker' >&2
    return 1
  fi
  printf 'PASS refused before either Worker launched: %s\n' "$expected"
}

expect_refusal 'requires the hosted XFS fixture' env -u XFS_FIXTURE_ROOT
expect_refusal 'root is not on XFS' env XFS_FIXTURE_ROOT="${XFS_FIXTURE_NON_XFS:?}"
node ci/kit-worker-e2e.mjs --installed-output
