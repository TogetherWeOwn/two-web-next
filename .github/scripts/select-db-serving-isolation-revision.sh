#!/usr/bin/env bash
set -euo pipefail

[[ "$APPROVED_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$GITHUB_WORKFLOW_SHA" == "$GITHUB_SHA" ]]
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]

if [[ "$APPROVED_SHA" != "$GITHUB_SHA" ]]; then
  case "$OPERATION" in
    undo | readback) ;;
    *) exit 1 ;;
  esac
  git merge-base --is-ancestor "$APPROVED_SHA" "$GITHUB_SHA"
  git diff --quiet --no-ext-diff "$APPROVED_SHA" "$GITHUB_SHA" -- \
    .github/workflows/db-serving-ledger-isolation.yml \
    .github/scripts/select-db-serving-isolation-revision.sh
  git checkout --quiet --detach "$APPROVED_SHA"
fi

[[ "$(git rev-parse HEAD)" == "$APPROVED_SHA" ]]
