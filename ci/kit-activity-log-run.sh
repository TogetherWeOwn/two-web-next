#!/usr/bin/env bash
set -euo pipefail
[[ "$GITHUB_ACTIONS" == true && "$RUNNER_OS" == Linux ]]
scratch="$RUNNER_TEMP/kit-activity-log"
mkdir -m 700 -- "$scratch"
server=
browser=
cleanup() {
  local pid
  for pid in "$browser" "$server"; do
    [[ -n "$pid" ]] || continue
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL -- "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export HOME="$scratch/home" TMPDIR="$scratch" PLAYWRIGHT_BROWSERS_PATH="$scratch/browsers"
export CI=true WRANGLER_SEND_METRICS=false
export DATABASE_URL=postgres://agent_test@127.0.0.1:5432/two_web_next
mkdir -- "$HOME" "$scratch/screenshots"
cd "$GITHUB_WORKSPACE/app"
quiet() {
  local label=$1
  shift
  if ! "$@" >/dev/null 2>&1; then
    printf '::error::Fixture step failed: %s\n' "$label"
    exit 1
  fi
}
quiet 'isolation and exact dispatcher overlay' node --input-type=module - <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { requireGithubRunner, requireTestDatabase } from "./e2e/ci-only.mjs";
const { activityLogFixtureSource } = await import(`${process.env.GITHUB_WORKSPACE}/harness/ci/kit-activity-log-overlay.mjs`);
requireGithubRunner();
requireTestDatabase(process.env.DATABASE_URL);
const path = "src/route-ownership.ts";
writeFileSync(path, activityLogFixtureSource(readFileSync(path, "utf8")));
JS
quiet 'root dependencies' npm ci --include=dev --ignore-scripts --min-release-age=3 --no-audit --no-fund
quiet 'Kit dependencies' npm ci --prefix web --include=dev --ignore-scripts --min-release-age=3 --no-audit --no-fund
quiet 'disposable database roles' psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ci/disposable-runtime-role.sql
quiet 'disposable database migrations' npm run db:migrate
quiet 'disposable read observer' psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION pg_stat_statements'
quiet 'journey fixture seed' node e2e/seed.mjs
quiet 'Chromium' ./node_modules/.bin/playwright install --with-deps chromium
quiet 'Kit Worker build' npm run build --prefix web
cp -- "$GITHUB_WORKSPACE/harness/ci/kit-activity-log-"{assert,metrics,png,visual}.mjs ci/

setsid node ci/kit-worker-dev.mjs </dev/null >/dev/null 2>&1 &
server=$!
deadline=$((SECONDS + 60))
until [[ $(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/favicon.ico) == 200 ]]; do
  if (( SECONDS >= deadline )) || ! kill -0 "$server" 2>/dev/null; then
    printf '::error::Kit Worker readiness failed\n'
    exit 1
  fi
  sleep 1
done
printf 'Kit Worker ready on the fixture origin\n'
# Only GNU timeout's own diagnostics reach this file, never the child streams.
LC_ALL=C timeout --verbose -k 5s 150s bash -c 'exec node ci/kit-activity-log-assert.mjs >/dev/null 2>&1' \
  </dev/null >/dev/null 2>"$scratch/watchdog.txt" &
browser=$!
result=0
wait "$browser" 2>/dev/null || result=$?
browser=
stage=UNKNOWN
raw=
# A successful read would mean a NUL or the size cap; only exact, newline-terminated codes at EOF count.
if [[ -f "$scratch/browser-stage" && ! -L "$scratch/browser-stage" ]] &&
  ! IFS= read -r -d '' -n 32 raw < "$scratch/browser-stage"; then
  case "$raw" in
    $'FIXTURE\n'|$'LAUNCH\n'|$'MODERATOR\n'|$'REFUSALS\n'|$'PAGINATION_FILTERS\n'|$'CAPTURE\n'|\
    $'FONTS\n'|$'AXE_INJECT\n'|$'AXE_EVALUATE\n'|$'LIGHTHOUSE\n'|$'TEARDOWN\n'|$'COMPLETE\n') stage=${raw%$'\n'} ;;
  esac
fi
outcome=UNKNOWN
# 137 by itself is ambiguous: the watchdog's TERM marker also survives KILL escalation.
if [[ $result == 124 || $result == 137 ]] &&
  grep -Fxq "timeout: sending signal TERM to command 'bash'" "$scratch/watchdog.txt"; then
  outcome=WATCHDOG
elif [[ $stage == COMPLETE && $result == 0 ]]; then
  outcome=PASS
elif [[ $stage != UNKNOWN && $stage != COMPLETE ]]; then
  case "$result" in
    20) outcome=ASSERTION ;;
    21) outcome=DEADLINE ;;
    22) outcome=ERROR ;;
  esac
fi
printf 'Activity-log browser: outcome=%s stage=%s\n' "$outcome" "$stage"
if [[ -f "$scratch/metrics.txt" ]]; then
  pattern='((populated|empty)-desktop\.png a11y: (PASS|FAIL) violations=[0-9]+ incomplete=[0-9]+|populated-desktop\.png lighthouse: (unavailable|report-only total_bytes=[0-9]+ fcp_ms=[0-9]+))'
  ! grep -qEvx "$pattern" "$scratch/metrics.txt" || exit 1
  grep -Ex "$pattern" "$scratch/metrics.txt"
fi
[[ $outcome == PASS ]] || exit 1
[[ $(wc -l < "$scratch/metrics.txt") == 3 ]]
printf 'PASS: Activity-log fixture, rendered states and route a11y\n'
mv -T -- "$scratch/screenshots" "$RUNNER_TEMP/kit-activity-log-approved"
