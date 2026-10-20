#!/usr/bin/env bash
#
# Hermetic branch/target correspondence selftest for bin/db-backup.sh.
#
# The dump source (DATABASE_URL) and the R2 branch prefix are chosen
# independently, so a swapped pair publishes one database's dump under the
# other target's prefix: byte-verification cannot detect wrong-database
# bytes, rotation then counts the foreign archive toward retention, and a
# production member-data dump can land under the staging prefix. The script
# therefore accepts a declared target via the BACKUP_TARGET environment
# variable (`staging` or `production`, naming the database DATABASE_URL
# points at) and must refuse, before any connection, pg_dump, wrangler,
# temp-dir or manifest work, when the branch names the OTHER target. The
# refusal diagnostic must name both the branch and the target.
#
# Refusals pinned here (both swap directions, every branch-taking command):
#   BACKUP_TARGET=staging    + branch production
#   BACKUP_TARGET=production + branch staging
# Invariant: a production-target run with the branch omitted must never
# publish under the staging prefix (refuse naming both inputs, or resolve
# the default branch per-target).
# Controls (unchanged behavior): branch equal to target, test-* override,
# omitted branch with staging target, and every run with BACKUP_TARGET
# unset (including the restore-proof's `synthetic` branch) keep working.
#
# Every external command the script can reach (wrangler via WRANGLER_BIN,
# pg_dump/psql/mktemp via PATH) is a stub that appends to a call log, so an
# empty log plus an empty stub bucket proves refusal happened first. The
# controls exercise the stubs for real, proving empty logs are meaningful.
# Refusal cases deliberately leave DATABASE_URL unset: the correspondence
# refusal must precede the DATABASE_URL check, so the diagnostic naming
# both inputs (not the connection error) is what must appear.
#
# No network, no real database, no R2, no credentials.
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
cat > "$T/fakebin/mktemp" <<FAKE
#!/usr/bin/env bash
echo "mktemp \$*" >> "\$CALL_LOG"
exec "$REAL_MKTEMP" "\$@"
FAKE
chmod +x "$T/fakebin/mktemp"
export PATH="$T/fakebin:$PATH"

# Harness fallback: some runners sanitize PATH for child processes, so
# fakebin never reaches bin/db-backup.sh. Copy the same fakes into the
# run-scoped launcher dir (already on the default PATH); harmless in CI
# where PATH propagates normally.
_LAUNCHER="${PAPERCLIP_GITHUB_LAUNCHER_DIR:-}"
if [ -n "$_LAUNCHER" ] && [ -d "$_LAUNCHER" ] && [ -w "$_LAUNCHER" ]; then
  cp "$T/fakebin/pg_dump" "$_LAUNCHER/pg_dump" && chmod +x "$_LAUNCHER/pg_dump"
  cp "$T/fakebin/psql" "$_LAUNCHER/psql" && chmod +x "$_LAUNCHER/psql"
  trap 'rm -f "$_LAUNCHER/pg_dump" "$_LAUNCHER/psql"; rm -rf "$T"' EXIT
fi

# Stub wrangler: logs the call, then emulates `r2 object put|get|delete`
# against STUB_R2 exactly like ci/db-backup-selftest.sh.
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
FAKE_URL="postgres://tester:s3lf-test-pw@fake-host:5432/testdb"

BIN="./bin/db-backup.sh"

# expect_refuse TARGET BRANCH DESC ARGS... — with BACKUP_TARGET=TARGET and
# DATABASE_URL unset, the invocation must exit non-zero, name BOTH the branch
# and the target on stderr, and leave zero observed side effects.
expect_refuse() {
  local target="$1" branch="$2" desc="$3"; shift 3
  : > "$CALL_LOG"
  local rc=0
  BACKUP_TARGET="$target" "$BIN" "$@" >"$T/out" 2>"$T/err" || rc=$?
  [ "$rc" != 0 ] || fail "$desc: exited 0"
  grep -q "$branch" "$T/err" || fail "$desc: stderr must name branch '$branch': $(cat "$T/err")"
  grep -q "$target" "$T/err" || fail "$desc: stderr must name target '$target': $(cat "$T/err")"
  [ ! -s "$CALL_LOG" ] || fail "$desc: external side effects observed: $(cat "$CALL_LOG")"
  [ -z "$(find "$STUB_R2" -type f -print -quit)" ] || fail "$desc: stub bucket was written"
  ok "$desc refused, naming branch and target, with zero side effects"
}

# 1-5. Swap refusals: both directions, every branch-taking command.
expect_refuse staging production "BACKUP_TARGET=staging backup production" backup production
expect_refuse production staging "BACKUP_TARGET=production backup staging" backup staging
expect_refuse staging production "BACKUP_TARGET=staging promote-weekly production" promote-weekly production
expect_refuse production staging "BACKUP_TARGET=production rotate staging" rotate staging
expect_refuse production staging "BACKUP_TARGET=production check staging" check staging

# 6. Invariant: production target + omitted branch must never publish under
#    the staging prefix. Refusal naming both inputs is acceptable, and so is
#    resolving the default branch per-target (production prefix).
: > "$CALL_LOG"
rc=0
OUT6="$(BACKUP_TARGET="production" DATABASE_URL="$FAKE_URL" "$BIN" backup 2>"$T/err")" || rc=$?
if [ "$rc" != 0 ]; then
  grep -q 'production' "$T/err" || fail "production target + omitted branch: refusal must name the target: $(cat "$T/err")"
  grep -q 'staging' "$T/err" || fail "production target + omitted branch: refusal must name the default branch: $(cat "$T/err")"
  [ ! -s "$CALL_LOG" ] || fail "production target + omitted branch: side effects before refusal: $(cat "$CALL_LOG")"
  ok "production target + omitted branch refused naming both inputs"
else
  echo "$OUT6" | grep -q '^backup: neon/production-production-.*\.dump$' \
    || fail "production target + omitted branch: dump must land under the production prefix, got: $OUT6"
  [ -z "$(find "$STUB_R2" -path '*staging-staging*' -print -quit)" ] \
    || fail "production target + omitted branch: object written under the staging prefix"
  ok "production target + omitted branch resolves to the production prefix"
fi
# Reset the stub bucket so control key assertions start clean.
rm -rf "$STUB_R2"; mkdir -p "$STUB_R2"

# expect_backup DESC EXPECTED_KEY_PREFIX ENV_ASSIGNMENTS... -- ARGS...
expect_backup() {
  local desc="$1" prefix="$2"; shift 2
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  : > "$CALL_LOG"
  local out
  out="$(env "${envs[@]}" DATABASE_URL="$FAKE_URL" "$BIN" "$@")"
  echo "$out" | grep -q "^backup: neon/${prefix}-${prefix}-.*\.dump\$" || fail "$desc: output shape: $out"
  grep -q '^pg_dump ' "$CALL_LOG" || fail "$desc: pg_dump call not observed (stub not exercised)"
  grep -q '^wrangler ' "$CALL_LOG" || fail "$desc: wrangler call not observed (stub not exercised)"
  ok "$desc"
}

# 7-8. Controls: branch equal to the declared target.
expect_backup "BACKUP_TARGET=staging backup staging accepted" staging BACKUP_TARGET=staging -- backup staging
expect_backup "BACKUP_TARGET=production backup production accepted" production BACKUP_TARGET=production -- backup production

# 9-10. Controls: explicit test-* override accepted for either target.
# (sleep: backup keys carry second-resolution timestamps and 9/10 share a branch)
expect_backup "BACKUP_TARGET=staging backup test-scratch accepted" test-scratch BACKUP_TARGET=staging -- backup test-scratch
sleep 1
expect_backup "BACKUP_TARGET=production backup test-scratch accepted" test-scratch BACKUP_TARGET=production -- backup test-scratch

# 11. Control: omitted branch with the staging target keeps the staging default.
sleep 1
expect_backup "BACKUP_TARGET=staging backup (omitted branch) accepted" staging BACKUP_TARGET=staging -- backup

# 12-13. Controls: BACKUP_TARGET unset leaves behavior unchanged, including
# the restore-proof's non-target `synthetic` branch.
sleep 1
expect_backup "BACKUP_TARGET unset backup staging unchanged" staging -u BACKUP_TARGET -- backup staging
expect_backup "BACKUP_TARGET unset backup synthetic unchanged" synthetic -u BACKUP_TARGET -- backup synthetic

echo "branch-target-selftest: $PASS passed"
