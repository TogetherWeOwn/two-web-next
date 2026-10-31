#!/usr/bin/env bash
# Local reproduction of the CI `check` job's Vitest gates (lint, typecheck,
# the coverage suite, the non-UTC hotzone pin and Tier-0) for agent
# workspaces. See CONTRIBUTING.md "Verify a change before opening a PR".
#
# Every shard gets its own disposable postgres:17 container on its own Docker
# network, aliased `agent-testdb` so the shared testDatabaseUrl guard accepts
# it unchanged. Suites run in node:24-bookworm (the CI job image) as the
# calling user. Nothing is published on host ports and nothing outside this
# checkout is touched; containers and networks are removed on exit.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bin/local-ci.sh [options] [-- <test files or vitest filters>...]

Full run (no files): lint + typecheck, migrations, `vitest run --coverage`
split over N shards with merged coverage thresholds, the hotzone suite under
TZ=America/Los_Angeles, and Tier-0. With files: migrations + only those files.

Options:
  -j, --shards N   Parallel shards, one Postgres each (default: nproc/4, max 8)
  --no-coverage    Skip coverage collection and thresholds (faster)
  --no-static      Skip lint and typecheck
  --install        Force `npm ci` for root and web/ (default: only when a
                   lockfile changed since the last local-ci install)
  --keep           Keep containers and networks for debugging
  -h, --help       Show this help

Examples:
  bin/local-ci.sh                              # full gate, default shards
  bin/local-ci.sh -j 8                         # full gate, 8 shards
  bin/local-ci.sh -- test/events.test.ts       # one file against fresh Postgres
  bin/local-ci.sh -- test/admin                # every file matching a filter
EOF
}

NODE_IMAGE=node:24-bookworm
PG_IMAGE=postgres:17
cpus=$(nproc 2>/dev/null || echo 4)
shards=$((cpus / 4))
((shards < 1)) && shards=1
((shards > 8)) && shards=8
coverage=1
static=1
force_install=0
keep=0
files=()

while (($#)); do
  case "$1" in
    -j | --shards)
      [[ ${2:-} =~ ^[1-9][0-9]*$ ]] || { echo "local-ci: $1 needs a positive integer" >&2; exit 2; }
      shards=$2
      shift 2
      ;;
    --shards=*)
      shards=${1#*=}
      [[ $shards =~ ^[1-9][0-9]*$ ]] || { echo "local-ci: --shards needs a positive integer" >&2; exit 2; }
      shift
      ;;
    --no-coverage) coverage=0; shift ;;
    --no-static) static=0; shift ;;
    --install) force_install=1; shift ;;
    --keep) keep=1; shift ;;
    -h | --help) usage; exit 0 ;;
    --) shift; files=("$@"); break ;;
    *) echo "local-ci: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"
command -v docker >/dev/null || { echo "local-ci: docker is required" >&2; exit 2; }

# A linked worktree's .git points into the main checkout's git dir; mount it
# too so suites that shell out to git (privacy history, leaf CSS) still work.
git_mounts=()
git_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
if [[ -n $git_common && $git_common != "$repo/.git" ]]; then
  git_mounts=(-v "$git_common:$git_common")
fi

# Focused runs are a single shard without the coverage gate: thresholds only
# make sense over the whole suite.
if ((${#files[@]})); then
  shards=1
  coverage=0
fi

run_id="localci-$$-$(date +%s)"
db="two_web_next_tog$(date +%s)$$"
workdir="$repo/.local-ci"
mkdir -p "$workdir" "$HOME/.npm"
rm -rf "$workdir/blob" "$workdir/logs"
mkdir -p "$workdir/blob" "$workdir/logs" "$workdir/home"

cleanup() {
  local status=$?
  if ((keep)); then
    echo "local-ci: kept containers/networks with prefix $run_id"
  else
    docker ps -aq --filter "label=local-ci=$run_id" | xargs -r docker rm -f >/dev/null 2>&1 || true
    docker network ls -q --filter "label=local-ci=$run_id" | xargs -r docker network rm >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Runs a command in the CI image as the calling user, on shard $1's network.
in_node() {
  local shard=$1
  shift
  local url="postgres://agent_test@agent-testdb:5432/$db"
  docker run --rm --init \
    --label "local-ci=$run_id" \
    --network "$run_id-$shard" \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp/home -e npm_config_cache=/tmp/home/.npm -e npm_config_update_notifier=false \
    -e DATABASE_URL="$url" -e AUDIT_IMPORT_TEST_DATABASE_URL="$url" \
    -e PGPASSWORD= -e W1_AGENT_TESTDB=0 \
    -e TZ="${LOCAL_CI_TZ:-UTC}" \
    -v "$repo:$repo" "${git_mounts[@]}" -v "$workdir/home:/tmp/home" -v "$HOME/.npm:/tmp/home/.npm" \
    -w "$repo" \
    "$NODE_IMAGE" bash -c "$*"
}

start_postgres() {
  local shard=$1
  local net="$run_id-$shard"
  docker network create --label "local-ci=$run_id" "$net" >/dev/null
  docker run -d --label "local-ci=$run_id" --name "$net-pg" \
    --network "$net" --network-alias agent-testdb \
    -e POSTGRES_USER=agent_test -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB="$db" \
    --tmpfs /var/lib/postgresql/data \
    "$PG_IMAGE" -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
}

wait_postgres() {
  local shard=$1
  # The image's init server listens on the socket only, so a TCP probe
  # succeeds only once the real server is up.
  for _ in $(seq 1 60); do
    docker exec "$run_id-$shard-pg" pg_isready -q -h 127.0.0.1 -U agent_test -d "$db" && return 0
    sleep 1
  done
  echo "local-ci: Postgres for shard $shard did not become ready" >&2
  docker logs "$run_id-$shard-pg" >&2 || true
  return 1
}

step() { printf '\n== local-ci: %s ==\n' "$*"; }
started=$(date +%s)

step "pull images"
docker image inspect "$NODE_IMAGE" >/dev/null 2>&1 || docker pull -q "$NODE_IMAGE"
docker image inspect "$PG_IMAGE" >/dev/null 2>&1 || docker pull -q "$PG_IMAGE"

step "start $shards disposable Postgres 17 container(s)"
for i in $(seq 1 "$shards"); do start_postgres "$i"; done

# The stamp records the lockfiles of the last install done inside the CI
# image, so host-built node_modules are never trusted and a lockfile change
# always reinstalls.
stamp="$(cat package-lock.json web/package-lock.json | sha256sum | cut -d' ' -f1)-$NODE_IMAGE"
if ((force_install)) || [[ ! -f node_modules/.local-ci-stamp || "$(cat node_modules/.local-ci-stamp)" != "$stamp" || ! -d web/node_modules ]]; then
  step "install root and web/ dependencies (npm ci)"
  in_node 1 "npm ci --include=dev --no-audit --no-fund && npm ci --prefix web --include=dev --no-audit --no-fund"
  echo "$stamp" >node_modules/.local-ci-stamp
else
  step "dependencies match lockfiles; skipping npm ci (use --install to force)"
fi

for i in $(seq 1 "$shards"); do wait_postgres "$i"; done

step "apply migrations"
pids=()
for i in $(seq 1 "$shards"); do
  in_node "$i" "npm run --silent db:migrate" >"$workdir/logs/migrate-$i.log" 2>&1 &
  pids+=($!)
done
for i in "${!pids[@]}"; do
  wait "${pids[$i]}" || { cat "$workdir/logs/migrate-$((i + 1)).log" >&2; exit 1; }
done

if ((${#files[@]})); then
  step "vitest run ${files[*]}"
  quoted=$(printf '%q ' "${files[@]}")
  in_node 1 "npx vitest run $quoted"
  step "passed in $(($(date +%s) - started))s"
  exit 0
fi

if ((static)); then
  step "lint + typecheck"
  in_node 1 "npm run lint && npm run typecheck && npm run e2e:typecheck"
fi

cov_args=()
((coverage)) && cov_args=(--coverage)
step "vitest suite over $shards shard(s) (logs: .local-ci/logs/shard-*.log)"
# Per-shard exit codes are not the verdict: with --coverage each shard checks
# the global thresholds against its slice of src/ and fails them. The merged
# report below is authoritative; a shard only fails here if it left no blob.
pids=()
for i in $(seq 1 "$shards"); do
  in_node "$i" "npx vitest run --pool=threads ${cov_args[*]} --shard=$i/$shards --reporter=blob --outputFile.blob=.local-ci/blob/blob-$i.json --reporter=dot --coverage.reportsDirectory=.local-ci/coverage-$i" \
    >"$workdir/logs/shard-$i.log" 2>&1 &
  pids+=($!)
done
suite_status=0
for i in "${!pids[@]}"; do
  wait "${pids[$i]}" || true
  if [[ -s $workdir/blob/blob-$((i + 1)).json ]]; then
    echo "shard $((i + 1))/$shards finished"
  else
    suite_status=1
    echo "shard $((i + 1))/$shards wrote no report (see .local-ci/logs/shard-$((i + 1)).log)"
  fi
done

# Merging the blobs reprints every failure and the combined pass counts and,
# with --coverage, applies the vitest.config.ts thresholds to merged coverage.
step "merged report"
merge_status=0
in_node 1 "npx vitest run --merge-reports=.local-ci/blob ${cov_args[*]} --reporter=dot --silent=passed-only" || merge_status=1

step "hotzone period suite under TZ=America/Los_Angeles"
LOCAL_CI_TZ=America/Los_Angeles in_node 1 \
  "node -e \"if (new Date('2026-04-01T00:00:00Z').getMonth() !== 2) throw new Error('TZ pin vacuous')\" && npx vitest run test/hotzone-period-picker-acceptance.test.ts --pool=forks"

step "Tier-0 (validators + authz + EXPLAIN)"
in_node 1 "npm run test:tier0"

if ((suite_status || merge_status)); then
  step "FAILED after $(($(date +%s) - started))s"
  exit 1
fi
step "all gates passed in $(($(date +%s) - started))s"
