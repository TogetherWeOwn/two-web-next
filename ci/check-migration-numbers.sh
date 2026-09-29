#!/usr/bin/env bash
#
# Enforces the shared-Postgres migration numbering reservation
# (docs/db-migrations.md): in two-web-next, web migrations are numbered
# 1000–1999; the bot range 0001–0999 lives in the bot rewrite repo and must
# never gain new members here.
#
# Drizzle names migrations NNNN_tag (underscores, not dashes), so the pattern
# is ^NNNN_ with a permissive slug. Two grandfathered exceptions predate this
# check (W3/W14, pinned by imports in test/agent-events.test.ts):
# drizzle/0000_init-users.sql and drizzle/0001_agent-events.sql. Everything
# new must be 1000+. Numbers are never reused, even for reverts — revert with
# a new migration in your own range.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
found=0
checked=0
declare -A seen=()

is_grandfathered() {
  case "$1" in
    drizzle/0000_init-users.sql|drizzle/0001_agent-events.sql) return 0 ;;
    *) return 1 ;;
  esac
}

for dir in db/migrations drizzle migrations; do
  [ -d "$dir" ] || continue
  for f in "$dir"/*.sql; do
    [ -e "$f" ] || continue
    found=$((found + 1))
    if is_grandfathered "$f"; then
      continue
    fi
    checked=$((checked + 1))
    base="$(basename "$f")"
    if [[ ! "$base" =~ ^([0-9]{4})_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$ ]]; then
      echo "numbering: bad name: $f (want NNNN_slug.sql)" >&2
      fail=1
      continue
    fi
    n=$((10#${BASH_REMATCH[1]}))
    if ((n < 1000 || n > 1999)); then
      echo "numbering: out of range: $f (web range is 1000-1999; bot 0001-0999 lives in the bot repo)" >&2
      fail=1
    fi
    if [[ -n "${seen[$n]:-}" ]]; then
      echo "numbering: duplicate number: $f (also ${seen[$n]})" >&2
      fail=1
    fi
    seen[$n]="$f"
  done
done

if [ "$fail" != 0 ]; then
  echo "numbering: FAILED" >&2
  exit 1
fi
echo "numbering: ok ($checked new migration(s) in web range 1000-1999; $found total, grandfathered pre-S1 files skipped)"
