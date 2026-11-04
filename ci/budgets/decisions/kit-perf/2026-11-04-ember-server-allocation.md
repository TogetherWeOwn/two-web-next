# Bounded server-JS allocation for the pinned Ember migration

This explicitly allocates 2,048 raw bytes and 1,024 gzip bytes for the pinned
Ember design-kit migration. It is feature growth, not automatic 1.25 headroom
or a general relaxation to make a red check green. No extraction code belongs
in this change.

## Immutable sources and canonical measurements

Base main is `10099ce45e7f6a4f1ade945bbbca85278982109e`, tree
`72ff4657d7339cedac189514d4bd03cb921b8988`. The frozen migration is
`47a0fd8b80239347f42c447fd79516673c7ae4b4`, tree
`4f8927af77e58bc93f08c80b05ac465ca84475c0`. Main is an ancestor of that
migration. This allocation changes only the server fragment, its independent
shipping tests, and this decision; it adds no runtime or dependency changes.

On 2026-11-04, main was built twice in the allocation's native isolated
workspace. The frozen migration was independently built twice in a fresh,
natively provisioned isolated workspace with its immutable SHA as baseRef.
Neither the migration author's checkout nor a mutable source/output copy was
used. Commands were `npm ci --include=dev`, `npm ci --prefix web --include=dev`,
`npm run build --prefix web`, then `node ci/check-kit-perf.mjs --format json`.
Main reused the locked installation for its second build; the frozen migration
reinstalled both roots for each build.

All builds used Node v24.21.0, npm 11.19.0 and zlib
`1.3.2.1-motley-8002e91`. The frozen installed build tools matched the locks:
SvelteKit 3.1.0, adapter-cloudflare 8.0.1, vite-plugin-svelte 7.3.1,
Svelte 5.57.2, Vite 8.3.5, esbuild 0.28.2 and Wrangler 4.156.1.
Both sources have identical dependency lock SHA256 values:

- Root: `a937b8fe65f57bae8dd5cb9d1941f3e8c17789eb00244e762a716ebca7a71828`.
- Web: `37251f387cbbb0be175c44ff7da1e90c69810ec7cd90e29987972ad204410458`.

Raw bytes and default Node `gzipSync` bytes are summed **per file**, using the
shipping checker's complete canonical inventory, not rounded Vite output or
compression of a concatenated group. Every run has 173 measured files: one
Worker entry, 116 server JS files, 54 client JS files and two client CSS files.
All four builds exited 0. Main checker runs exited 0; frozen checker runs
exited 1 for server raw/gzip only under the old allocation. No missing-evidence
or cannot-enforce result was admitted.

| Group | Main run 1 raw / gzip | Main run 2 raw / gzip | Frozen run 1 raw / gzip | Frozen run 2 raw / gzip |
| --- | ---: | ---: | ---: | ---: |
| Worker | 2551 / 1219 | 2551 / 1219 | 2551 / 1219 | 2551 / 1219 |
| Server JS | 1220480 / 341055 | 1220482 / 341057 | 1222251 / 341996 | 1222251 / 341995 |
| Client JS | 261250 / 104332 | 261250 / 104332 | 261348 / 104378 | 261348 / 104378 |
| Client CSS | 2861 / 1019 | 2861 / 1019 | 3068 / 1189 | 3068 / 1189 |

Full logs, checker JSON and per-file inventories (path, raw bytes, per-file
gzip bytes, SHA256) are retained with the implementation evidence. Immutable
artifact identities:

- Main two-build archive SHA256:
  `2e0512952e51de826b07f2df168441eb3dfe46aff4281d1c9a6572f94a1689b3`.
- Frozen two-build archive SHA256:
  `ef4c4d0a36ee00c183ff1f6a92db509b141fca78dbdf900e02072fa0e040f6bf`.
- Frozen inspectable measurement JSON SHA256:
  `7d8e82848340d340013108eba2f0bf0f269175798dde97fb758b9d6ebf49e9db`.

### Historical one-byte discrepancy

The supplied 1222249 raw and 341994/341995 gzip totals are **historical**, not
fresh runs. Fresh canonical upper bounds are 1222251 raw and 341996 gzip.
The fresh frozen gzip difference is exactly one byte in
`server/chunks/internal.js` (18086 -> 18085 gzip bytes). Its generated build
version changed from `1793764044628` to `1793764082377`. Only it and
`server/chunks/instance.js` changed measured content. Replacing the version
literal and its derived SvelteKit global identifier reproduces both previous
full-file hashes exactly; every other measured file is byte-identical.
This proves the fresh variation. Historical aggregate totals alone cannot
attribute the historical two-raw-byte or gzip differences to particular
content, so they are not silently treated as reproduced evidence. No generated
version was pinned, stripped or rewritten to obtain a passing measurement.

## Allocation and feature rationale

| Server dimension | Old ceiling | New ceiling | Fresh worst | Remaining margin |
| --- | ---: | ---: | ---: | ---: |
| Raw bytes | 1220608 | 1222656 | 1222251 | 405 |
| Per-file gzip bytes | 341248 | 342272 | 341996 | 276 |
| Files | 126 | 126 | 116 | 10 |

The complete pinned Ember token/theme/font integration accounts for runtime
source growth; this PR introduces none of that code. Relative to the two
main-alone measurements, the frozen runtime costs 1769-1771 raw bytes and
938-941 gzip bytes. A broad critical-CSS extractor would change build and CSP
semantics; it remains an independent improvement, not a prerequisite for this
bounded server allocation.

Raw +2048 is the least 512-byte-aligned increase covering the fresh 1643-byte
deficit: +1536 still rejects by 107. Gzip +768 is the least 256-byte-aligned
cover, but leaves only 20 bytes on the fresh worst run (21 on the historical
341995 figure). The deliberate +1024 allocation leaves 276 fresh bytes (277
on that historical figure). It is **not the mathematical minimum**, and takes
no additional 25% headroom.

## Enforcement, unchanged gates and undo

Both shipping oracles retain historical allocations. New fixtures accept
fixed fresh measured sizes and exact 1222656 / 342272 ceilings, rejecting
1222657 raw and 342273 gzip independently, with the other axis and count
in bounds. Unsupported allocations and off-axis drift still fail; server
file-count rejection stays 127 against 126. Fixture sizes do not derive from
the loaded fragment.

No Worker/client/startup/homepage/HTML/inline-CSS/LCP/CLS/TBT/Lighthouse,
a11y, CSP, security, coverage, inventory or baseline gate changes. Startup
remains 60000 ms; printing that ceiling is not proof of startup performance.
Server JS is not browser transfer, but can affect startup and TTFB: no
zero-runtime-impact claim is made. The migration must rerun its complete
combined-head visual/UX and release gates after incorporating this allocation.
The technical allocation itself authorizes no production merge or deployment.

Undo before the migration ships: revert this fragment, its added allocation
controls and this decision together; measured main alone fits the old caps.
After it ships, reverting the caps alone would knowingly reject the migration:
first revert its growth or prove sufficient savings. When critical-CSS
extraction delivers, independently measure the then-current composition and
propose a separate downward ratchet, retaining 1220608 / 341248 as the original
improvement target. There is no automatic future raise or unmeasured decrease.

REA angle: reused the shipping fragment/decision mechanism, canonical checker
and literal boundary fixtures; inspected SvelteKit's shipped version/global
identifier generation to explain fresh build variation. No new tooling,
framework, runtime optimization or dependency was needed.
