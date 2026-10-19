#!/usr/bin/env bash
# Web migration range + immutable historical paths/SQL; no database access.
# Keep this entrypoint: CI also runs the hermetic regression proof here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
node ci/check-migration-history.mjs
node ci/check-snapshot-chain.mjs
node --test ci/check-migration-history-selftest.mjs
node --test ci/check-snapshot-chain-selftest.mjs
