#!/usr/bin/env bash
set -euo pipefail

# The caller first checks the Environment pins and the current run attempt.
# Keep the dispatch workflow and this selector identical to the approved source.
[[ "$APPROVED_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$GITHUB_WORKFLOW_SHA" == "$GITHUB_SHA" ]]
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]
workflow_path="$1"
selector_path=".github/scripts/select-db-repair-revision.sh"

if [[ "$APPROVED_SHA" != "$GITHUB_SHA" ]]; then
  case "$workflow_path:$OPERATION" in
    .github/workflows/db-permissions-repair.yml:undo | \
    .github/workflows/db-permissions-repair.yml:readback | \
    .github/workflows/db-repair-executor.yml:revoke) ;;
    *) exit 1 ;;
  esac
  git merge-base --is-ancestor "$APPROVED_SHA" "$GITHUB_SHA"
  git diff --quiet --no-ext-diff "$APPROVED_SHA" "$GITHUB_SHA" -- "$workflow_path" "$selector_path"
  git checkout --quiet --detach "$APPROVED_SHA"
fi

[[ "$(git rev-parse HEAD)" == "$APPROVED_SHA" ]]
