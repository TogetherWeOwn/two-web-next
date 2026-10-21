#!/usr/bin/env bash
#
# Nightly Postgres backup to R2 `two-web-next-backups` (EU jurisdiction),
# with the proof that the backup restores.
#
# The Cloudflare build (bot + web) shares one PlanetScale Postgres (see
# docs/db-migrations.md). A backup with no restore test is a rumour, so this
# script takes the dump the same way every time (`pg_dump -Fc`) and can prove
# the dump restores into a scratch database by comparing every table's row
# count before and after.
#
# Backup target naming: neon/<branch>-<branch>-<UTC>.dump inside R2 (the
# `neon` R2 key prefix is retained deliberately so pre-rename manifests and
# archives stay addressable; it names the key layout, not the live provider)
# `two-web-next-backups` (EU-jurisdiction-pinned; jurisdiction immutable after
# creation). Weeklies are `promote-weekly` copies named
# <daily-without-.dump>-weekly-<UTC>.dump. Retention (rotate): newest 7 dailies + newest
# 4 weeklies — the same policy as two-web bin/pg-backup.sh. Supported policy
# bounds: BACKUP_KEEP_DAILY 1..365, BACKUP_KEEP_WEEKLY 1..52.
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
#   ./bin/db-backup.sh backup [branch]
#     Dumps DATABASE_URL (branch defaults to BACKUP_TARGET, otherwise staging)
#     with pg_dump -Fc to a temp file, uploads
#     it and a digest receipt to the branch prefix, verifies read-back bytes,
#     then rewrites and re-downloads the manifest as the publication proof.
#     Never leaves a partial file under the final name: the dump lands in a
#     temp file first and is moved into place only on success.
#
#   ./bin/db-backup.sh promote-weekly [branch]
#     Verifies the newest daily's receipt, copies it to a weekly name with a
#     new receipt, verifies read-back, then rewrites the paired manifest.
#
#   ./bin/db-backup.sh rotate [branch] [--dry-run] [--apply] [--json]
#     Computes one deterministic retention plan (newest-7-daily/newest-4-weekly
#     by default) and either previews or applies it. Bare `rotate` and
#     `--dry-run` are identical nonmutating previews printing exact disjoint
#     keep:/delete: archive lines and changing nothing. Only `--apply` deletes
#     the planned archives (plus manifest-registered receipts) via
#     `wrangler r2 object delete --remote --force`, then rewrites the manifest;
#     apply is idempotent across partial-failure retries. `--json` emits a
#     byte-stable version-1 plan document with mode, policy, keep/delete,
#     actions and a safe nextAction instead of text lines.
#
#   ./bin/db-backup.sh check [branch] [--require-verified]
#     Re-downloads each archive and verifies its digest receipt. Legacy archives
#     without a paired receipt are explicitly unverified; --require-verified
#     also fails those. Missing new receipts always fail. See docs/backup-integrity.md.
#
# Connection: DATABASE_URL env only (e.g. PLANETSCALE_STAGING_DATABASE_URL or
# PRODUCTION_BACKUP_DATABASE_URL exported as DATABASE_URL by the caller or the
# CI workflow; production is the PlanetScale direct 5432 endpoint, never 6432).
# There is no argv, file, or default-credential fallback: an unset
# DATABASE_URL is a hard error, so a half-configured box can never silently
# dump the wrong database. Tests run against agent-testdb only, never prod.
#
# Needs: pg_dump + psql (CI: postgres:18 image service / apt), wrangler with
# CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
#
# Env overrides (mirroring two-web pg-backup.sh):
#   BACKUP_KEEP_DAILY (default 7, supported 1..365),
#   BACKUP_KEEP_WEEKLY (default 4, supported 1..52),
#   BACKUP_BUCKET (default two-web-next-backups),
#   BACKUP_JURISDICTION (default eu),
#   BACKUP_PREFIX (default neon).
#   BACKUP_TARGET (staging|production): declare the DATABASE_URL target for
#     branch correspondence checks on every command. Empty/omitted branch
#     defaults to that target (otherwise staging); overrides must equal the
#     target or start with test-. Unset retains legacy local branch behavior.
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
  echo "usage: $0 backup [branch] | $0 promote-weekly [branch] | $0 rotate [branch] [--dry-run] [--apply] [--json] | $0 check [branch] [--require-verified]" >&2
  exit 2
}

CMD="${1:-}"
[ -n "$CMD" ] || usage
shift || true

DRY_RUN=0
APPLY=0
JSON_OUT=0
REQUIRE_VERIFIED=0
BRANCH=""
BRANCH_SET=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      [ "$DRY_RUN" = 0 ] || { echo "db-backup: duplicate flag '--dry-run'" >&2; usage; }
      DRY_RUN=1 ;;
    --apply)
      [ "$APPLY" = 0 ] || { echo "db-backup: duplicate flag '--apply'" >&2; usage; }
      APPLY=1 ;;
    --json)
      [ "$JSON_OUT" = 0 ] || { echo "db-backup: duplicate flag '--json'" >&2; usage; }
      JSON_OUT=1 ;;
    --require-verified)
      [ "$CMD" = check ] || usage
      [ "$REQUIRE_VERIFIED" = 0 ] || { echo "db-backup: duplicate flag '--require-verified'" >&2; usage; }
      REQUIRE_VERIFIED=1 ;;
    -*) echo "db-backup: unknown flag '$arg'" >&2; usage ;;
    *)
      [ "$BRANCH_SET" = 0 ] || { echo "db-backup: duplicate branch argument '$arg' (repeated positional branch)" >&2; usage; }
      BRANCH="$arg"
      BRANCH_SET=1 ;;
  esac
done

if [ "$APPLY" = 1 ] && [ "$DRY_RUN" = 1 ]; then
  echo "db-backup: contradictory flags: --apply and --dry-run are mutually exclusive" >&2
  usage
fi

# --dry-run/--apply/--json are documented for rotate only (see usage above).
# For any other command --dry-run used to be silently ignored — `backup
# --dry-run` still dumped and uploaded, `promote-weekly --dry-run` still wrote
# the manifest. Reject them here, before any connection, pg_dump, wrangler,
# temp-dir or manifest work can happen.
if [ "$DRY_RUN" = 1 ] && [ "$CMD" != "rotate" ]; then
  echo "db-backup: --dry-run is only supported for 'rotate'" >&2
  usage
fi
if [ "$APPLY" = 1 ] && [ "$CMD" != "rotate" ]; then
  echo "db-backup: --apply is only supported for 'rotate'" >&2
  usage
fi
if [ "$JSON_OUT" = 1 ] && [ "$CMD" != "rotate" ]; then
  echo "db-backup: --json is only supported for 'rotate'" >&2
  usage
fi

# Refuse mislabeling before connection checks, temp files, or any storage I/O.
BRANCH="$(python3 "$ROOT/bin/backup/branch-target-helper" "${BACKUP_TARGET:-}" "$BRANCH")"

# DATABASE_URL comes from the environment only. No .env parsing, no defaults:
# a dump must never guess which database it is reading.
require_database_url() {
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "db-backup: refusing: DATABASE_URL is unset. Export it (e.g. from PLANETSCALE_STAGING_DATABASE_URL) before running." >&2
    exit 1
  fi
}

# pg_dump must never see a password on argv: split DATABASE_URL into
# PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE via python (present everywhere
# this script runs: CI image, operator boxes) and exec pg_dump with PG* env.
# The password may be empty (agent-testdb trust auth): only
# unset DATABASE_URL refuses. An empty PGPASSWORD is exported so libpq never
# falls back to prompting.
dump_to_file() {
  local out="$1"
  require_database_url
  command -v pg_dump >/dev/null || { echo "db-backup: pg_dump not found" >&2; exit 1; }
  # No eval or parent-shell credential exports. The helper validates before
  # exec and isolates libpq from ambient PG* target/service/password settings.
  # Exit here on failure while do_backup's local temp-file trap is still in scope.
  python3 "$ROOT/bin/backup/connection-helper" "$out" || exit "$?"
}

prefix() { printf '%s/%s-%s' "$BACKUP_PREFIX" "$BRANCH" "$BRANCH"; }
manifest_key() { printf '%s/%s-%s/MANIFEST.txt' "$BACKUP_PREFIX" "$BRANCH" "$BRANCH"; }

# WRANGLER_BIN overrides the wrangler invocation (ci/db-backup-selftest.sh
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
    echo "db-backup: manifest read failed; refusing remote mutation" >&2
    exit 1
  fi
}

remote_tmp() { mktemp -d; }
receipt_key() { printf '%s.digest.json' "$1"; }
integrity() { python3 "$ROOT/bin/backup/integrity-helper" "$@"; }

# Retention counts are validated before any storage call. Unset or empty means
# the documented defaults (already applied via := above); any other value must
# be a canonical decimal integer (^[1-9][0-9]*$) within the supported bounds.
validate_retention_counts() {
  local val
  val="$BACKUP_KEEP_DAILY"
  if ! [[ "$val" =~ ^[1-9][0-9]*$ ]] || [ "${#val}" -gt 3 ] || [ "$val" -gt 365 ]; then
    echo "db-backup: invalid BACKUP_KEEP_DAILY='$val' (expected 1..365)" >&2
    usage
  fi
  val="$BACKUP_KEEP_WEEKLY"
  if ! [[ "$val" =~ ^[1-9][0-9]*$ ]] || [ "${#val}" -gt 2 ] || [ "$val" -gt 52 ]; then
    echo "db-backup: invalid BACKUP_KEEP_WEEKLY='$val' (expected 1..52)" >&2
    usage
  fi
}

# Byte-stable retention-plan JSON: sorted keys, sorted arrays, no timestamps.
emit_retention_json() {
  python3 - "$@" <<'PY'
import json, pathlib, sys
code, mode, keep_path, delete_path, manifest_path, branch, keep_daily, keep_weekly, next_action = sys.argv[1:10]
keep = [line for line in pathlib.Path(keep_path).read_text().splitlines() if line]
delete = [line for line in pathlib.Path(delete_path).read_text().splitlines() if line]
manifest_lines = set(pathlib.Path(manifest_path).read_text().splitlines())
keep_sorted = sorted(keep)
delete_sorted = sorted(delete)
actions = []
for key in delete_sorted:
    receipt = key + ".digest.json"
    actions.append({"op": "delete", "key": key, "receipt": receipt if receipt in manifest_lines else None})
obj = {
    "version": 1,
    "code": code,
    "mode": mode,
    "branch": branch,
    "policy": {"keepDaily": int(keep_daily), "keepWeekly": int(keep_weekly)},
    "keep": keep_sorted,
    "delete": delete_sorted,
    "actions": actions,
    "nextAction": next_action,
}
json.dump(obj, sys.stdout, sort_keys=True, indent=2)
sys.stdout.write("\n")
PY
}

emit_retention_partial_json() {
  python3 - "$@" <<'PY'
import json, pathlib, sys
keep_path, delete_path, manifest_path, branch, keep_daily, keep_weekly, completed_path, failed_path, next_action = sys.argv[1:10]
keep = [line for line in pathlib.Path(keep_path).read_text().splitlines() if line]
delete = [line for line in pathlib.Path(delete_path).read_text().splitlines() if line]
manifest_lines = set(pathlib.Path(manifest_path).read_text().splitlines())
completed = [line for line in pathlib.Path(completed_path).read_text().splitlines() if line]
failed = [line for line in pathlib.Path(failed_path).read_text().splitlines() if line]
keep_sorted = sorted(keep)
delete_sorted = sorted(delete)
actions = []
for key in delete_sorted:
    receipt = key + ".digest.json"
    actions.append({"op": "delete", "key": key, "receipt": receipt if receipt in manifest_lines else None})
obj = {
    "version": 1,
    "code": "retention.plan.partial_failure",
    "mode": "apply",
    "branch": branch,
    "policy": {"keepDaily": int(keep_daily), "keepWeekly": int(keep_weekly)},
    "keep": keep_sorted,
    "delete": delete_sorted,
    "actions": actions,
    "completed": sorted(completed),
    "failed": sorted(failed),
    "nextAction": next_action,
}
json.dump(obj, sys.stdout, sort_keys=True, indent=2)
sys.stdout.write("\n")
PY
}

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
  cmp -s "$dir/receipt.json" "$dir/read-back.json" || { echo "db-backup: receipt read-back failed: $key" >&2; exit 1; }
}

do_backup() {
  require_database_url
  local ts key dir
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  key="$(prefix)-${ts}.dump"
  dir="$(remote_tmp)"
  trap '[ -n "${dir:-}" ] && rm -rf "$dir"' EXIT
  # Target validation and the local dump come first: an invalid target must
  # refuse before any storage call. Then admit the existing inventory and the
  # new archive + receipt keys before any remote mutation (archive upload,
  # receipt upload, manifest rewrite).
  dump_to_file "$dir/local.dump"
  [ -s "$dir/local.dump" ] || { echo "db-backup: refusing to upload an empty dump" >&2; exit 1; }
  fetch_manifest "$dir/MANIFEST.txt" 1
  admit_manifest append "$dir/MANIFEST.txt" "$key" "$(receipt_key "$key")"
  upload_verified "$key" "$dir/local.dump" "$dir"
  # Manifest publication is separate from byte verification; retain its proof.
  write_manifest "$dir/MANIFEST.txt"
  fetch_manifest "$dir/PROOF.txt"
  for published in "$key" "$(receipt_key "$key")"; do
    grep -qxF "$published" "$dir/PROOF.txt" || { echo "db-backup: upload proof failed: $published missing from re-downloaded manifest" >&2; exit 1; }
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
  trap '[ -n "${dir:-}" ] && rm -rf "$dir"' EXIT
  fetch_manifest "$dir/MANIFEST.txt"
  src="$(newest_daily "$dir/MANIFEST.txt")"
  [ -n "$src" ] || { echo "db-backup: no daily to promote under branch '$BRANCH'" >&2; exit 1; }
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  weekly="${src%.dump}-weekly-${ts}.dump"
  admit_manifest append "$dir/MANIFEST.txt" "$weekly" "$(receipt_key "$weekly")"
  wr r2 object get "$BACKUP_BUCKET/$src" --file "$dir/dl.dump" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null
  if ! wr r2 object get "$BACKUP_BUCKET/$(receipt_key "$src")" --file "$dir/source.json" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null 2>&1; then
    echo "db-backup: unverified: $src (receipt unavailable); refusing promotion" >&2
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
# Deletes are idempotent: an already-missing object (a retried partial apply,
# confirmed by the explicit missing-key diagnostic) counts as done; any other
# probe outcome after a failed delete fails.
delete_archive_pair() {
  local key="$1" manifest="$2" workdir="$3" receipt probe probe_stderr
  receipt="$(receipt_key "$key")"
  probe="$workdir/probe.tmp"
  probe_stderr="$workdir/probe.stderr"
  if ! wr r2 object delete "$BACKUP_BUCKET/$key" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null 2>&1; then
    if wr r2 object get "$BACKUP_BUCKET/$key" --file "$probe" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null 2>"$probe_stderr" \
       || ! python3 "$ROOT/bin/backup/manifest-helper" missing "$probe_stderr"; then
      echo "db-backup: delete failed: $key" >&2
      rm -f "$probe" "$probe_stderr"
      return 1
    fi
    rm -f "$probe" "$probe_stderr"
  fi
  if grep -qxF "$receipt" "$manifest"; then
    if ! wr r2 object delete "$BACKUP_BUCKET/$receipt" --remote --force --jurisdiction "$BACKUP_JURISDICTION" >/dev/null 2>&1; then
      if wr r2 object get "$BACKUP_BUCKET/$receipt" --file "$probe" --remote --jurisdiction "$BACKUP_JURISDICTION" >/dev/null 2>"$probe_stderr" \
         || ! python3 "$ROOT/bin/backup/manifest-helper" missing "$probe_stderr"; then
        echo "db-backup: delete failed: $receipt" >&2
        rm -f "$probe" "$probe_stderr"
        return 1
      fi
      rm -f "$probe" "$probe_stderr"
    fi
  fi
  rm -f "$probe" "$probe_stderr"
  echo "delete: $key"
  return 0
}

do_rotate() {
  validate_retention_counts
  local dir daily_total weekly_total delete_count key receipt
  local failed_key apply_failed next_action delete_total
  dir="$(remote_tmp)"
  trap '[ -n "${dir:-}" ] && rm -rf "$dir"' EXIT
  fetch_manifest "$dir/MANIFEST.txt"
  # One deterministic plan shared by preview and apply: archives sorted
  # ascending, newest BACKUP_KEEP_DAILY dailies + newest BACKUP_KEEP_WEEKLY
  # weeklies kept, the rest deleted. keep + delete are disjoint and cover every
  # manifest archive; receipt lines never enter either set.
  grep -E '\.dump$' "$dir/MANIFEST.txt" | grep -v '\-weekly\-' | sort > "$dir/dailies.txt" || true
  grep -E '\-weekly\-.*\.dump$' "$dir/MANIFEST.txt" | sort > "$dir/weeklies.txt" || true
  daily_total="$(wc -l < "$dir/dailies.txt" | tr -d ' ')"
  weekly_total="$(wc -l < "$dir/weeklies.txt" | tr -d ' ')"
  if [ "$daily_total" -gt "$BACKUP_KEEP_DAILY" ]; then
    delete_count=$((daily_total - BACKUP_KEEP_DAILY))
    head -n "$delete_count" "$dir/dailies.txt" > "$dir/daily-delete.txt"
    tail -n "$BACKUP_KEEP_DAILY" "$dir/dailies.txt" > "$dir/daily-keep.txt"
  else
    : > "$dir/daily-delete.txt"
    cp "$dir/dailies.txt" "$dir/daily-keep.txt"
  fi
  if [ "$weekly_total" -gt "$BACKUP_KEEP_WEEKLY" ]; then
    delete_count=$((weekly_total - BACKUP_KEEP_WEEKLY))
    head -n "$delete_count" "$dir/weeklies.txt" > "$dir/weekly-delete.txt"
    tail -n "$BACKUP_KEEP_WEEKLY" "$dir/weeklies.txt" > "$dir/weekly-keep.txt"
  else
    : > "$dir/weekly-delete.txt"
    cp "$dir/weeklies.txt" "$dir/weekly-keep.txt"
  fi
  cat "$dir/daily-keep.txt" "$dir/weekly-keep.txt" | grep -v '^$' | sort > "$dir/keep.txt" || true
  cat "$dir/daily-delete.txt" "$dir/weekly-delete.txt" | grep -v '^$' | sort > "$dir/delete.txt" || true
  : > "$dir/keep.txt.tmp"; grep -v '^$' "$dir/keep.txt" > "$dir/keep.txt.tmp" || true; mv "$dir/keep.txt.tmp" "$dir/keep.txt"
  : > "$dir/delete.txt.tmp"; grep -v '^$' "$dir/delete.txt" > "$dir/delete.txt.tmp" || true; mv "$dir/delete.txt.tmp" "$dir/delete.txt"
  delete_total="$(wc -l < "$dir/delete.txt" | tr -d ' ')"
  # Preview: bare rotate and --dry-run are identical and nonmutating.
  if [ "$APPLY" = 0 ]; then
    if [ "$JSON_OUT" = 1 ]; then
      next_action="Run ./bin/db-backup.sh rotate $BRANCH --apply to delete $delete_total planned archives"
      emit_retention_json "retention.plan.preview" "preview" "$dir/keep.txt" "$dir/delete.txt" "$dir/MANIFEST.txt" "$BRANCH" "$BACKUP_KEEP_DAILY" "$BACKUP_KEEP_WEEKLY" "$next_action"
    else
      [ -s "$dir/delete.txt" ] && sed 's/^/delete: /' "$dir/delete.txt" || true
      [ -s "$dir/keep.txt" ] && sed 's/^/keep: /' "$dir/keep.txt" || true
    fi
    rm -rf "$dir"
    trap - EXIT
    return 0
  fi
  # Apply: delete exactly the planned targets, nothing else.
  : > "$dir/completed.txt"
  : > "$dir/failed.txt"
  apply_failed=0
  failed_key=""
  if [ "$JSON_OUT" = 1 ]; then
    while IFS= read -r key || [ -n "$key" ]; do
      [ -n "$key" ] || continue
      if delete_archive_pair "$key" "$dir/MANIFEST.txt" "$dir" >"$dir/one-out.txt" 2>"$dir/one-err.txt"; then
        printf '%s\n' "$key" >> "$dir/completed.txt"
      else
        cat "$dir/one-err.txt" >&2 || true
        printf '%s\n' "$key" >> "$dir/failed.txt"
        apply_failed=1
        failed_key="$key"
        break
      fi
    done < "$dir/delete.txt"
    if [ "$apply_failed" = 1 ]; then
      next_action="Delete failed for $failed_key; re-run ./bin/db-backup.sh rotate $BRANCH --apply to retry"
      emit_retention_partial_json "$dir/keep.txt" "$dir/delete.txt" "$dir/MANIFEST.txt" "$BRANCH" "$BACKUP_KEEP_DAILY" "$BACKUP_KEEP_WEEKLY" "$dir/completed.txt" "$dir/failed.txt" "$next_action"
      rm -rf "$dir"
      trap - EXIT
      exit 1
    fi
    if [ -s "$dir/delete.txt" ]; then
      cp "$dir/keep.txt" "$dir/retained.txt"
      while IFS= read -r key || [ -n "$key" ]; do
        [ -n "$key" ] || continue
        receipt="$(receipt_key "$key")"
        if grep -qxF "$receipt" "$dir/MANIFEST.txt"; then
          printf '%s\n' "$receipt" >> "$dir/retained.txt"
        fi
      done < "$dir/keep.txt"
      write_manifest "$dir/retained.txt"
    fi
    next_action="Rotation applied; run ./bin/db-backup.sh check $BRANCH to verify"
    emit_retention_json "retention.plan.applied" "apply" "$dir/keep.txt" "$dir/delete.txt" "$dir/MANIFEST.txt" "$BRANCH" "$BACKUP_KEEP_DAILY" "$BACKUP_KEEP_WEEKLY" "$next_action"
    rm -rf "$dir"
    trap - EXIT
    return 0
  fi
  while IFS= read -r key || [ -n "$key" ]; do
    [ -n "$key" ] || continue
    if delete_archive_pair "$key" "$dir/MANIFEST.txt" "$dir"; then
      printf '%s\n' "$key" >> "$dir/completed.txt"
    else
      apply_failed=1
      break
    fi
  done < "$dir/delete.txt"
  if [ "$apply_failed" = 1 ]; then
    rm -rf "$dir"
    trap - EXIT
    exit 1
  fi
  if [ -s "$dir/delete.txt" ]; then
    cp "$dir/keep.txt" "$dir/retained.txt"
    while IFS= read -r key || [ -n "$key" ]; do
      [ -n "$key" ] || continue
      receipt="$(receipt_key "$key")"
      if grep -qxF "$receipt" "$dir/MANIFEST.txt"; then
        printf '%s\n' "$receipt" >> "$dir/retained.txt"
      fi
    done < "$dir/keep.txt"
    write_manifest "$dir/retained.txt"
  fi
  rm -rf "$dir"
  trap - EXIT
}

do_check() {
  local dir failed=0 unverified=0 key receipt
  dir="$(remote_tmp)"
  trap '[ -n "${dir:-}" ] && rm -rf "$dir"' EXIT
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
  [ "$failed" = 0 ] || { echo "db-backup: check failed" >&2; exit 1; }
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
