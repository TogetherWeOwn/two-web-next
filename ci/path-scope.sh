#!/usr/bin/env bash
# Path-scope gate for path-filtered workflows that own an always-run aggregator.
#
# A workflow-level `paths:` filter means the workflow never runs when a PR
# touches none of the listed paths, so a job inside it can never serve as a
# required check: GitHub waits on a check that is never reported and the PR
# blocks forever. The pattern used here keeps the trigger unfiltered (the
# workflow always runs), detects relevant changes per PR with this script,
# gates the heavy jobs on that verdict, and lets an `if: always()` aggregator
# job report the conclusion. The aggregator fails closed when this scope job
# does not explicitly succeed.
#
# Usage: ci/path-scope.sh <pr-files.tsv> <expected-file-count> -- <glob>...
#   pr-files.tsv: one `filename<TAB>previous_filename` line per changed file,
#   as listed by the pull-request files API.
#   Prints `relevant=true` when any changed file matches any glob, otherwise
#   `relevant=false`. Fails closed: any doubt prints `relevant=true`.
#
# Selftest: ci/path-scope.sh --selftest (no network, fixture data only).
#
# No pipelines on purpose: under pipefail an early-exiting reader (grep -q)
# SIGPIPEs its writer and flips the verdict.
set -euo pipefail

selftest() {
  local failures=0
  check() {
    local name=$1 expected=$2
    shift 2
    local lines=() globs=() in_globs=0
    for arg in "$@"; do
      if [ "$arg" = "--" ]; then in_globs=1; continue; fi
      if [ "$in_globs" = 0 ]; then lines+=("$arg"); else globs+=("$arg"); fi
    done
    local tsv
    tsv=$(mktemp)
    if [ "${#lines[@]}" -gt 0 ]; then
      printf '%s\n' "${lines[@]}" > "$tsv"
    else
      : > "$tsv"
    fi
    local got
    got=$(bash "$0" "$tsv" "${#lines[@]}" -- "${globs[@]}")
    rm -f "$tsv"
    if [ "$got" = "$expected" ]; then
      echo "ok: $name"
    else
      echo "FAIL: $name (want $expected, got $got)"
      failures=$((failures + 1))
    fi
  }
  check "exact match is relevant" "relevant=true" "src/pages.tsx" -- "src/pages.tsx"
  check "unrelated file is irrelevant" "relevant=false" "src/other.ts" -- "src/pages.tsx"
  check "nested glob matches" "relevant=true" "ci/featured-proof/run-capture.cjs" -- "ci/featured-proof/**"
  check "rename into scope is relevant" "relevant=true" "$(printf 'docs/new.md\tci/featured-proof/tool.cjs')" -- "ci/featured-proof/**"
  check "rename out of scope stays relevant" "relevant=true" "$(printf 'docs/new.md\tsrc/pages.tsx')" -- "src/pages.tsx"
  check "empty list fails closed" "relevant=true" -- "src/pages.tsx"
  check "no globs means nothing relevant" "relevant=false" "src/pages.tsx" --
  local tsv
  tsv=$(mktemp)
  printf 'src/other.ts\n' > "$tsv"
  local got
  got=$(bash "$0" "$tsv" 5 -- "src/pages.tsx")
  rm -f "$tsv"
  if [ "$got" = "relevant=true" ]; then
    echo "ok: count mismatch fails closed"
  else
    echo "FAIL: count mismatch (want relevant=true, got $got)"
    failures=$((failures + 1))
  fi
  tsv=$(mktemp)
  rm -f "$tsv"
  got=$(bash "$0" "$tsv" 1 -- "src/pages.tsx")
  if [ "$got" = "relevant=true" ]; then
    echo "ok: missing list fails closed"
  else
    echo "FAIL: missing list (want relevant=true, got $got)"
    failures=$((failures + 1))
  fi
  if [ "$failures" != 0 ]; then
    echo "path-scope selftest: $failures failure(s)" >&2
    return 1
  fi
  echo "path-scope selftest: all pass"
}

if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

files=$1
expected=$2
shift 2
[ "${1:-}" = "--" ] && shift

not_relevant() {
  echo "relevant=false"
  exit 0
}

relevant() {
  echo "path-scope: $1" >&2
  echo "relevant=true"
  exit 0
}

[ -s "$files" ] || relevant "no changed-file list"
[ "$#" -gt 0 ] || not_relevant
listed=$(wc -l < "$files")
[ "$listed" -ge "$expected" ] || relevant "listed $listed of $expected changed files"

while IFS=$'\t' read -r name previous || [ -n "$name" ]; do
  for path in "$name" ${previous:+"$previous"}; do
    for glob in "$@"; do
      case "$path" in
        $glob|$glob/*) relevant "$path matches $glob" ;;
      esac
    done
  done
done < "$files"

not_relevant
