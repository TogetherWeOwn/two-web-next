# Dependency pins

Some packages must stay at an exact resolved version even when the
`package.json` range would allow newer ones. The November 2026 sweep floated
wrangler 4.152.0 to 4.156.0 inside the root `^4.152.0` range with a bare
`npm update`; the break only surfaced at ready-for-review CI because drafts
skip the heavy jobs. `test/remote-runner-isolation.test.ts` pins the exact CLI
version and executes slices of its bundle, so the sweep must hold such packages
back instead of floating them.

## Run

```sh
node ci/check-dependency-pins.mjs --selftest   # gate logic, offline, no deps
npm run deps:pins:selftest                     # selftest plus node:test cases
npm run deps:pins                              # verify the lockfile kept every pin
node ci/check-dependency-pins.mjs --names      # hold-back set, space-separated
node ci/check-dependency-pins.mjs --updatable  # direct deps safe to `npm update`
```

The default verify mode emits one JSON summary (`version`, `ok`, per-pin rows,
and on failure a fixed `error_code` with a concrete `next_action`). The human
one-liner goes to stderr. Exit 0 is pass, 1 is pin drift, 2 is usage.

## Pin sources

| Source | Example | `npm update` behavior |
| --- | --- | --- |
| Installed-version test assertion | wrangler pinned to 4.152.0 by `test/remote-runner-isolation.test.ts` while the range is `^4.152.0` | Floats: hold back with `--updatable` |
| `package.json` range / overrides assertion | `test/performance-ci.test.ts` asserts `devDependencies["@lhci/cli"]`, `overrides["basic-ftp"]`, and the absence of `overrides["zod"]` | Never rewrites the manifest: verify-only |
| Exact range or `overrides` key in `package.json` | `esbuild` 0.28.2, `undici` override | Cannot float: verify-only |

Transitive pins (for example `tmp` 0.2.7 under `@lhci/cli`) are reported as
informational: the manifest overrides enforce them and the owning test verifies
them, so they never enter the hold-back set.

## Sweep procedure

```sh
UPDATE=$(node ci/check-dependency-pins.mjs --updatable)
[ -n "$UPDATE" ] && npm update $UPDATE
node ci/check-dependency-pins.mjs
```

A drifted pin is restored lockfile-only with `npm install <pkg>@<version>`
(the manifest range is left untouched) and adopting the newer version is filed
as a follow-up instead of being floated by the sweep. After undrafting a sweep
PR, wait for the heavy jobs (`check`, `node22-compat`) to re-run on
`ready_for_review` rather than trusting draft-CI green: drafts skip them by
design.
