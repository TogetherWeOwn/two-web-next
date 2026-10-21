#!/usr/bin/env bash
#
# Failing-first acceptance suite for the retention-plan contract of
# bin/db-backup.sh `rotate`: the preview must BE the execution plan, not a
# sketch of it.
#
# Pinned contract (the implementation makes this suite green):
#
# - One deterministic plan: daily/weekly archives sorted ascending, newest
#   BACKUP_KEEP_DAILY dailies + newest BACKUP_KEEP_WEEKLY weeklies kept, the
#   rest deleted. Preview and apply compute the same plan: the apply deletes
#   exactly the preview's delete set, nothing else.
# - Stable archive-key IDs: manifest archive key strings. keep + delete are
#   disjoint and cover every manifest archive. Receipt lines are never printed
#   as keep:/delete: entries; manifest-registered receipts are deleted or
#   retained with their archive, legacy archives without a receipt line are
#   deleted without inventing a receipt.
# - Validation before storage: unset or empty BACKUP_KEEP_DAILY/WEEKLY means
#   the documented defaults (7/4). Any other value must be a canonical decimal
#   integer (^[1-9][0-9]*$, no leading zeros, sign, whitespace or decimals)
#   within daily 1..365 / weekly 1..52. Anything else exits 2 with usage that
#   names the variable, before any storage call. Supported bounds are
#   documented in docs/backup-integrity.md and the script header.
# - Argv: repeated positional branch tokens, duplicate flags and contradictory
#   flags (--apply with --dry-run) exit 2 with usage before any storage call.
#   --apply and --json are rotate-only, like --dry-run already is.
# - Safe plan/apply: bare `rotate [branch]` is a nonmutating preview (exit 0,
#   zero object deletes, zero manifest rewrite). --dry-run is an explicit
#   preview alias with identical output. Only --apply deletes, and only the
#   planned targets. apply is idempotent: re-running after a partial failure
#   converges instead of failing on already-deleted objects.
# - JSON: --json emits one byte-stable JSON document (identical bytes across
#   runs) with version 1, a stable code (retention.plan.preview /
#   retention.plan.applied / retention.plan.partial_failure), mode, branch,
#   policy {keepDaily, keepWeekly}, sorted keep[]/delete[] matching the text
#   plan, actions[] ({op:"delete", key, receipt or null}) sorted by key, and a
#   safe nextAction (preview names --apply; applied names check; partial names
#   the failed keys plus a re-run/retry).
# - Partial failure is truthful: exit non-zero, completed deletes stay deleted,
#   the manifest is unchanged, the report names completed vs failed keys, and
#   nothing claims rollback, restore or success.
# - Preserved: default 7/4 policy, manifest admission before mutation, EU
#   jurisdiction on every R2 call, no DATABASE_URL requirement for rotate.
# - The authorized workflow caller passes --apply explicitly so a preview can
#   never masquerade as a successful rotation.
#
# Hermetic: stub wrangler against a local directory, fixed fixture keys, no
# pg_dump, no network, no database, no credentials. Every `ok:` line is one
# passing assertion; exits non-zero on the first failure. ONLY=<section>
# runs a single section (default_preview agreement empty exact_limit mixtures
# json validation argv workflow docs partial guards); default ONLY=all.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ONLY="${ONLY:-all}"

PASS=0
ok() { PASS=$((PASS + 1)); echo "ok: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export STUB_R2="$T/r2"
mkdir -p "$STUB_R2"
export CALL_LOG="$T/calls.log"
: > "$CALL_LOG"

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
    if [ -n "${FAIL_DELETE_MATCH:-}" ]; then
      case "$path" in
        *"$FAIL_DELETE_MATCH"*) echo "stub: injected delete failure: $path" >&2; exit 1 ;;
      esac
    fi
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

BIN="./bin/db-backup.sh"
MANIFEST="neon/staging-staging/MANIFEST.txt"

daily_key() { printf 'neon/staging-staging-202501%02dT000000Z.dump\n' "$1"; }
weekly_key() { printf 'neon/staging-staging-202401%02dT000000Z-weekly-202401%02dT000000Z.dump\n' "$1" "$1"; }

reset_store() {
  rm -rf "$STUB_R2"
  mkdir -p "$STUB_R2"
  : > "$CALL_LOG"
}

# seed_store <dailies> <weeklies> <daily-without-receipt-csv> <weekly-without-receipt-csv>
seed_store() {
  local dailies="$1" weeklies="$2" no_d="${3:-}" no_w="${4:-}" i k
  : > "$T/seed-manifest.txt"
  i=1
  while [ "$i" -le "$dailies" ]; do
    k="$(daily_key "$i")"
    printf 'archive-bytes %s\n' "$k" > "$T/blob"
    "$WRANGLER_BIN" r2 object put "test-bucket/$k" --file "$T/blob" --remote >/dev/null
    printf '%s\n' "$k" >> "$T/seed-manifest.txt"
    case ",$no_d," in *,"$i",*) ;; *)
      printf '{"receipt":true}\n' > "$T/blob"
      "$WRANGLER_BIN" r2 object put "test-bucket/$k.digest.json" --file "$T/blob" --remote >/dev/null
      printf '%s\n' "$k.digest.json" >> "$T/seed-manifest.txt" ;;
    esac
    i=$((i + 1))
  done
  i=1
  while [ "$i" -le "$weeklies" ]; do
    k="$(weekly_key "$i")"
    printf 'archive-bytes %s\n' "$k" > "$T/blob"
    "$WRANGLER_BIN" r2 object put "test-bucket/$k" --file "$T/blob" --remote >/dev/null
    printf '%s\n' "$k" >> "$T/seed-manifest.txt"
    case ",$no_w," in *,"$i",*) ;; *)
      printf '{"receipt":true}\n' > "$T/blob"
      "$WRANGLER_BIN" r2 object put "test-bucket/$k.digest.json" --file "$T/blob" --remote >/dev/null
      printf '%s\n' "$k.digest.json" >> "$T/seed-manifest.txt" ;;
    esac
    i=$((i + 1))
  done
  sort -o "$T/seed-manifest.txt" "$T/seed-manifest.txt"
  "$WRANGLER_BIN" r2 object put "test-bucket/$MANIFEST" --file "$T/seed-manifest.txt" --remote >/dev/null
  : > "$CALL_LOG"
}

snap_bucket() {
  python3 - "$STUB_R2" > "$1" <<'PY'
import hashlib, pathlib, sys
root = pathlib.Path(sys.argv[1])
for path in sorted(root.rglob("*")):
    if path.is_file():
        print(path.relative_to(root), hashlib.sha256(path.read_bytes()).hexdigest())
PY
}

# text_sets <output-file>: split delete:/keep: lines into sorted $T/sets.* files.
text_sets() {
  grep '^delete: ' "$1" | sed 's/^delete: //' | sort > "$T/sets.delete" || true
  grep '^keep: ' "$1" | sed 's/^keep: //' | sort > "$T/sets.keep" || true
}

manifest_archives() {
  grep -E '\.dump$' "$1" | sort || true
}

delete_ops() {
  grep -c ' object delete' "$CALL_LOG" || true
}

s_default_preview() {
  # Bare rotate is a nonmutating preview printing the exact disjoint plan.
  reset_store
  seed_store 9 6 "" ""
  cp "$STUB_R2/$MANIFEST" "$T/manifest-before"
  snap_bucket "$T/bucket-before"
  local rc=0
  "$BIN" rotate staging >"$T/out" 2>"$T/err" || rc=$?
  [ "$rc" = 0 ] || fail "bare rotate preview exits 0 (rc=$rc): $(cat "$T/err")"
  ok "bare rotate exits 0"
  text_sets "$T/out"
  { daily_key 1; daily_key 2; weekly_key 1; weekly_key 2; } | sort > "$T/expected.delete"
  diff -u "$T/expected.delete" "$T/sets.delete" || fail "preview delete set must be exactly the 4 expired archives"
  ok "preview deletes exactly the expired archives"
  { daily_key 3; daily_key 4; daily_key 5; daily_key 6; daily_key 7; daily_key 8; daily_key 9; weekly_key 3; weekly_key 4; weekly_key 5; weekly_key 6; } | sort > "$T/expected.keep"
  diff -u "$T/expected.keep" "$T/sets.keep" || fail "preview keep set must be exactly the retained archives (disjoint from delete)"
  ok "preview keep set is exactly the retained archives"
  grep -q 'digest\.json' "$T/out" && fail "preview must never list receipt lines" || true
  ok "preview lists archives only, never receipts"
  [ "$(delete_ops)" = 0 ] || fail "preview ran object deletes: $(cat "$CALL_LOG")"
  ok "preview runs zero object deletes"
  cmp "$T/manifest-before" "$STUB_R2/$MANIFEST" || fail "preview rewrote the manifest"
  ok "preview leaves the manifest byte-identical"
  snap_bucket "$T/bucket-after"
  cmp "$T/bucket-before" "$T/bucket-after" || fail "preview mutated bucket objects"
  ok "preview leaves every bucket object untouched"
  "$BIN" rotate staging --dry-run >"$T/out-dry" 2>"$T/err-dry" || fail "rotate --dry-run exits 0"
  cmp "$T/out" "$T/out-dry" || fail "--dry-run output differs from the default preview"
  ok "--dry-run is an identical explicit preview"
}

s_agreement() {
  # Apply deletes exactly the preview's delete set; manifest and objects agree.
  reset_store
  seed_store 9 6 "" ""
  "$BIN" rotate staging >"$T/preview" 2>"$T/err" || fail "preview exits 0"
  text_sets "$T/preview"
  cp "$T/sets.delete" "$T/plan.delete"
  cp "$T/sets.keep" "$T/plan.keep"
  local rc=0
  "$BIN" rotate staging --apply >"$T/applied" 2>"$T/err" || rc=$?
  [ "$rc" = 0 ] || fail "rotate --apply exits 0 (rc=$rc): $(cat "$T/err")"
  ok "explicit --apply exits 0"
  text_sets "$T/applied"
  diff -u "$T/plan.delete" "$T/sets.delete" || fail "apply deleted a different set than the preview planned"
  ok "apply deletes exactly the preview's delete set"
  "$WRANGLER_BIN" r2 object get "test-bucket/$MANIFEST" --file "$T/m-after" --remote >/dev/null
  manifest_archives "$T/m-after" > "$T/m-after.archives"
  diff -u "$T/plan.keep" "$T/m-after.archives" || fail "post-apply manifest archives differ from the preview keep set"
  ok "post-apply manifest keeps exactly the planned archives"
  python3 - "$T/m-after" <<'PY' || fail "post-apply manifest must pair every archive with its registered receipt"
import pathlib, sys
lines = set(pathlib.Path(sys.argv[1]).read_text().splitlines())
archives = {line for line in lines if line.endswith(".dump")}
assert lines == archives | {key + ".digest.json" for key in archives}, sorted(lines ^ (archives | {key + ".digest.json" for key in archives}))
PY
  ok "post-apply manifest pairs every archive with its receipt"
  snap_bucket "$T/bucket-after"
  python3 - "$STUB_R2" "$T/m-after" <<'PY' || fail "bucket objects must equal manifest lines after apply"
import pathlib, sys
root, manifest = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
objects = {str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()}
assert objects == set(manifest.read_text().splitlines()) | {"neon/staging-staging/MANIFEST.txt"}, sorted(objects)
PY
  ok "bucket objects equal manifest lines after apply"
  "$BIN" rotate staging >"$T/preview2" 2>"$T/err" || fail "post-apply preview exits 0"
  [ "$(grep -c '^delete: ' "$T/preview2" || true)" = 0 ] || fail "post-apply preview must plan zero deletes"
  ok "plan converges: preview after apply deletes nothing"
}

s_empty() {
  # Empty inventory: preview and apply are zero-delete no-ops.
  reset_store
  seed_store 0 0 "" ""
  cp "$STUB_R2/$MANIFEST" "$T/manifest-before"
  "$BIN" rotate staging >"$T/out" 2>"$T/err" || fail "empty preview exits 0"
  [ "$(grep -c '^delete: ' "$T/out" || true)" = 0 ] || fail "empty preview must plan zero deletes"
  ok "empty preview plans zero deletes"
  local rc=0
  "$BIN" rotate staging --apply >"$T/applied" 2>"$T/err" || rc=$?
  [ "$rc" = 0 ] || fail "empty --apply exits 0 (rc=$rc): $(cat "$T/err")"
  ok "empty --apply exits 0"
  cmp "$T/manifest-before" "$STUB_R2/$MANIFEST" || fail "empty apply rewrote the manifest"
  ok "empty apply leaves the manifest byte-identical"
}

s_exact_limit() {
  # Exactly at the retention limit: everything kept, apply rewrites nothing.
  reset_store
  seed_store 7 4 "" ""
  cp "$STUB_R2/$MANIFEST" "$T/manifest-before"
  "$BIN" rotate staging >"$T/out" 2>"$T/err" || fail "exact-limit preview exits 0"
  [ "$(grep -c '^delete: ' "$T/out" || true)" = 0 ] || fail "exact-limit preview must plan zero deletes"
  [ "$(grep -c '^keep: ' "$T/out" || true)" = 11 ] || fail "exact-limit preview must keep all 11 archives"
  ok "exact-limit preview keeps all 11 archives"
  local rc=0
  "$BIN" rotate staging --apply >"$T/applied" 2>"$T/err" || rc=$?
  [ "$rc" = 0 ] || fail "exact-limit --apply exits 0 (rc=$rc): $(cat "$T/err")"
  cmp "$T/manifest-before" "$STUB_R2/$MANIFEST" || fail "exact-limit apply rewrote the manifest"
  ok "exact-limit apply leaves the manifest byte-identical"
}

s_mixtures() {
  # Registered receipts pair with their archive; legacy archives pair with nothing.
  reset_store
  seed_store 9 6 "1,5" "2"
  "$BIN" rotate staging >"$T/preview" 2>"$T/err" || fail "mixture preview exits 0"
  text_sets "$T/preview"
  { daily_key 1; daily_key 2; weekly_key 1; weekly_key 2; } | sort > "$T/expected.delete"
  diff -u "$T/expected.delete" "$T/sets.delete" || fail "mixture delete set must be exactly the 4 expired archives"
  ok "mixture preview deletes exactly the expired archives"
  local rc=0
  "$BIN" rotate staging --apply >"$T/applied" 2>"$T/err" || rc=$?
  [ "$rc" = 0 ] || fail "mixture --apply exits 0 (rc=$rc): $(cat "$T/err")"
  "$WRANGLER_BIN" r2 object get "test-bucket/$MANIFEST" --file "$T/m-after" --remote >/dev/null
  python3 - "$T/m-after" <<'PY' || fail "post-apply manifest must pair retained archives with registered receipts only"
import pathlib, sys
lines = set(pathlib.Path(sys.argv[1]).read_text().splitlines())
archives = {line for line in lines if line.endswith(".dump")}
assert sum("-weekly-" not in key for key in archives) == 7, sorted(archives)
assert sum("-weekly-" in key for key in archives) == 4, sorted(archives)
receipts = {line for line in lines if line.endswith(".digest.json")}
# One retained archive is legacy (d5; deleted legacies are d1 and w2);
# every other retained archive keeps exactly its registered receipt.
assert len(receipts) == 10, sorted(receipts)
for receipt in receipts:
    assert receipt[:-len(".digest.json")] in archives, receipt
PY
  ok "mixture apply retains 7/4 with registered receipts and no invented ones"
  [ -e "$STUB_R2/$(daily_key 1).digest.json" ] && fail "apply invented a receipt for legacy delete $(daily_key 1)" || true
  [ -e "$STUB_R2/$(daily_key 5).digest.json" ] && fail "apply invented a receipt for legacy kept $(daily_key 5)" || true
  [ -f "$STUB_R2/$(daily_key 5)" ] || fail "legacy retained archive was removed"
  ok "legacy archives keep their lifecycle without invented receipts"
}

s_json() {
  # Byte-stable machine plan matching the text plan, for preview and apply.
  reset_store
  seed_store 9 6 "" ""
  "$BIN" rotate staging >"$T/text" 2>"$T/err" || fail "text preview exits 0"
  text_sets "$T/text"
  local rc=0
  "$BIN" rotate staging --json >"$T/plan1.json" 2>"$T/err" || rc=$?
  [ "$rc" = 0 ] || fail "preview --json exits 0 (rc=$rc): $(cat "$T/err")"
  ok "preview --json exits 0"
  "$BIN" rotate staging --json >"$T/plan2.json" 2>/dev/null || fail "second preview --json exits 0"
  cmp "$T/plan1.json" "$T/plan2.json" || fail "preview JSON is not byte-stable across runs"
  ok "preview JSON is byte-stable across runs"
  python3 - "$T/plan1.json" "$T/sets.delete" "$T/sets.keep" <<'PY' || fail "preview JSON must carry the versioned plan matching the text output"
import json, pathlib, sys
plan_doc, delete_doc, keep_doc = (pathlib.Path(arg).read_text() for arg in sys.argv[1:4])
plan = json.loads(plan_doc)
assert plan["version"] == 1, plan
assert plan["code"] == "retention.plan.preview", plan
assert plan["mode"] == "preview", plan
assert plan["branch"] == "staging", plan
assert plan["policy"] == {"keepDaily": 7, "keepWeekly": 4}, plan
assert plan["delete"] == sorted(delete_doc.split()), plan["delete"]
assert plan["keep"] == sorted(keep_doc.split()), plan["keep"]
assert not (set(plan["keep"]) & set(plan["delete"])), plan
actions = plan["actions"]
assert [action["key"] for action in actions] == sorted(plan["delete"]), actions
for action in actions:
    assert action["op"] == "delete", action
    assert action["receipt"] == action["key"] + ".digest.json", action
assert "--apply" in plan["nextAction"], plan
PY
  ok "preview JSON carries the versioned plan with actions and next action"
  "$BIN" rotate staging --dry-run --json >"$T/plan-dry.json" 2>/dev/null || fail "--dry-run --json exits 0"
  cmp "$T/plan1.json" "$T/plan-dry.json" || fail "--dry-run --json differs from the default preview JSON"
  ok "--dry-run --json matches the default preview JSON"
  BACKUP_KEEP_DAILY=2 "$BIN" rotate staging --json >"$T/plan-custom.json" 2>/dev/null || fail "custom-policy --json exits 0"
  python3 - "$T/plan-custom.json" <<'PY' || fail "JSON must reflect a custom retention policy"
import json, pathlib, sys
plan = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert plan["policy"] == {"keepDaily": 2, "keepWeekly": 4}, plan
assert len(plan["delete"]) == 9, plan["delete"]
PY
  ok "JSON reflects a custom retention policy"
  "$BIN" rotate staging --apply --json >"$T/applied.json" 2>"$T/err" || fail "apply --json exits 0"
  python3 - "$T/applied.json" "$T/plan1.json" <<'PY' || fail "apply JSON must report the applied plan with a safe next action"
import json, pathlib, sys
applied = json.loads(pathlib.Path(sys.argv[1]).read_text())
preview = json.loads(pathlib.Path(sys.argv[2]).read_text())
assert applied["version"] == 1, applied
assert applied["code"] == "retention.plan.applied", applied
assert applied["mode"] == "apply", applied
assert applied["delete"] == preview["delete"], applied
assert applied["keep"] == preview["keep"], applied
assert applied["nextAction"], applied
assert "check" in applied["nextAction"], applied
PY
  ok "apply JSON reports the applied plan with a safe next action"
}

s_validation() {
  # Retention counts are validated before any storage call.
  reset_store
  seed_store 9 6 "" ""
  cp "$STUB_R2/$MANIFEST" "$T/manifest-before"
  snap_bucket "$T/bucket-before"
  expect_reject() {
    local desc="$1" var="$2" value="$3"
    : > "$CALL_LOG"
    local rc=0
    env "$var=$value" "$BIN" rotate staging >"$T/out" 2>"$T/err" || rc=$?
    [ "$rc" = 2 ] || fail "$desc: exits 2 with usage (rc=$rc): $(cat "$T/err")"
    grep -q 'usage:' "$T/err" || fail "$desc: stderr must print usage: $(cat "$T/err")"
    grep -q "$var" "$T/err" || fail "$desc: stderr must name $var: $(cat "$T/err")"
    [ ! -s "$CALL_LOG" ] || fail "$desc: storage calls before validation: $(cat "$CALL_LOG")"
    cmp "$T/manifest-before" "$STUB_R2/$MANIFEST" || fail "$desc: manifest mutated"
    snap_bucket "$T/bucket-after"
    cmp "$T/bucket-before" "$T/bucket-after" || fail "$desc: bucket mutated"
    ok "$desc rejected before storage calls"
  }
  expect_reject "daily=abc" BACKUP_KEEP_DAILY "abc"
  expect_reject "daily=-1" BACKUP_KEEP_DAILY "-1"
  expect_reject "daily=0" BACKUP_KEEP_DAILY "0"
  expect_reject "daily=7.5" BACKUP_KEEP_DAILY "7.5"
  expect_reject "daily=' 7'" BACKUP_KEEP_DAILY " 7"
  expect_reject "daily='7 '" BACKUP_KEEP_DAILY "7 "
  expect_reject "daily=+7" BACKUP_KEEP_DAILY "+7"
  expect_reject "daily=0x7" BACKUP_KEEP_DAILY "0x7"
  expect_reject "daily=007" BACKUP_KEEP_DAILY "007"
  expect_reject "daily=366" BACKUP_KEEP_DAILY "366"
  expect_reject "daily=overflow" BACKUP_KEEP_DAILY "99999999999999999999999"
  expect_reject "weekly=xyz" BACKUP_KEEP_WEEKLY "xyz"
  expect_reject "weekly=0" BACKUP_KEEP_WEEKLY "0"
  expect_reject "weekly=-2" BACKUP_KEEP_WEEKLY "-2"
  expect_reject "weekly=53" BACKUP_KEEP_WEEKLY "53"
  expect_reject "weekly=007" BACKUP_KEEP_WEEKLY "007"
  # Valid policies keep working: defaults, and the documented bounds edges.
  deletes_for() {
    env "$@" "$BIN" rotate staging 2>/dev/null | grep -c '^delete: ' || true
  }
  [ "$(env -u BACKUP_KEEP_DAILY -u BACKUP_KEEP_WEEKLY "$BIN" rotate staging 2>/dev/null | grep -c '^delete: ' || true)" = 4 ] || fail "unset policy must default to 7/4 (4 deletes)"
  ok "unset policy defaults to 7/4"
  [ "$(deletes_for BACKUP_KEEP_DAILY= BACKUP_KEEP_WEEKLY=)" = 4 ] || fail "empty policy must default to 7/4 (4 deletes)"
  ok "empty policy defaults to 7/4"
  [ "$(deletes_for BACKUP_KEEP_DAILY=1 BACKUP_KEEP_WEEKLY=1)" = 13 ] || fail "policy 1/1 must delete 13 archives"
  ok "policy 1/1 deletes down to one daily plus one weekly"
  [ "$(deletes_for BACKUP_KEEP_DAILY=365 BACKUP_KEEP_WEEKLY=52)" = 0 ] || fail "policy 365/52 must keep the whole fixture"
  ok "policy 365/52 keeps the whole fixture"
}

s_argv() {
  # Duplicate or contradictory inputs are rejected before any storage call,
  # with DATABASE_URL unset to prove flag rejection precedes connection work.
  reset_store
  seed_store 9 6 "" ""
  cp "$STUB_R2/$MANIFEST" "$T/manifest-before"
  snap_bucket "$T/bucket-before"
  expect_reject() {
    local desc="$1" pattern="$2"
    shift 2
    : > "$CALL_LOG"
    local rc=0
    env -u DATABASE_URL "$BIN" "$@" >"$T/out" 2>"$T/err" || rc=$?
    [ "$rc" = 2 ] || fail "$desc: exits 2 with usage (rc=$rc): $(cat "$T/err")"
    grep -q 'usage:' "$T/err" || fail "$desc: stderr must print usage: $(cat "$T/err")"
    grep -qE -- "$pattern" "$T/err" || fail "$desc: stderr must match $pattern: $(cat "$T/err")"
    [ ! -s "$CALL_LOG" ] || fail "$desc: storage calls before rejection: $(cat "$CALL_LOG")"
    cmp "$T/manifest-before" "$STUB_R2/$MANIFEST" || fail "$desc: manifest mutated"
    snap_bucket "$T/bucket-after"
    cmp "$T/bucket-before" "$T/bucket-after" || fail "$desc: bucket mutated"
    ok "$desc rejected before storage calls"
  }
  expect_reject "duplicate branch" 'duplicat|repeated|twice' rotate staging staging
  expect_reject "two branches" 'duplicat|repeated|twice' rotate staging production
  expect_reject "duplicate --dry-run" 'duplicat' rotate staging --dry-run --dry-run
  expect_reject "duplicate --apply" 'duplicat' rotate staging --apply --apply
  expect_reject "duplicate --json" 'duplicat' rotate staging --json --json
  expect_reject "contradictory apply+dry-run" 'contradict|exclusive|together|combine' rotate staging --apply --dry-run
  expect_reject "contradictory dry-run+apply" 'contradict|exclusive|together|combine' rotate staging --dry-run --apply
  expect_reject "backup --apply" --apply backup staging --apply
  expect_reject "check --apply" --apply check staging --apply
  expect_reject "promote-weekly --json" --json promote-weekly staging --json
  env -u DATABASE_URL "$BIN" rotate staging --dry-run >"$T/out" 2>"$T/err" || fail "rotate --dry-run stays valid without DATABASE_URL"
  ok "rotate --dry-run stays valid without DATABASE_URL"
}

s_workflow() {
  # The authorized scheduled caller applies explicitly; a preview can never
  # masquerade as a successful rotation.
  grep -q 'db-backup\.sh rotate "\$BRANCH" --apply' .github/workflows/db-backup.yml \
    || fail "workflow must invoke rotate with --apply"
  ok "workflow invokes rotate with --apply"
  grep -qE 'db-backup\.sh rotate "\$BRANCH"$' .github/workflows/db-backup.yml \
    && fail "workflow still contains a bare rotate call" || true
  ok "workflow contains no bare rotate call"
}

s_docs() {
  # Supported policy bounds are documented; defaults are preserved.
  grep -q '1\.\.365' docs/backup-integrity.md || fail "docs must state the daily bound 1..365"
  ok "docs state the daily bound 1..365"
  grep -q '1\.\.52' docs/backup-integrity.md || fail "docs must state the weekly bound 1..52"
  ok "docs state the weekly bound 1..52"
  grep -q '365' bin/db-backup.sh || fail "script header must document the policy bounds"
  ok "script header documents the policy bounds"
  grep -q 'BACKUP_KEEP_DAILY:=7' bin/db-backup.sh || fail "default daily retention must stay 7"
  grep -q 'BACKUP_KEEP_WEEKLY:=4' bin/db-backup.sh || fail "default weekly retention must stay 4"
  ok "default 7/4 policy is preserved"
}

s_partial() {
  # A failed paired delete is reported truthfully: completed work stays done,
  # the manifest is unchanged, and nothing claims rollback or success.
  reset_store
  seed_store 9 4 "" ""
  cp "$STUB_R2/$MANIFEST" "$T/manifest-before"
  local d1 d2
  d1="$(daily_key 1)"
  d2="$(daily_key 2)"
  local rc=0
  FAIL_DELETE_MATCH="20250102T000000Z.dump" "$BIN" rotate staging --apply >"$T/out" 2>"$T/err" || rc=$?
  [ "$rc" != 0 ] || fail "partial apply must exit non-zero"
  ok "partial apply exits non-zero"
  grep -qF "delete: $d1" "$T/out" || fail "partial apply must report the completed delete $d1"
  ok "partial apply reports the completed delete"
  grep -qF "$d2" "$T/out" "$T/err" || fail "partial apply must name the failed key $d2"
  grep -qiE 'fail' "$T/out" "$T/err" || fail "partial apply must describe the failure"
  ok "partial apply names the failed key"
  [ -e "$STUB_R2/$d1" ] && fail "completed delete $d1 was rolled back" || true
  [ -e "$STUB_R2/$d1.digest.json" ] && fail "completed receipt delete was rolled back" || true
  [ -f "$STUB_R2/$d2" ] || fail "failed archive $d2 is missing"
  [ -f "$STUB_R2/$d2.digest.json" ] || fail "failed receipt $d2.digest.json is missing"
  ok "completed deletes stay deleted; failed pair stays intact"
  cmp "$T/manifest-before" "$STUB_R2/$MANIFEST" || fail "partial apply rewrote the manifest"
  ok "partial apply leaves the manifest unchanged"
  grep -qiE 'rollback|restor|success' "$T/out" "$T/err" && fail "partial apply claims rollback, restore or success" || true
  ok "partial apply claims no rollback, restore or success"
  "$BIN" rotate staging --apply >"$T/retry" 2>"$T/retry-err" || fail "retrying apply must converge (rc=$?): $(cat "$T/retry-err")"
  "$WRANGLER_BIN" r2 object get "test-bucket/$MANIFEST" --file "$T/m-after" --remote >/dev/null
  [ "$(grep -E '\.dump$' "$T/m-after" | grep -vc '\-weekly\-' || true)" = 7 ] || fail "retried manifest must hold 7 dailies"
  [ "$(grep -cE '\-weekly\-.*\.dump$' "$T/m-after" || true)" = 4 ] || fail "retried manifest must hold 4 weeklies"
  ok "retrying apply converges to 7 dailies + 4 weeklies"
  # The same truthfulness holds for the machine-readable plan.
  reset_store
  seed_store 9 4 "" ""
  cp "$STUB_R2/$MANIFEST" "$T/manifest-before"
  rc=0
  FAIL_DELETE_MATCH="20250102T000000Z.dump" "$BIN" rotate staging --apply --json >"$T/partial.json" 2>"$T/err" || rc=$?
  [ "$rc" != 0 ] || fail "partial apply --json must exit non-zero"
  python3 - "$T/partial.json" <<PY || fail "partial JSON must report completed vs failed with a safe next action"
import json, pathlib, sys
partial = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert partial["code"] == "retention.plan.partial_failure", partial
assert partial["mode"] == "apply", partial
assert partial["completed"] == ["$d1"], partial
assert partial["failed"] == ["$d2"], partial
assert "$d2" in partial["nextAction"], partial
assert "re-run" in partial["nextAction"] or "retry" in partial["nextAction"], partial
PY
  ok "partial JSON reports completed vs failed with a safe next action"
  cmp "$T/manifest-before" "$STUB_R2/$MANIFEST" || fail "partial JSON apply rewrote the manifest"
  ok "partial JSON apply leaves the manifest unchanged"
}

s_guards() {
  # Guards the plan change must not weaken.
  grep -q 'BACKUP_KEEP_DAILY:=7' bin/db-backup.sh || fail "default daily retention must stay 7"
  grep -q 'BACKUP_KEEP_WEEKLY:=4' bin/db-backup.sh || fail "default weekly retention must stay 4"
  ok "default 7/4 policy is preserved"
  local unwired
  unwired="$(grep 'wr r2 object' bin/db-backup.sh | grep -vc 'BACKUP_JURISDICTION' || true)"
  [ "$unwired" = 0 ] || fail "$unwired r2 object call(s) lack --jurisdiction"
  ok "every r2 object call passes --jurisdiction"
  reset_store
  seed_store 9 6 "" ""
  env -u DATABASE_URL "$BIN" rotate staging >"$T/out" 2>"$T/err" || fail "rotate preview must not require DATABASE_URL"
  ok "rotate preview needs no DATABASE_URL"
  printf 'not-a-valid-manifest-line\n' > "$T/bad-manifest.txt"
  "$WRANGLER_BIN" r2 object put "test-bucket/$MANIFEST" --file "$T/bad-manifest.txt" --remote >/dev/null
  : > "$CALL_LOG"
  local rc=0
  "$BIN" rotate staging >"$T/out" 2>"$T/err" || rc=$?
  [ "$rc" != 0 ] || fail "malformed manifest must refuse the preview"
  [ "$(delete_ops)" = 0 ] || fail "malformed manifest preview ran deletes"
  ok "malformed manifest refuses before any delete"
}

should_run() { [ "$ONLY" = "all" ] || [ "$ONLY" = "$1" ]; }

should_run default_preview && s_default_preview
should_run agreement && s_agreement
should_run empty && s_empty
should_run exact_limit && s_exact_limit
should_run mixtures && s_mixtures
should_run json && s_json
should_run validation && s_validation
should_run argv && s_argv
should_run workflow && s_workflow
should_run docs && s_docs
should_run partial && s_partial
should_run guards && s_guards

echo "retention-plan-selftest: $PASS passed"
