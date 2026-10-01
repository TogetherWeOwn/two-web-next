#!/usr/bin/env bash
#
# Hermetic argv regression selftest for bin/neon-backup.sh (TOG-11228).
#
# `--dry-run` is documented for `rotate` only, but the parser accepted it for
# every command and `backup`/`promote-weekly` then silently ignored it: they
# still dumped, uploaded and rewrote the manifest. The script now rejects the
# flag for non-rotate commands BEFORE any connection, pg_dump, wrangler,
# directory/temp or manifest work.
#
# This test proves the rejection order: every external command the script can
# reach (wrangler via WRANGLER_BIN, pg_dump/psql/mktemp via PATH) is a stub
# that appends to a call log, and after each unsupported invocation the log
# and the stub bucket must both be empty. A real `backup` run at the end is
# the positive control proving the stubs do observe calls, so an empty log is
# meaningful. `rotate --dry-run` is the keep-valid control.
#
# No network, no Neon, no R2, no archive/restore, no credentials: DATABASE_URL
# is deliberately left EMPTY for the rejection cases so the test also proves
# the flag is rejected before the DATABASE_URL check (a wrong ordering would
# exit 1 with the DATABASE_URL diagnostic instead of usage).
#
# Every `ok:` line is one passing assertion; exits non-zero on first failure.

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
export CALL_LOG="$T/calls.log"
: > "$CALL_LOG"

REAL_MKTEMP="$(command -v mktemp)"

# Stubbed external commands: log argv, then behave just enough that reaching
# them would look like progress (a silent stub could hide a regression).
mkdir -p "$T/fakebin"
cat > "$T/fakebin/pg_dump" <<'FAKE'
#!/usr/bin/env bash
echo "pg_dump $*" >> "$CALL_LOG"
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
cat > "$T/fakebin/psql" <<'FAKE'
#!/usr/bin/env bash
echo "psql $*" >> "$CALL_LOG"
exit 0
FAKE
chmod +x "$T/fakebin/psql"
# mktemp: "directory/temp work" must not happen for a rejected flag either.
cat > "$T/fakebin/mktemp" <<FAKE
#!/usr/bin/env bash
echo "mktemp \$*" >> "\$CALL_LOG"
exec "$REAL_MKTEMP" "\$@"
FAKE
chmod +x "$T/fakebin/mktemp"
export PATH="$T/fakebin:$PATH"

# Stub wrangler: logs the call, then emulates `r2 object put|get|delete`
# against STUB_R2 exactly like ci/neon-backup-selftest.sh.
cat > "$T/wrangler-stub" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "wrangler $*" >> "$CALL_LOG"
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
    [ -f "$dest" ] || exit 1
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
# Deliberately NOT exporting DATABASE_URL: the flag rejection must precede the
# connection setup, so an unset URL must not mask the usage error.

BIN="./bin/neon-backup.sh"

# expect_reject DESC ARGS... — invocation must exit non-zero, print the
# --dry-run diagnostic plus usage to stderr, and leave zero observed side
# effects (empty call log, empty stub bucket).
expect_reject() {
  local desc="$1"; shift
  : > "$CALL_LOG"
  local rc=0
  "$BIN" "$@" >"$T/out" 2>"$T/err" || rc=$?
  [ "$rc" != 0 ] || fail "$desc: exited 0"
  [ "$rc" != 1 ] || fail "$desc: exited 1 (DATABASE_URL refusal ran before flag rejection)"
  grep -q -- '--dry-run' "$T/err" || fail "$desc: stderr should name --dry-run: $(cat "$T/err")"
  grep -q 'usage:' "$T/err" || fail "$desc: stderr should print usage: $(cat "$T/err")"
  [ ! -s "$CALL_LOG" ] || fail "$desc: external side effects observed: $(cat "$CALL_LOG")"
  [ -z "$(find "$STUB_R2" -type f -print -quit)" ] || fail "$desc: stub bucket was written"
  ok "$desc rejected with usage and zero side effects"
}

# 1-6. Unsupported invocations, flag in every position the parser accepts.
expect_reject "backup --dry-run"            backup --dry-run
expect_reject "backup staging --dry-run"    backup staging --dry-run
expect_reject "backup --dry-run staging"    backup --dry-run staging
expect_reject "promote-weekly --dry-run"           promote-weekly --dry-run
expect_reject "promote-weekly staging --dry-run"   promote-weekly staging --dry-run
expect_reject "check --dry-run (same silently-ignored defect)" check --dry-run

# 7. Flag in CMD position: `--dry-run backup` parses as an unknown command and
#    still exits non-zero with usage rather than doing work.
: > "$CALL_LOG"
rc=0
"$BIN" --dry-run backup >"$T/out" 2>"$T/err" || rc=$?
[ "$rc" != 0 ] || fail "--dry-run as command: exited 0"
grep -q 'usage:' "$T/err" || fail "--dry-run as command: no usage: $(cat "$T/err")"
[ ! -s "$CALL_LOG" ] || fail "--dry-run as command: side effects: $(cat "$CALL_LOG")"
ok "--dry-run in command position fails with usage"

# 8. Keep-valid control: rotate --dry-run still runs end-to-end (exit 0, keep:
#    lines, no deletes). Seed one daily via the stub so fetch_manifest works.
printf '%s\n' "neon/staging-staging-20250101T000000Z.dump" > "$T/seed-manifest.txt"
"$WRANGLER_BIN" r2 object put "test-bucket/neon/staging-staging/MANIFEST.txt" --file "$T/seed-manifest.txt" --remote >/dev/null
: > "$CALL_LOG"
DRY="$(DATABASE_URL="postgres://tester@fake-host:5432/testdb" "$BIN" rotate staging --dry-run)"
echo "$DRY" | grep -q '^keep: neon/staging-staging-20250101T000000Z.dump$' || fail "rotate --dry-run output: $DRY"
[ -f "$STUB_R2/neon/staging-staging-20250101T000000Z.dump" ] && fail "rotate --dry-run must not create objects" || true
# The seeded manifest line is a list entry, not an object; ensure no delete ran.
grep -q 'delete' "$CALL_LOG" && fail "rotate --dry-run must not delete" || true
ok "rotate --dry-run still runs and deletes nothing"

# 9. Positive control: a real `backup` DOES call the stubs, proving the empty
#    call logs above mean "no side effects", not "stubs never wired".
: > "$CALL_LOG"
OUT="$(DATABASE_URL="postgres://tester:s3lf-test-pw@fake-host:5432/testdb" "$BIN" backup staging)"
echo "$OUT" | grep -q '^backup: neon/staging-staging-.*\.dump$' || fail "control backup output: $OUT"
grep -q '^pg_dump ' "$CALL_LOG" || fail "control: pg_dump call not observed"
grep -q '^wrangler ' "$CALL_LOG" || fail "control: wrangler call not observed"
ok "control backup exercises stubs (empty logs above are meaningful)"

echo "argv-selftest: $PASS passed"
