#!/usr/bin/env bash
#
# Stubbed selftest for bin/db-backup.sh. Runs in CI with no secrets and no
# network: WRANGLER_BIN points at a stub that emulates `wrangler r2 object
# put/get/delete` against a local directory, and a fake pg_dump on PATH emits
# a fixed payload. Proves: backup writes + manifest + upload proof, weekly
# promotion, rotation retention (7 daily / 4 weekly), dry-run deletes nothing,
# check detects a missing key, an unset DATABASE_URL refuses before touching
# anything, and a passwordless DATABASE_URL is accepted (agent-testdb trust
# auth). It also runs ci/backup-manifest-admission-selftest, which proves an
# unreadable, malformed, duplicate or foreign-branch manifest refuses before
# any remote mutation. The dump payload carries a distinctive marker that must never appear
# in the script's stdout (password-hygiene: DATABASE_URL holds a fake
# password and the script must not echo it).
#
# Every `ok:` line is one passing assertion; the script exits non-zero on the
# first failure (set -e + explicit checks).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
ok() { PASS=$((PASS + 1)); echo "ok: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export STUB_R2="$T/r2"
mkdir -p "$STUB_R2"

# Fake pg_dump: honors `-f FILE` like the real one (fixed payload, no secrets).
mkdir -p "$T/fakebin"
cat > "$T/fakebin/pg_dump" <<'FAKE'
#!/usr/bin/env bash
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-f" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] || { echo "fake pg_dump: no -f" >&2; exit 2; }
printf 'FAKEDUMP-payload\n' > "$out"
if [ "${STUB_LARGE:-0}" = 1 ]; then truncate -s 8388608 "$out"; fi
if [ -n "${STUB_DUMP_LOG:-}" ]; then printf 'dump\n' >> "$STUB_DUMP_LOG"; fi
FAKE
chmod +x "$T/fakebin/pg_dump"
export PATH="$T/fakebin:$PATH"

# Stub wrangler: `r2 object put|get|delete BUCKET/KEY [--file F] [--pipe] [--remote]`.
cat > "$T/wrangler-stub" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
op="${3:-}"
path="${4:-}"
key="${path#*/}"
dest="$STUB_R2/$key"
file=""
pipe=0
prev=""
for a in "$@"; do
  if [ "$prev" = "--file" ]; then file="$a"; fi
  if [ "$a" = "--pipe" ]; then pipe=1; fi
  prev="$a"
done
case "$op" in
  put)
    [ -n "$file" ] || exit 2
    mkdir -p "$(dirname "$dest")"
    cp "$file" "$dest"
    ;;
  get)
    # Wrangler's explicit null-object diagnostic (first-use initialization);
    # any other failed GET is a transport/auth error the script must refuse.
    [ -f "$dest" ] || { echo "✘ [ERROR] The specified key does not exist." >&2; exit 1; }
    if [ "$pipe" = 1 ]; then cat "$dest"; else cp "$dest" "$file"; fi
    ;;
  delete)
    [ -f "$dest" ] || exit 1
    rm "$dest"
    ;;
  *) exit 2 ;;
esac
STUB
chmod +x "$T/wrangler-stub"
export WRANGLER_BIN="$T/wrangler-stub"
unset BACKUP_TRANSPORT

export BACKUP_BUCKET="test-bucket"
export BACKUP_PREFIX="neon"
export DATABASE_URL="postgres://tester:s3lf-test-pw-abc123@fake-host:5432/testdb"

BIN="./bin/db-backup.sh"
MANIFEST="neon/staging-staging/MANIFEST.txt"

# 1-2. Two backups land with distinct keys + manifest proof.
OUT1="$("$BIN" backup staging)"
echo "$OUT1" | grep -q '^backup: neon/staging-staging-.*\.dump$' || fail "backup output shape: $OUT1"
ok "backup writes key 1"
[ "$OUT1" = "${OUT1//s3lf-test-pw-abc123/}" ] || fail "password leaked to stdout"
ok "backup stdout carries no password"
sleep 1
OUT2="$("$BIN" backup staging)"
KEY1="$(echo "$OUT1" | sed 's/^backup: //')"
KEY2="$(echo "$OUT2" | sed 's/^backup: //')"
[ "$KEY1" != "$KEY2" ] || fail "successive backups must have distinct keys"
ok "successive backups have distinct keys"

# 3. Manifest holds both keys (re-downloaded proof already asserted inside backup).
"$WRANGLER_BIN" r2 object get "test-bucket/$MANIFEST" --file "$T/m.txt" --remote >/dev/null
grep -qxF "$KEY1" "$T/m.txt" || fail "manifest missing key 1"
grep -qxF "$KEY2" "$T/m.txt" || fail "manifest missing key 2"
ok "manifest holds both keys"

# 4. Weekly promotion copies newest daily to a weekly name.
PROMO="$("$BIN" promote-weekly staging)"
echo "$PROMO" | grep -q -- '-weekly-' || fail "promote-weekly output shape: $PROMO"
ok "promote-weekly names a weekly copy"

# 5. Seed old fixtures: 6 extra dailies + 5 extra weeklies via the stub, then
#    append them to the remote manifest the same way the script does.
"$WRANGLER_BIN" r2 object get "test-bucket/$MANIFEST" --file "$T/m.txt" --remote >/dev/null
i=1
while [ "$i" -le 6 ]; do
  k="neon/staging-staging-2025010${i}T000000Z.dump"
  echo "old" > "$T/old.dump"
  "$WRANGLER_BIN" r2 object put "test-bucket/$k" --file "$T/old.dump" --remote >/dev/null
  printf '%s\n' "$k" >> "$T/m.txt"
  i=$((i + 1))
done
i=1
while [ "$i" -le 5 ]; do
  k="neon/staging-staging-2024010${i}T000000Z-weekly-2024010${i}T000000Z.dump"
  "$WRANGLER_BIN" r2 object put "test-bucket/$k" --file "$T/old.dump" --remote >/dev/null
  printf '%s\n' "$k" >> "$T/m.txt"
  i=$((i + 1))
done
sort -o "$T/m.txt" "$T/m.txt"
"$WRANGLER_BIN" r2 object put "test-bucket/$MANIFEST" --file "$T/m.txt" --remote >/dev/null
# Now: 8 dailies (delete 1), 6 weeklies (delete 2) -> 3 deletions.
DRY="$("$BIN" rotate staging --dry-run)"
[ "$(echo "$DRY" | grep -c '^delete: ')" = 3 ] || fail "dry-run delete count: $DRY"
ok "rotate --dry-run prints 3 delete lines"
"$BIN" check staging >/dev/null || fail "dry-run must delete nothing"
ok "rotate --dry-run deletes nothing"

# 6. Real rotation enforces newest-7-daily / newest-4-weekly. Deletion needs
#    the explicit --apply plan confirmation; a bare rotate only previews.
"$BIN" rotate staging --apply >/dev/null
"$WRANGLER_BIN" r2 object get "test-bucket/$MANIFEST" --file "$T/m2.txt" --remote >/dev/null
DAILIES="$(grep -E '\.dump$' "$T/m2.txt" | grep -vc '\-weekly\-' || true)"
WEEKLIES="$(grep -cE '\-weekly\-.*\.dump$' "$T/m2.txt" || true)"
[ "$DAILIES" = 7 ] || fail "expected 7 dailies, manifest has $DAILIES"
[ "$WEEKLIES" = 4 ] || fail "expected 4 weeklies, manifest has $WEEKLIES"
ok "rotation keeps 7 dailies + 4 weeklies"

# 7. Check passes on the rotated set.
"$BIN" check staging >/dev/null || fail "check on healthy set"
ok "check passes on healthy set"

# 8. Check fails when a key goes missing.
VICTIM="$(head -n 1 "$T/m2.txt")"
rm "$STUB_R2/$VICTIM"
if "$BIN" check staging >/dev/null 2>&1; then fail "check must fail on missing key"; fi
ok "check fails on missing key"

# 9. Unset DATABASE_URL refuses before touching anything (empty password is
#    fine — agent-testdb trust auth — so only the unset case refuses).
if DATABASE_URL='' "$BIN" backup staging >/dev/null 2>&1; then fail "backup must refuse unset DATABASE_URL"; fi
ok "backup refuses unset DATABASE_URL"
# Backup keys carry second-resolution timestamps: stay out of OUT2's second so
# the passwordless backup cannot collide with it (TOG-13095 CI flake).
sleep 1
OUT_PWLESS="$(DATABASE_URL="postgres://tester@fake-host:5432/testdb" "$BIN" backup staging)"
echo "$OUT_PWLESS" | grep -q '^backup: ' || fail "backup must accept a passwordless DATABASE_URL"
ok "backup accepts passwordless DATABASE_URL"

# 10. EU pinning (TOG-9837): the default bucket is the EU-pinned
# `two-web-next-backups` and every `wrangler r2 object` call addresses the EU
# jurisdiction explicitly — never the default jurisdiction.
grep -q 'BACKUP_BUCKET:=two-web-next-backups' "$BIN" || fail "default bucket must be two-web-next-backups"
ok "default bucket is two-web-next-backups"
UNWIRED="$(grep 'wr r2 object' "$BIN" | grep -vc 'BACKUP_JURISDICTION' || true)"
[ "$UNWIRED" = 0 ] || fail "$UNWIRED r2 object call(s) lack --jurisdiction"
ok "every r2 object call passes --jurisdiction"

# 11. Manifest admission (TOG-11194): unreadable/foreign/malformed/duplicate
# manifests must refuse before any remote mutation. Own local fake R2; run it
# from this entrypoint so the required CI step covers it too.
if ! python3 ci/backup-manifest-admission-selftest > "$T/admission.log" 2>&1; then
  cat "$T/admission.log" >&2
  fail "manifest admission selftest failed"
fi
ok "manifest admission selftest passes"

# The AWS stub uses its own store and rejects unexpected argv before writing.
export BACKUP_TRANSPORT=s3 BACKUP_JURISDICTION=eu AWS_BIN="$ROOT/ci/fixtures/db-backup/aws" WRANGLER_BIN=/bin/false
export R2_ACCOUNT_ID=00000000000000000000000000000000
export R2_S3_ACCESS_KEY_ID=fixture-access R2_S3_SECRET_ACCESS_KEY=fixture-secret AWS_PROFILE=unused AWS_SESSION_TOKEN=unused
export STUB_R2="$T/s3" STUB_LOG="$T/s3.log" STUB_DUMP_LOG="$T/dump.log"
expect_failure() { if "$@" >"$T/out" 2>"$T/err"; then fail "expected failure: $*"; fi; }
expect_failure env BACKUP_TRANSPORT=unknown "$BIN" backup staging
expect_failure env R2_S3_SECRET_ACCESS_KEY= "$BIN" backup staging
[ ! -e "$STUB_DUMP_LOG" ] && [ ! -e "$STUB_LOG" ] || fail "invalid S3 setup connected"
ok "invalid transport or incomplete S3 credentials refuse before dump and storage"
for error in 403 NoSuchBucket transport noisy partial; do
  expect_failure env STUB_FAIL_KEY="$MANIFEST" STUB_GET_ERROR="$error" "$BIN" backup staging
  grep -qxF 'db-backup: manifest read failed; refusing remote mutation' "$T/err" || fail "unexpected $error failure"
done
! grep -vxF "get-object $MANIFEST" "$STUB_LOG" || fail "failed S3 manifest read mutated storage"
ok "forbidden, wrong bucket, transport and partial reads never initialize the S3 manifest"

S3_OUT="$(STUB_LARGE=1 "$BIN" backup staging)"
grep -qxF "multipart ${S3_OUT#backup: }" "$STUB_LOG" || fail "large dump did not use multipart upload"
"$BIN" promote-weekly staging >/dev/null
"$BIN" check staging --require-verified >/dev/null
ok "S3 backup initializes on NoSuchKey and verifies multipart dump, receipt and weekly copy"

manifest="$STUB_R2/$MANIFEST"
cp "$manifest" "$T/s3-before"
: > "$STUB_LOG"
expect_failure env STUB_FAIL_KEY="$MANIFEST" STUB_GET_ERROR=404 "$BIN" backup staging
grep -qxF 'db-backup: manifest read failed; refusing remote mutation' "$T/err" || fail "generic 404 was treated as absence"
[ "$(<"$STUB_LOG")" = "get-object $MANIFEST" ] && cmp "$manifest" "$T/s3-before" || fail "generic 404 changed storage"
ok "S3 backup rejects an ambiguous 404 without changing the existing inventory"

absent=neon/staging-staging-20240101T000000Z.dump
old=neon/staging-staging-20240102T000000Z.dump
printf 'old\n' > "$STUB_R2/$old"
printf '%s\n' "$old" >> "$manifest"
"$BIN" check staging >/dev/null
expect_failure env STUB_FAIL_KEY="$old.digest.json" STUB_GET_ERROR=403 "$BIN" check staging
grep -qxF 'db-backup: check failed' "$T/err" || fail "legacy receipt error did not fail check"
ok "S3 legacy check tolerates an absent receipt but refuses an unreadable one"

printf '%s\n' "$absent" "$absent.digest.json" "$old.digest.json" >> "$manifest"
printf 'unused receipt\n' > "$STUB_R2/$old.digest.json"
cp "$manifest" "$T/s3-before"
export STUB_DELETE_FAILURE_KEY="$absent"
for error in 403 404; do
  expect_failure env BACKUP_KEEP_DAILY=1 STUB_FAIL_KEY="$absent" STUB_GET_ERROR="$error" "$BIN" rotate staging --apply
  cmp "$manifest" "$T/s3-before" && [ -f "$STUB_R2/$old" ] || fail "$error delete probe changed retention"
done
BACKUP_KEEP_DAILY=1 "$BIN" rotate staging --apply >/dev/null
unset STUB_DELETE_FAILURE_KEY
grep -qxF "delete-object $absent.digest.json" "$STUB_LOG" || fail "rotation did not delete an already absent receipt"
! grep -qxF "get-object $absent.digest.json" "$STUB_LOG" || fail "rotation probed after a successful delete"
[ ! -e "$STUB_R2/$old" ] && [ ! -e "$STUB_R2/$old.digest.json" ] || fail "S3 rotation left an old pair"
"$BIN" check staging --require-verified >/dev/null
ok "S3 rotation preserves inventory on ambiguous probes and accepts idempotent deletes"

for suffix in .dump .digest.json; do
  expect_failure env STUB_CORRUPT_SUFFIX="$suffix" "$BIN" backup test-s3
  [ ! -e "$STUB_R2/neon/test-s3-test-s3/MANIFEST.txt" ] || fail "S3 backup published a corrupt $suffix pair"
done
ok "S3 backup refuses digest and receipt read-back mismatches before publishing"

echo "selftest: $PASS passed"
