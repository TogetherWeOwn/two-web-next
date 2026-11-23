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
browser_started=$SECONDS
LC_ALL=C timeout --verbose -k 5s 150s bash -c 'exec node ci/kit-activity-log-assert.mjs >/dev/null 2>&1' \
  </dev/null >/dev/null 2>"$scratch/watchdog.txt" &
browser=$!
result=0
wait "$browser" 2>/dev/null || result=$?
browser=
stage=UNKNOWN viewport=NONE operation=NONE outcome=UNKNOWN raw=
elapsed=$((SECONDS - browser_started))
(( elapsed >= 0 && elapsed <= 999 )) || elapsed=unknown
# A successful read would mean a NUL or the size cap. Admit fixed tokens and one final newline.
general='(FIXTURE|LAUNCH|MODERATOR|REFUSALS|PAGINATION_FILTERS|TEARDOWN|COMPLETE) NONE NONE'
capture='(CAPTURE|FONTS|AXE_INJECT|AXE_EVALUATE|LIGHTHOUSE|TEARDOWN)'
views='(POPULATED_DESKTOP|EMPTY_DESKTOP|POPULATED_MOBILE|EMPTY_MOBILE|KEYBOARD_MOBILE)'
ops='(CONTEXT_NEW|COOKIE|ROUTE|PAGE|SCRIPT_SESSION|SCRIPT_DISABLE|NAVIGATE|LOAD|ROUTES_PENDING|WAIT|INSPECT|MEASURE|KEYBOARD_TAB|KEYBOARD_ARROW|KEYBOARD_SCROLL|KEYBOARD_INSPECT|SCREENSHOT|AUDIT_POLICY|AUDIT_ENABLE|RUN|AUDIT_RESTORE|VERIFY|CONTEXT_CLOSE)'
allowed="^($general|$capture $views $ops)"$'\n$'
if [[ -f "$scratch/browser-stage" && ! -L "$scratch/browser-stage" ]] &&
  ! IFS= read -r -d '' -n 64 raw < "$scratch/browser-stage" && [[ $raw =~ $allowed ]]; then
  IFS=' ' read -r stage viewport operation <<< "${raw%$'\n'}"
fi
# 137 by itself is ambiguous: the watchdog's TERM marker also survives KILL escalation.
case "$stage:$result" in
  *:124|*:137)
    if grep -Fxq "timeout: sending signal TERM to command 'bash'" "$scratch/watchdog.txt"; then outcome=WATCHDOG; fi ;;
  COMPLETE:0) outcome=PASS ;;
  COMPLETE:*) ;;
  # Startup can return a typed error before recording its first stage.
  *:22) outcome=ERROR ;;
  UNKNOWN:*) ;;
  *:20) outcome=ASSERTION ;;
  *:21) outcome=DEADLINE ;;
esac
printf 'Activity-log browser: outcome=%s stage=%s viewport=%s operation=%s browser_elapsed_s=%s\n' \
  "$outcome" "$stage" "$viewport" "$operation" "$elapsed"
if [[ -f "$scratch/metrics.txt" ]]; then
  pattern='((populated|empty)-desktop\.png a11y: (PASS|FAIL) violations=[0-9]+ incomplete=[0-9]+|populated-desktop\.png lighthouse: (unavailable|report-only total_bytes=[0-9]+ fcp_ms=[0-9]+))'
  ! grep -qEvx "$pattern" "$scratch/metrics.txt" || exit 1
  grep -Ex "$pattern" "$scratch/metrics.txt"
fi
[[ $outcome == PASS ]] || exit 1
[[ $(wc -l < "$scratch/metrics.txt") == 3 ]]
printf 'PASS: Activity-log fixture, rendered states and route a11y\n'
mv -T -- "$scratch/screenshots" "$RUNNER_TEMP/kit-activity-log-approved"
