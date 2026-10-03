#!/usr/bin/env bash
# Failure-artifact sweep for e2e-staging (TOG-13046, CISO condition C2 on
# TOG-13035). The repo is public, so an uploaded artifact is readable by any
# signed-in GitHub user for its retention and log masking does not cover it.
# Deletes every file under the given directories that contains the staging QA
# token, prints file names only, and exits 1 when it removed anything so the
# leak is loud instead of silent.
#
# Usage: QA_AUTH_TOKEN=<token> ci/scrub-qa-token.sh <dir>...
#
# The token reaches grep through a pattern file descriptor, never argv, so it
# is not visible in the process list. Compressed archives (Playwright
# `trace.zip`) are not decompressed: the pinned Playwright keeps request
# headers out of traces for the contexts these specs create (TOG-13035).
set -euo pipefail

if [ -z "${QA_AUTH_TOKEN:-}" ]; then
  # An empty pattern matches every file; with no token there is nothing to leak.
  echo "scrub-qa-token: QA_AUTH_TOKEN is empty, nothing to sweep for" >&2
  exit 0
fi

removed=0
for dir in "$@"; do
  [ -d "$dir" ] || continue
  while IFS= read -r -d '' file; do
    rm -f -- "$file"
    echo "scrub-qa-token: removed $file" >&2
    removed=$((removed + 1))
  done < <(grep -rlFZ -f <(printf %s "$QA_AUTH_TOKEN") -- "$dir" || true)
done

if [ "$removed" -gt 0 ]; then
  echo "::error::QA_AUTH_TOKEN was found in $removed failure artifact file(s); removed. Treat the token as exposed and report it to the COO."
  exit 1
fi
