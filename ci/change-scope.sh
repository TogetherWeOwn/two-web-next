#!/usr/bin/env bash
# Change-scope gate for the required `check` (TOG-11811) and the browser/staging
# smoke jobs (e2e.yml, e2e-staging.yml, deploy.yml smoke steps). Prints
# `docs_only=true` only when every path a PR touches is prose that nothing
# executes or reads; anything else, or any doubt, prints `docs_only=false` and
# the full suite runs. Also prints `skip_e2e=true` when no changed path can
# alter what a browser or the staging Worker observes — docs prose plus the
# `test/` unit tree, which the journeys never execute (Playwright `testDir` is
# `./e2e`, the deploy smoke drives `bin/`); every other path prints
# `skip_e2e=false`. The `skip_e2e` verdict is pure path matching on purpose: a
# doc that a gate reads (docs/config.md) is an input to `check` but proves
# nothing about browser journeys, so it still skips them. `check` ignores
# `skip_e2e`; only the e2e workflows consume it.
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

# Pure path verdict for the browser/staging smoke, computed over EVERY changed
# path (either side of a rename) with no early exit: true unless a path can
# alter what a browser or the Worker observes. It must not share the docs_only
# early exit below — a `test/` path trips that exit while still skipping e2e.
# A truncated list proves nothing for either verdict, so it fails both closed.
skip_e2e=false
if [ -s "$files" ]; then
  listed_e2e=$(wc -l < "$files")
  if [ "$listed_e2e" -ge "$expected" ]; then
    skip_e2e=true
    while IFS=$'\t' read -r name previous || [ -n "$name" ]; do
      # A rename counts both names: moving a journey into test/ does not stop
      # observing it, and moving code out of test/ starts observing it.
      for path in "$name" ${previous:+"$previous"}; do
        case "$path" in
          docs/*|test/*) ;;
          # Markdown elsewhere (content/, src/, fixtures outside test/) may
          # be shipped or read, so only root-level prose skips.
          */*) skip_e2e=false ;;
          *.md) ;;
          *) skip_e2e=false ;;
        esac
      done
    done < "$files"
  fi
fi

not_docs() {
  echo "change-scope: $1" >&2
  echo "docs_only=false"
  echo "skip_e2e=$skip_e2e"
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
echo "skip_e2e=$skip_e2e"
