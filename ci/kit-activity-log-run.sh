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
mkdir -- "$HOME"
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
cp -- "$GITHUB_WORKSPACE/harness/ci/kit-activity-log-assert.mjs" ci/

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
timeout -k 5s 90s node ci/kit-activity-log-assert.mjs </dev/null 2>/dev/null &
browser=$!
if ! wait "$browser"; then
  printf '::error::Activity-log diagnostic did not pass\n'
  exit 1
fi
browser=
