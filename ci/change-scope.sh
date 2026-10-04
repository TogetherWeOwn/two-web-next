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
# Area verdicts (`app`, `worker`, `db`, `full`) let heavy jobs run only when
# their inputs changed. `full` forces every area on: dependency manifests and
# lockfiles, `.github/**`, shared build and tooling config, and this script
# itself. Unknown paths fail closed to `full`. `draft` mirrors the PR draft
# flag from the caller (never inferred here): drafts skip heavy jobs while the
# aggregator still reports.
#
# Usage: ci/change-scope.sh <pr-files.tsv> <expected-file-count>
#   pr-files.tsv: one `filename<TAB>previous_filename` line per changed file,
#   as listed by the pull-request files API. Run from the checked-out PR tree.
#   DRAFT=true in the environment marks the verdict as a draft PR.
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

# Area verdicts for heavy-job gating. Computed over EVERY changed path (either
# side of a rename) with no early exit, independent of the docs_only verdict
# below: a doc a gate reads (docs/config.md) selects no heavy area while still
# running `check`, and a truncated list fails everything closed.
app=false
worker=false
db=false
full=false
if [ -s "$files" ]; then
  listed_areas=$(wc -l < "$files")
  if [ "$listed_areas" -ge "$expected" ]; then
    while IFS=$'\t' read -r name previous || [ -n "$name" ]; do
      # A rename counts both names: moving code into docs/ is not a docs change.
      for path in "$name" ${previous:+"$previous"}; do
        case "$path" in
          # Full-run triggers: dependency manifests and lockfiles, shared
          # build and tooling config, CI itself, and this filter.
          package-lock.json|web/package-lock.json|\
          package.json|web/package.json|\
          biome.json|tsconfig.json|ci/tsconfig.json|e2e/tsconfig.json|\
          vitest.config.ts|playwright.config.ts|playwright.staging.config.ts|\
          .github/*|ci/change-scope.sh)
            full=true
            ;;
          # Worker deploy surface: dispatch configs, the Tail worker and the
          # Kit spike. Observed by `check` (dry runs, Kit typecheck and
          # parity) and the deploy workflows, not by the audit or perf jobs.
          wrangler*.jsonc|tail/*|web/*)
            worker=true
            ;;
          # Database: migrations, the journal lock, the drizzle config and the
          # migration tooling under ci/ (history and numbering checks, the
          # Neon migrate script and its selftest). Observed by `check` (migrate,
          # history checks, numbering) and `a11y` (the fixtures run the real
          # migrations), not by the perf jobs. Listed before the `ci/*` app
          # arm below, which would otherwise claim these paths.
          drizzle/*|migrations.lock|drizzle.config.ts|\
          ci/check-migration-*|ci/neon-migrate*)
            db=true
            ;;
          # App: everything the served worker, its assets, the test suites
          # and the browser journeys observe.
          src/*|assets/*|public/*|content/*|bin/*|ci/*|test/*|e2e/*|spike/*)
            app=true
            ;;
          # Prose: area-neutral here; the docs_only verdict below decides.
          docs/*) ;;
          *.md) ;;
          # Unknown paths fail closed: run everything.
          *) full=true ;;
        esac
      done
    done < "$files"
  else
    full=true
  fi
else
  full=true
fi

draft=false
if [ "${DRAFT:-}" = true ]; then
  draft=true
fi

not_docs() {
  echo "change-scope: $1" >&2
  echo "docs_only=false"
  echo "skip_e2e=$skip_e2e"
  echo "app=$app"
  echo "worker=$worker"
  echo "db=$db"
  echo "full=$full"
  echo "draft=$draft"
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
echo "app=$app"
echo "worker=$worker"
echo "db=$db"
echo "full=$full"
echo "draft=$draft"
