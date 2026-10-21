#!/usr/bin/env bash
# Install the public PGDG key and client on a persistent Debian/Ubuntu runner.
# Path overrides are for offline selftests; no backup credentials are consumed.
set -euo pipefail

print_usage() {
  echo "usage: $0 [--help | -h]"
  echo ""
  echo "Install the public PGDG key and PostgreSQL 18 client on a persistent"
  echo "Debian/Ubuntu runner. Takes no arguments: --help (or -h) prints this"
  echo "usage; any other argument is refused before any privilege, network,"
  echo "package or temp-dir work."
}

# argv validation comes first: --help must answer with zero side effects (no
# sudo, network, package or temp-dir work), and anything else is refused
# before the installer can do anything.
if [ "$#" -gt 1 ]; then
  echo "backup-bootstrap: refusing: takes no arguments (got $#)" >&2
  print_usage >&2
  exit 2
fi
case "${1:-}" in
  "") ;;
  --help|-h) print_usage; exit 0 ;;
  *) echo "backup-bootstrap: refusing unknown argument '$1'" >&2; print_usage >&2; exit 2 ;;
esac

KEYRING="${PGDG_KEYRING:-/usr/share/keyrings/pgdg.gpg}"
SOURCE_LIST="${PGDG_SOURCE_LIST:-/etc/apt/sources.list.d/pgdg.list}"
CLIENT_BIN="${PGDG_CLIENT_BIN:-/usr/lib/postgresql/18/bin}"
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
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-client-18

# A persistent runner may have other client majors installed. Select 18 directly
# and carry that selection to subsequent GitHub steps instead of using pg_wrapper.
VERSION="$("$CLIENT_BIN/pg_dump" --version)"
if [[ ! "$VERSION" =~ ^pg_dump\ \(PostgreSQL\)\ 18([.[:space:]]|$) ]]; then
  echo "backup-bootstrap: expected pg_dump major 18" >&2
  exit 1
fi
printf '%s\n' "$VERSION"
if [ -n "${GITHUB_PATH:-}" ]; then printf '%s\n' "$CLIENT_BIN" >> "$GITHUB_PATH"; fi
