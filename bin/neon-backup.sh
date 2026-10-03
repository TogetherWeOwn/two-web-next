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
# Backup target naming: neon/<branch>-<branch>-<UTC>.dump inside R2
# `two-web-next-backups` (EU-jurisdiction-pinned; jurisdiction immutable after
# creation). Weeklies are `promote-weekly` copies named
# <daily-without-.dump>-weekly-<UTC>.dump. Retention (rotate): newest 7 dailies + newest
# 4 weeklies — the same policy as two-web bin/pg-backup.sh.
#
# CISO condition (TOG-9837): member-data dumps land ONLY in the EU-pinned
# `two-web-next-backups`. The legacy `paperclip-backups` bucket (jurisdiction
# `default` / location `ENAM`) is explicitly out of scope for member-data
# dumps and must never receive them.
#
# Deletion hygiene: wrangler has no `r2 object list`, so `rotate` and `check`
# resolve the key set by downloading the checked-in-nearby remote manifest
# (`neon/<branch>-<branch>/MANIFEST.txt`, written by every backup) with
# `wrangler r2 object get`. The manifest is admitted before any remote
# mutation (bin/backup/manifest-helper): only an explicit missing-key
# diagnostic initializes a first backup; any other read failure refuses, and
# every line must be a valid archive/receipt key of the selected branch. No secret or token is ever passed on argv or
# printed: pg_dump reads the password from the PGPASSWORD env var only.
#
# Usage:
#   ./bin/neon-backup.sh backup [branch]
#     Dumps branch (default: staging) with pg_dump -Fc to a temp file, uploads
#     it and a digest receipt to the branch prefix, verifies read-back bytes,
#     then rewrites and re-downloads the manifest as the publication proof.
#     Never leaves a partial file under the final name: the dump lands in a
#     temp file first and is moved into place only on success.
#
#   ./bin/neon-backup.sh promote-weekly [branch]
#     Verifies the newest daily's receipt, copies it to a weekly name with a
#     new receipt, verifies read-back, then rewrites the paired manifest.
#
#   ./bin/neon-backup.sh rotate [branch] [--dry-run]
#     Deletes dumps beyond newest-7-daily/newest-4-weekly via
#     `wrangler r2 object delete --remote --force`, then rewrites the manifest.
#     --dry-run prints keep:/delete: lines and deletes nothing.
#
#   ./bin/neon-backup.sh check [branch] [--require-verified]
#     Re-downloads each archive and verifies its digest receipt. Legacy archives
#     without a paired receipt are explicitly unverified; --require-verified
#     also fails those. Missing new receipts always fail. See docs/backup-integrity.md.
#
# Connection: DATABASE_URL env only (e.g. NEON_STAGING_DATABASE_URL or
# PRODUCTION_DATABASE_URL exported as DATABASE_URL by the caller or the CI
# workflow; production is the PlanetScale direct 5432 endpoint, never 6432).
# There is no argv, file, or default-credential fallback: an unset
# DATABASE_URL is a hard error, so a half-configured box can never silently
# dump the wrong database. Tests run against agent-testdb / the Neon staging
# branch only, never prod.
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
  echo "usage: $0 backup [branch] | $0 promote-weekly [branch] | $0 rotate [branch] [--dry-run] | $0 check [branch] [--require-verified]" >&2
  exit 2
}

CMD="${1:-}"
[ -n "$CMD" ] || usage
shift || true

DRY_RUN=0
REQUIRE_VERIFIED=0
BRANCH="staging"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --require-verified) [ "$CMD" = check ] || usage; REQUIRE_VERIFIED=1 ;;
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
  # No eval or parent-shell credential exports. The helper validates before
  # exec and isolates libpq from ambient PG* target/service/password settings.
  # Exit here on failure while do_backup's local temp-file trap is still in scope.
  python3 "$ROOT/bin/backup/connection-helper" "$out" || exit "$?"
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
admit_manifest() {
  python3 "$ROOT/bin/backup/manifest-helper" "$1" "$(prefix)" "$2" "${@:3}"
}

write_manifest() {
  local keys_file="$1" tmp
  admit_manifest validate "$keys_file"
  tmp="$(mktemp)"
  sort "$keys_file" > "$tmp"
  wr r2 object put "$BACKUP_BUCKET/$(manifest_key)" --file "$tmp" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  rm -f "$tmp"
}

fetch_manifest() {
  local out="$1" allow_missing="${2:-0}"
  if wr r2 object get "$BACKUP_BUCKET/$(manifest_key)" --file "$out" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null 2>"$out.stderr"; then
    admit_manifest validate "$out"
  elif [ "$allow_missing" = 1 ] && python3 "$ROOT/bin/backup/manifest-helper" missing "$out.stderr"; then
    # Only an explicit missing-object diagnostic initializes first use. A failed
    # GET may create partial output; discard it instead of admitting its bytes.
    : > "$out"
  else
    echo "neon-backup: manifest read failed; refusing remote mutation" >&2
    exit 1
  fi
}

remote_tmp() { mktemp -d; }
receipt_key() { printf '%s.digest.json' "$1"; }
integrity() { python3 "$ROOT/bin/backup/integrity-helper" "$@"; }

# Verify remote bytes against the local receipt before publishing a pair. Receipt
# read-back must also match; two mutually consistent corrupted objects are not proof.
upload_verified() {
  local key="$1" archive="$2" dir="$3" receipt
  receipt="$(receipt_key "$key")"
  integrity write "$archive" "$key" "$dir/receipt.json"
  wr r2 object put "$BACKUP_BUCKET/$key" --file "$archive" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  wr r2 object get "$BACKUP_BUCKET/$key" --file "$dir/read-back.dump" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  integrity verify "$dir/read-back.dump" "$key" "$dir/receipt.json"
  wr r2 object put "$BACKUP_BUCKET/$receipt" --file "$dir/receipt.json" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  wr r2 object get "$BACKUP_BUCKET/$receipt" --file "$dir/read-back.json" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  cmp -s "$dir/receipt.json" "$dir/read-back.json" || { echo "neon-backup: receipt read-back failed: $key" >&2; exit 1; }
}

do_backup() {
  require_database_url
  local ts key dir
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  key="$(prefix)-${ts}.dump"
  dir="$(remote_tmp)"
  trap '[ -n "${dir:-}" ] && rm -rf -- "$dir"' EXIT
  # Target validation and the local dump come first: an invalid target must
  # refuse before any storage call. Then admit the existing inventory and the
  # new archive + receipt keys before any remote mutation (archive upload,
  # receipt upload, manifest rewrite).
  dump_to_file "$dir/local.dump"
  [ -s "$dir/local.dump" ] || { echo "neon-backup: refusing to upload an empty dump" >&2; exit 1; }
  fetch_manifest "$dir/MANIFEST.txt" 1
  admit_manifest append "$dir/MANIFEST.txt" "$key" "$(receipt_key "$key")"
  upload_verified "$key" "$dir/local.dump" "$dir"
  # Manifest publication is separate from byte verification; retain its proof.
  write_manifest "$dir/MANIFEST.txt"
  fetch_manifest "$dir/PROOF.txt"
  for published in "$key" "$(receipt_key "$key")"; do
    grep -qxF "$published" "$dir/PROOF.txt" || { echo "neon-backup: upload proof failed: $published missing from re-downloaded manifest" >&2; exit 1; }
  done
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
  trap '[ -n "${dir:-}" ] && rm -rf -- "$dir"' EXIT
  fetch_manifest "$dir/MANIFEST.txt"
  src="$(newest_daily "$dir/MANIFEST.txt")"
  [ -n "$src" ] || { echo "neon-backup: no daily to promote under branch '$BRANCH'" >&2; exit 1; }
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  weekly="${src%.dump}-weekly-${ts}.dump"
  admit_manifest append "$dir/MANIFEST.txt" "$weekly" "$(receipt_key "$weekly")"
  wr r2 object get "$BACKUP_BUCKET/$src" --file "$dir/dl.dump" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  if ! wr r2 object get "$BACKUP_BUCKET/$(receipt_key "$src")" --file "$dir/source.json" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null 2>&1; then
    echo "neon-backup: unverified: $src (receipt unavailable); refusing promotion" >&2
    exit 1
  fi
  integrity verify "$dir/dl.dump" "$src" "$dir/source.json"
  upload_verified "$weekly" "$dir/dl.dump" "$dir"
  write_manifest "$dir/MANIFEST.txt"
  rm -rf "$dir"
  trap - EXIT
  echo "promote-weekly: $weekly (from $src)"
}

# Only registered receipts are managed. Pre-receipt manifests stay valid without
# inventing/backfilling receipts. A failed paired delete never rewrites the manifest.
delete_archive_pair() {
  local key="$1" manifest="$2" receipt
  receipt="$(receipt_key "$key")"
  if ! wr r2 object delete "$BACKUP_BUCKET/$key" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null; then
    echo "neon-backup: delete failed: $key" >&2
    exit 1
  fi
  if grep -qxF "$receipt" "$manifest"; then
    wr r2 object delete "$BACKUP_BUCKET/$receipt" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null || { echo "neon-backup: delete failed: $receipt" >&2; exit 1; }
  fi
  echo "delete: $key"
}

do_rotate() {
  local dir dailies weeklies keep tmp_manifest
  dir="$(remote_tmp)"
  trap '[ -n "${dir:-}" ] && rm -rf -- "$dir"' EXIT
  fetch_manifest "$dir/MANIFEST.txt"
  dailies="$(grep -E '\.dump$' "$dir/MANIFEST.txt" | grep -v '\-weekly\-' | sort || true)"
  weeklies="$(grep -E '\-weekly\-.*\.dump$' "$dir/MANIFEST.txt" | sort || true)"
  tmp_manifest="$dir/retained.txt"
  keep="$(printf '%s\n' "$dailies" | tail -n "$BACKUP_KEEP_DAILY")"
  printf '%s\n' "$dailies" | head -n -"$BACKUP_KEEP_DAILY" | while IFS= read -r key; do
    [ -n "$key" ] || continue
    if [ "$DRY_RUN" = 1 ]; then
      echo "delete: $key"
    else
      delete_archive_pair "$key" "$dir/MANIFEST.txt"
    fi
  done
  printf '%s\n' "$weeklies" | head -n -"$BACKUP_KEEP_WEEKLY" | while IFS= read -r key; do
    [ -n "$key" ] || continue
    if [ "$DRY_RUN" = 1 ]; then
      echo "delete: $key"
    else
      delete_archive_pair "$key" "$dir/MANIFEST.txt"
    fi
  done
  if [ "$DRY_RUN" = 1 ]; then
    { printf '%s\n' "$dailies" | sed 's/^/keep: /'; printf '%s\n' "$weeklies" | sed 's/^/keep: /'; } | grep -v 'keep: $' || true
  else
    { printf '%s\n' "$keep"; printf '%s\n' "$weeklies" | tail -n "$BACKUP_KEEP_WEEKLY"; } | grep -v '^$' | sort -u > "$tmp_manifest"
    while IFS= read -r key; do
      if grep -qxF "$(receipt_key "$key")" "$dir/MANIFEST.txt"; then
        printf '%s\n' "$(receipt_key "$key")"
      fi
    done < "$tmp_manifest" > "$dir/retained-receipts.txt"
    cat "$dir/retained-receipts.txt" >> "$tmp_manifest"
    write_manifest "$tmp_manifest"
  fi
  rm -rf "$dir"
  trap - EXIT
}

do_check() {
  local dir failed=0 unverified=0 key receipt
  dir="$(remote_tmp)"
  trap '[ -n "${dir:-}" ] && rm -rf -- "$dir"' EXIT
  fetch_manifest "$dir/MANIFEST.txt"
  while IFS= read -r key || [ -n "$key" ]; do
    [ -n "$key" ] || continue
    # A sidecar is verified with its archive, never as an independent backup.
    case "$key" in
      *.dump.digest.json)
        if ! grep -qxF "${key%.digest.json}" "$dir/MANIFEST.txt"; then
          echo "corrupt: $key (unpaired receipt)" >&2
          failed=1
        fi
        continue ;;
    esac
    receipt="$(receipt_key "$key")"
    if ! wr r2 object get "$BACKUP_BUCKET/$key" --file "$dir/check.dump" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null 2>&1; then
      echo "missing: $key" >&2
      failed=1
    elif ! wr r2 object get "$BACKUP_BUCKET/$receipt" --file "$dir/check.json" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null 2>&1; then
      echo "unverified: $key (receipt unavailable)"
      unverified=$((unverified + 1))
      if [ "$REQUIRE_VERIFIED" = 1 ] || grep -qxF "$receipt" "$dir/MANIFEST.txt"; then
        failed=1
      fi
    elif integrity verify "$dir/check.dump" "$key" "$dir/check.json"; then
      echo "verified: $key"
    else
      echo "corrupt: $key (invalid receipt or archive bytes)" >&2
      failed=1
    fi
  done < "$dir/MANIFEST.txt"
  rm -rf "$dir"
  trap - EXIT
  [ "$failed" = 0 ] || { echo "neon-backup: check failed" >&2; exit 1; }
  if [ "$unverified" = 0 ]; then
    echo "check: all manifest archives byte-verified"
  else
    echo "check: $unverified legacy archive(s) unverified; available receipts verified"
  fi
}

case "$CMD" in
  backup) do_backup ;;
  promote-weekly) do_promote_weekly ;;
  rotate) do_rotate ;;
  check) do_check ;;
  *) usage ;;
esac
