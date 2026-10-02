#!/usr/bin/env bash
# Change-scope gate for the required `check` (TOG-11811). Prints
# `docs_only=true` only when every path a PR touches is prose that nothing
# executes or reads; anything else, or any doubt, prints `docs_only=false` and
# the full suite runs.
#
# Usage: ci/change-scope.sh <pr-files.tsv> <expected-file-count>
#   pr-files.tsv: one `filename<TAB>previous_filename` line per changed file,
#   as listed by the pull-request files API. Run from the checked-out PR tree.
#
# No pipelines on purpose: under pipefail an early-exiting reader (grep -q)
# SIGPIPEs its writer and flips the verdict.
set -euo pipefail

files=$1
expected=$2

not_docs() {
  echo "change-scope: $1" >&2
  echo "docs_only=false"
  exit 0
}

[ -s "$files" ] || not_docs "no changed-file list"
listed=$(wc -l < "$files")
# The files API stops at 3000 entries; a truncated list proves nothing.
[ "$listed" -ge "$expected" ] || not_docs "listed $listed of $expected changed files"

patterns=()
while IFS=$'\t' read -r name previous || [ -n "$name" ]; do
  # A rename counts both names: moving code into docs/ is not a docs change.
  for path in "$name" ${previous:+"$previous"}; do
    case "$path" in
      docs/*) ;;
      # Markdown elsewhere (content/, src/, test fixtures) may be shipped or read.
      */*) not_docs "$path is outside docs/" ;;
      *.md) ;;
      *) not_docs "${path:-<empty path>} is not documentation" ;;
    esac
    patterns+=(-e "$path")
  done
done < "$files"

# A doc that a gate, test or build reads (docs/url-freeze.md, docs/config.md,
# docs/runbook.md, ...) is an input to `check`, not prose.
rc=0
readers=$(git grep -lF "${patterns[@]}" -- . ':(exclude)*.md') || rc=$?
case $rc in
  0) not_docs "changed docs are read by: ${readers//$'\n'/, }" ;;
  1) echo "docs_only=true" ;;
  *) echo "change-scope: git grep failed ($rc)" >&2; exit "$rc" ;;
esac
