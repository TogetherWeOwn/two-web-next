#!/usr/bin/env bash
set -euo pipefail
client=${0##*/}
container=$(<"${0%/*}/container")
env_args=()
for key in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE PGOPTIONS PGCLIENTENCODING PGCONNECT_TIMEOUT PGGSSENCMODE; do
  if [[ -v "$key" ]]; then
    env_args+=(--env "$key")
  fi
done

# The capture helper writes via pg_dump -f; stream the archive to its private
# runner file without mounting the archive, plan or comparison key in Docker.
if [[ "$client" == pg_dump ]]; then
  file=${*: -1}
  [[ "${*: -2:1}" == -f ]]
  set -- "${@:1:$#-2}"
  exec > "$file"
fi
exec /usr/bin/docker --host=unix:///var/run/docker.sock exec -i "${env_args[@]}" "$container" "$client" "$@"
