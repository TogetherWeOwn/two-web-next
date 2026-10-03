#!/usr/bin/env bash
#
# Stubbed selftest for bin/neon-backup.sh. Runs in CI with no secrets and no
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

export BACKUP_BUCKET="test-bucket"
export BACKUP_PREFIX="neon"
export DATABASE_URL="postgres://tester:s3lf-test-pw-abc123@fake-host:5432/testdb"

BIN="./bin/neon-backup.sh"
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

# 6. Real rotation enforces newest-7-daily / newest-4-weekly.
"$BIN" rotate staging >/dev/null
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
if DATABASE_URL= "$BIN" backup staging >/dev/null 2>&1; then fail "backup must refuse unset DATABASE_URL"; fi
ok "backup refuses unset DATABASE_URL"
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

echo "selftest: $PASS passed"
