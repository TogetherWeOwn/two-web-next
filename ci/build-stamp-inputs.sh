#!/usr/bin/env bash
# NUL-separated tracked files whose bytes define the compiled Worker payload.
# `ci/deploy-identity.mjs stamp` digests exactly the files listed here, so the
# build stamp changes whenever one of their bytes changes. The generated stamp
# itself is excluded (it is the output, not an input). Completeness of this
# inventory against the final artifact manifest belongs to the artifact-manifest
# slice; both deploy lanes read this one list.
set -euo pipefail
git ls-files -z -- \
  src public web/src web/_headers \
  web/package.json web/package-lock.json web/tsconfig.json web/vite.config.ts \
  web/wrangler.jsonc web/wrangler.staging.jsonc \
  wrangler.jsonc package.json package-lock.json tsconfig.json \
  ':(exclude)src/build-stamp.ts'
