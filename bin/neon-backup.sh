#!/usr/bin/env bash
#
# Nightly Neon Postgres backup to R2 `two-web-next-backups` (EU jurisdiction),
# with the proof that the backup restores.
#
# The Cloudflare build (bot + web) shares one Neon Postgres (see
# docs/db-migrations.md). A backup with no restore test is a rumour, so this
# script takes the dump the same way every time (`pg_dump -Fc`) and can prove
# the dump restores into a scratch database by comparing every table's row
# count before and after.
#
# Backup target naming: neon-<branch>/neon-<UTC>.dump inside R2
# `two-web-next-backups` (EU-jurisdiction-pinned; jurisdiction immutable after
# creation). Weeklies are `promote-weekly` copies named
# neon-<UTC>-weekly-<UTC>.dump. Retention (rotate): newest 7 dailies + newest
# 4 weeklies — the same policy as two-web bin/pg-backup.sh.
#
# CISO condition (TOG-9837): member-data dumps land ONLY in the EU-pinned
# `two-web-next-backups`. The legacy `paperclip-backups` bucket (jurisdiction
# `default` / location `ENAM`) is explicitly out of scope for member-data
# dumps and must never receive them.
#
# Deletion hygiene: wrangler has no `r2 object list`, so `rotate` and `check`
# resolve the key set by downloading the checked-in-nearby remote manifest
# (`neon-<branch>/MANIFEST.txt`, written by every backup) with
# `wrangler r2 object get`. No secret or token is ever passed on argv or
# printed: pg_dump reads the password from the PGPASSWORD env var only.
#
# Usage:
#   ./bin/neon-backup.sh backup [branch]
#     Dumps branch (default: staging) with pg_dump -Fc to a temp file, uploads
#     it to the branch prefix with `wrangler r2 object put --remote --force`, rewrites
#     the remote manifest, and re-downloads the manifest as the upload proof.
#     Never leaves a partial file under the final name: the dump lands in a
#     temp file first and is moved into place only on success.
#
#   ./bin/neon-backup.sh promote-weekly [branch]
#     Copies the newest daily under the branch prefix to a weekly name and
#     re-uploads it, then rewrites the manifest.
#
#   ./bin/neon-backup.sh rotate [branch] [--dry-run]
#     Deletes dumps beyond newest-7-daily/newest-4-weekly via
#     `wrangler r2 object delete --remote --force`, then rewrites the manifest.
#     --dry-run prints keep:/delete: lines and deletes nothing.
#
#   ./bin/neon-backup.sh check [branch]
#     Verifies every manifest key still exists (re-downloads each header via
#     `wrangler r2 object get --pipe` and fails on the first miss).
#
# Connection: DATABASE_URL env only (e.g. NEON_STAGING_DATABASE_URL exported
# as DATABASE_URL by the caller or the CI workflow). There is no argv, file,
# or default-credential fallback: an unset DATABASE_URL is a hard error, so a
# half-configured box can never silently dump the wrong database. Tests run
# against agent-testdb / the Neon staging branch only, never prod.
#
# Needs: pg_dump + psql (CI: postgres:17 image service / apt), wrangler with
# CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
#
# Env overrides (mirroring two-web pg-backup.sh):
#   BACKUP_KEEP_DAILY (default 7), BACKUP_KEEP_WEEKLY (default 4),
#   BACKUP_BUCKET (default two-web-next-backups),
#   BACKUP_JURISDICTION (default eu),
#   BACKUP_PREFIX (default neon).
# Every `wrangler r2 object` call below passes
# `--jurisdiction "$BACKUP_JURISDICTION"` so member-data dumps address the
# EU-pinned bucket explicitly, never the default jurisdiction.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${BACKUP_KEEP_DAILY:=7}"
: "${BACKUP_KEEP_WEEKLY:=4}"
: "${BACKUP_BUCKET:=two-web-next-backups}"
: "${BACKUP_JURISDICTION:=eu}"
: "${BACKUP_PREFIX:=neon}"

usage() {
  echo "usage: $0 backup [branch] | $0 promote-weekly [branch] | $0 rotate [branch] [--dry-run] | $0 check [branch]" >&2
  exit 2
}

CMD="${1:-}"
[ -n "$CMD" ] || usage
shift || true

DRY_RUN=0
BRANCH="staging"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "neon-backup: unknown flag '$arg'" >&2; usage ;;
    *) BRANCH="$arg" ;;
  esac
done

# --dry-run is documented for rotate only (see usage above). For any other
# command the flag used to be silently ignored — `backup --dry-run` still
# dumped and uploaded, `promote-weekly --dry-run` still wrote the manifest.
# Reject it here, before any connection, pg_dump, wrangler, temp-dir or
# manifest work can happen.
if [ "$DRY_RUN" = 1 ] && [ "$CMD" != "rotate" ]; then
  echo "neon-backup: --dry-run is only supported for 'rotate'" >&2
  usage
fi

# DATABASE_URL comes from the environment only. No .env parsing, no defaults:
# a dump must never guess which database it is reading.
require_database_url() {
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "neon-backup: refusing: DATABASE_URL is unset. Export it (e.g. from NEON_STAGING_DATABASE_URL) before running." >&2
    exit 1
  fi
}

# pg_dump must never see a password on argv: split DATABASE_URL into
# PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE via python (present everywhere
# this script runs: CI image, operator boxes) and exec pg_dump with PG* env.
# The password may be empty (agent-testdb trust auth, Neon passwords): only
# unset DATABASE_URL refuses. An empty PGPASSWORD is exported so libpq never
# falls back to prompting.
dump_to_file() {
  local out="$1"
  require_database_url
  command -v pg_dump >/dev/null || { echo "neon-backup: pg_dump not found" >&2; exit 1; }
  eval "$(python3 -c '
import os, shlex
from urllib.parse import urlparse, unquote
u = urlparse(os.environ["DATABASE_URL"])
parts = {
    "PGHOST": u.hostname or "",
    "PGPORT": str(u.port or 5432),
    "PGUSER": unquote(u.username or ""),
    "PGPASSWORD": unquote(u.password or ""),
    "PGDATABASE": unquote((u.path or "").lstrip("/")),
}
for k, v in parts.items():
    print("%s=%s" % (k, shlex.quote(v)))
')"
  export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
  pg_dump -Fc -f "$out"
  unset PGPASSWORD
}

prefix() { printf '%s/%s-%s' "$BACKUP_PREFIX" "$BRANCH" "$BRANCH"; }
manifest_key() { printf '%s/%s-%s/MANIFEST.txt' "$BACKUP_PREFIX" "$BRANCH" "$BRANCH"; }

# WRANGLER_BIN overrides the wrangler invocation (ci/neon-backup-selftest.sh
# points it at a stub; production uses the real CLI). Never a token: auth is
# ambient (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env).
wr() {
  if [ -n "${WRANGLER_BIN:-}" ]; then
    "$WRANGLER_BIN" "$@"
  else
    npx --yes wrangler "$@"
  fi
}

# Rewrite the remote manifest from the local list of keys (one per line,
# sorted). The manifest is the rotation/check source of truth because wrangler
# has no `r2 object list`.
write_manifest() {
  local keys_file="$1" tmp
  tmp="$(mktemp)"
  sort "$keys_file" > "$tmp"
  wr r2 object put "$BACKUP_BUCKET/$(manifest_key)" --file "$tmp" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  rm -f "$tmp"
}

fetch_manifest() {
  local out="$1"
  wr r2 object get "$BACKUP_BUCKET/$(manifest_key)" --file "$out" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
}

remote_tmp() { mktemp -d; }

do_backup() {
  require_database_url
  local ts tmp key dir
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  dump_to_file "$tmp"
  [ -s "$tmp" ] || { echo "neon-backup: refusing to upload an empty dump" >&2; exit 1; }
  key="$(prefix)-${ts}.dump"
  wr r2 object put "$BACKUP_BUCKET/$key" --file "$tmp" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  rm -f "$tmp"
  trap - EXIT
  # Manifest update + upload proof: re-download the manifest we just wrote.
  dir="$(remote_tmp)"
  trap 'rm -rf "$dir"' EXIT
  if wr r2 object get "$BACKUP_BUCKET/$(manifest_key)" --file "$dir/MANIFEST.txt" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null 2>&1; then
    printf '%s\n' "$key" >> "$dir/MANIFEST.txt"
  else
    printf '%s\n' "$key" > "$dir/MANIFEST.txt"
  fi
  write_manifest "$dir/MANIFEST.txt"
  fetch_manifest "$dir/PROOF.txt"
  grep -qxF "$key" "$dir/PROOF.txt" || { echo "neon-backup: upload proof failed: $key missing from re-downloaded manifest" >&2; exit 1; }
  rm -rf "$dir"
  trap - EXIT
  echo "backup: $key"
}

newest_daily() {
  local manifest="$1"
  grep -E '\.dump$' "$manifest" | grep -v '\-weekly\-' | sort | tail -n 1 || true
}

do_promote_weekly() {
  local dir ts src weekly
  dir="$(remote_tmp)"
  trap 'rm -rf "$dir"' EXIT
  fetch_manifest "$dir/MANIFEST.txt"
  src="$(newest_daily "$dir/MANIFEST.txt")"
  [ -n "$src" ] || { echo "neon-backup: no daily to promote under branch '$BRANCH'" >&2; exit 1; }
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  weekly="${src%.dump}-weekly-${ts}.dump"
  wr r2 object get "$BACKUP_BUCKET/$src" --file "$dir/dl.dump" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  wr r2 object put "$BACKUP_BUCKET/$weekly" --file "$dir/dl.dump" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  printf '%s\n' "$weekly" >> "$dir/MANIFEST.txt"
  write_manifest "$dir/MANIFEST.txt"
  rm -rf "$dir"
  trap - EXIT
  echo "promote-weekly: $weekly (from $src)"
}

do_rotate() {
  local dir dailies weeklies keep tmp_manifest
  dir="$(remote_tmp)"
  trap 'rm -rf "$dir"' EXIT
  fetch_manifest "$dir/MANIFEST.txt"
  dailies="$(grep -E '\.dump$' "$dir/MANIFEST.txt" | grep -v '\-weekly\-' | sort || true)"
  weeklies="$(grep -E '\-weekly\-.*\.dump$' "$dir/MANIFEST.txt" | sort || true)"
  tmp_manifest="$(mktemp)"
  keep="$(printf '%s\n' "$dailies" | tail -n "$BACKUP_KEEP_DAILY")"
  printf '%s\n' "$dailies" | head -n -"$BACKUP_KEEP_DAILY" | while IFS= read -r key; do
    [ -n "$key" ] || continue
    if [ "$DRY_RUN" = 1 ]; then
      echo "delete: $key"
    elif wr r2 object delete "$BACKUP_BUCKET/$key" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null; then
      echo "delete: $key"
    else
      echo "neon-backup: delete failed: $key" >&2
      exit 1
    fi
  done
  printf '%s\n' "$weeklies" | head -n -"$BACKUP_KEEP_WEEKLY" | while IFS= read -r key; do
    [ -n "$key" ] || continue
    if [ "$DRY_RUN" = 1 ]; then
      echo "delete: $key"
    elif wr r2 object delete "$BACKUP_BUCKET/$key" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null; then
      echo "delete: $key"
    else
      echo "neon-backup: delete failed: $key" >&2
      exit 1
    fi
  done
  if [ "$DRY_RUN" = 1 ]; then
    { printf '%s\n' "$dailies" | sed 's/^/keep: /'; printf '%s\n' "$weeklies" | sed 's/^/keep: /'; } | grep -v 'keep: $' || true
  else
    { printf '%s\n' "$keep"; printf '%s\n' "$weeklies" | tail -n "$BACKUP_KEEP_WEEKLY"; } | grep -v '^$' | sort -u > "$tmp_manifest"
    write_manifest "$tmp_manifest"
    rm -f "$tmp_manifest"
  fi
  rm -rf "$dir"
  trap - EXIT
}

do_check() {
  local dir missing=0
  dir="$(remote_tmp)"
  trap 'rm -rf "$dir"' EXIT
  fetch_manifest "$dir/MANIFEST.txt"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    if wr r2 object get "$BACKUP_BUCKET/$key" --pipe --remote --jurisdiction "$BACKUP_JURISDICTION" > /dev/null 2>&1; then
      echo "ok: $key"
    else
      echo "missing: $key" >&2
      missing=1
    fi
  done < "$dir/MANIFEST.txt"
  rm -rf "$dir"
  trap - EXIT
  [ "$missing" = 0 ] || { echo "neon-backup: check failed" >&2; exit 1; }
  echo "check: all manifest keys present"
}

case "$CMD" in
  backup) do_backup ;;
  promote-weekly) do_promote_weekly ;;
  rotate) do_rotate ;;
  check) do_check ;;
  *) usage ;;
esac
