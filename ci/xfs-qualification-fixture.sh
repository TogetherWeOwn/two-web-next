#!/usr/bin/env bash
# Run a command against job-owned mounts on a disposable GitHub-hosted runner.
set -euo pipefail

if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || $# -eq 0 ]]; then
  printf '%s\n' 'Requires a GitHub-hosted Actions job and a command' >&2
  exit 2
fi

base=$(mktemp -d "${RUNNER_TEMP:?}/xfs-qualification.XXXXXXXX")
image="$base/xfs.img"
root="$base/root"
alias="$base/alias"
nested="$root/non-xfs"
mkdir "$root" "$alias"

cleanup() {
  local result=$? cleanup_failed=0
  trap - EXIT
  for mountpoint in "$nested" "$alias" "$root"; do
    if mountpoint -q "$mountpoint"; then
      sudo umount "$mountpoint" || cleanup_failed=1
    fi
    if mountpoint -q "$mountpoint"; then
      cleanup_failed=1
    fi
  done
  if (( cleanup_failed )); then
    printf '%s\n' 'Fixture cleanup failed; retaining backing image' >&2
    exit 1
  fi
  rm -rf -- "$base"
  if [[ -e "$base" ]]; then
    printf '%s\n' 'Fixture directory cleanup failed' >&2
    exit 1
  fi
  printf '%s\n' 'Fixture mounts and backing file removed'
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# mkfs receives only a fresh regular file, never an existing block device.
truncate -s 512M "$image"
sudo mkfs.xfs -q -f "$image"
sudo mount -o loop "$image" "$root"
sudo chown "$(id -u):$(id -g)" "$root"
chmod 700 "$root"
mkdir "$nested"
sudo mount --bind "$root" "$alias"
sudo mount -t tmpfs -o size=8m tmpfs "$nested"
sudo chown "$(id -u):$(id -g)" "$nested"
chmod 700 "$nested"

XFS_FIXTURE_ROOT="$root" XFS_FIXTURE_ALIAS="$alias" XFS_FIXTURE_NON_XFS="$nested" "$@"
