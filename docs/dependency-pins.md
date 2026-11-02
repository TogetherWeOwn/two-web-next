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
| Exact range in `package.json` | `zod` 4.6.7, `esbuild` 0.28.2 | Cannot float, but the lockfile copy is still checked against the exact version |
| String `overrides` entry | `undici` 7.30.1 | Every installed copy must agree with the override |
| Nested `overrides` entry | `overrides["@lhci/cli"]["tmp"]` 0.2.7 | The copy the scope package resolves must agree; reported as informational when the scope declares no such dependency edge |

Transitive pins read through a consumer's resolver (for example `tmp` 0.2.7
via `lhciRequire`) are reported as informational: the manifest overrides
enforce them and the owning test verifies them, so they never enter the
hold-back set. A transitive pin read from the root copy (a bare `require()`
or an explicit `node_modules/` path) is verified against the root lockfile
entry like a direct pin, except drift files a follow-up instead of an
`npm install` restore: installing a transitive package by name would promote
it to a direct dependency. Pins read through a consumer resolver
(`lhciRequire`, `req`, …) rather than a bare `require()` or an explicit
`node_modules/` path stay held back but likewise verify in the owning test:
the guard only vouches for copies it can resolve (the root entry), and never
claims an unchecked pin is verified.

## Sweep procedure

```sh
UPDATE=$(node ci/check-dependency-pins.mjs --updatable)
[ -n "$UPDATE" ] && npm update $UPDATE
node ci/check-dependency-pins.mjs
```

A drifted direct pin is restored lockfile-only with
`npm install --package-lock-only <pkg>@<version>`: a bare
`npm install <pkg>@<version>` would save the version into the manifest range,
while `--package-lock-only` leaves the manifest untouched and restores the
lockfile entry with its resolved URL and integrity. Adopting the newer version
is filed as a follow-up instead of being floated by the sweep. After
undrafting a sweep PR, wait for the heavy jobs (`check`, `node22-compat`) to
re-run on `ready_for_review` rather than trusting draft-CI green: drafts skip
them by design.
