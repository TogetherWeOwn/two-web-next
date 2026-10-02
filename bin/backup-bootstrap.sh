#!/usr/bin/env bash
# Install the public PGDG key and client on a persistent Debian/Ubuntu runner.
# Path overrides are for offline selftests; no backup credentials are consumed.
set -euo pipefail

KEYRING="${PGDG_KEYRING:-/usr/share/keyrings/pgdg.gpg}"
SOURCE_LIST="${PGDG_SOURCE_LIST:-/etc/apt/sources.list.d/pgdg.list}"
CLIENT_BIN="${PGDG_CLIENT_BIN:-/usr/lib/postgresql/17/bin}"
T="$(mktemp -d)"
STAGED=""
cleanup() {
  if [ -n "$STAGED" ]; then sudo -n rm -f -- "$STAGED"; fi
  rm -rf -- "$T"
}
trap cleanup EXIT

# Stage in the destination directory, then rename: failed writes never truncate
# the previous keyring, and mv replaces a destination symlink rather than its target.
install_atomic() {
  local input="$1" destination="$2"
  STAGED="$(sudo -n mktemp "${destination}.tmp.XXXXXX")"
  sudo -n install -m 0644 -- "$input" "$STAGED"
  sudo -n mv -fT -- "$STAGED" "$destination"
  STAGED=""
}

sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates gnupg lsb-release
curl -fsSL --output "$T/pgdg.asc" https://www.postgresql.org/media/keys/ACCC4CF8.asc
# Check that the download contains a key, not just decodable armor. GPG uses
# only run-owned scratch, never the existing privileged keyring or user key store.
# --batch/--no-tty prohibit prompts; --yes also permits repeated scratch output.
gpg --batch --yes --no-tty --homedir "$T" --show-keys "$T/pgdg.asc" >/dev/null
gpg --batch --yes --no-tty --homedir "$T" --dearmor --output "$T/pgdg.gpg" "$T/pgdg.asc"
[ -s "$T/pgdg.gpg" ]
install_atomic "$T/pgdg.gpg" "$KEYRING"
CODENAME="$(lsb_release -cs)"
printf 'deb [signed-by=%s] http://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' \
  "$KEYRING" "$CODENAME" > "$T/pgdg.list"
install_atomic "$T/pgdg.list" "$SOURCE_LIST"
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-client-17

# A persistent runner may have other client majors installed. Select 17 directly
# and carry that selection to subsequent GitHub steps instead of using pg_wrapper.
VERSION="$("$CLIENT_BIN/pg_dump" --version)"
if [[ ! "$VERSION" =~ ^pg_dump\ \(PostgreSQL\)\ 17([.[:space:]]|$) ]]; then
  echo "backup-bootstrap: expected pg_dump major 17" >&2
  exit 1
fi
printf '%s\n' "$VERSION"
if [ -n "${GITHUB_PATH:-}" ]; then printf '%s\n' "$CLIENT_BIN" >> "$GITHUB_PATH"; fi
