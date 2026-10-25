# Join investigation client budget reconciliation

Measured 2026-10-24. This is a separate performance allocation for the composition
of [the join investigation change](https://github.com/TogetherWeOwn/two-web-next/pull/1705)
with already-landed main changes. It does not approve or ship that behavior.
Only `client.js.maxRawBytes` and `client.js.maxGzipBytes` change in
[`ci/kit-perf-budget.json`](../ci/kit-perf-budget.json). Existing decision history
stays byte-for-byte intact; this note records the new decision separately.

## Inputs and method

- Node 24.22.1, npm 11.19.1, zlib `1.3.2.1-motley-285e94b`.
- Locked Svelte 5.57.2, Kit 3.1.0, Vite 8.3.4, Cloudflare adapter 8.0.1.
- Root lockfile SHA-256:
  `131c46575f340d700c1c3dd414c64d403289042b77fbaf7ec7e7a3d9449437e0`.
- Web lockfile SHA-256:
  `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`.
- Both lockfiles are identical across every input. Run `npm ci --include=dev`
  and `npm ci --prefix web --include=dev`; use fresh archived source trees and
  the same locked dependency installations for every build. Run
  `npm run build --prefix web`, then `npm run kit-perf` in each tree.
- Totals sum **every** emitted JS/CSS file under the checker's directories,
  including repeated generated wrappers. Gzip is `gzipSync(bytes).length` per
  file, not compression of concatenated files. Sourcemaps are excluded exactly
  as in [`ci/check-kit-perf.mjs`](../ci/check-kit-perf.mjs).
- No deployment, database, staging/production probe, dependency update, feature
  edit, test edit, workflow change, exemption or checker change is involved.

| Input | Exact commit or tree | Client JS files | Raw B | Gzip B | Original gate exit |
| --- | --- | ---: | ---: | ---: | ---: |
| Behavior parent | `94185b98bf8c47e9e9f790d6822aa0e2186db981` | 55 | 252869 | 102417 | 0 |
| Incoming main parent | `2fa5bc60e6a914a3b2d081cfd44259ff3a81d0c1` | 54 | 252270 | 101942 | 0 |
| Original union | `6e6f842e1cdab9e4d6eba42f9ebf8fe60dbf8d2a` | 55 | 253975 | 102734 | 1 |
| Current pristine main | `ee1e943e9aab12711056ee18b71e5ce0a2c42a03` | 54 | 252317 | 101966 | 0 |
| Current composition tree | `577adf8fd953f8aac2083037dd4514eccaa3cc46` | 55 | 254022 | 102763 | 1 |

The original union's two parents pass their own ceilings. Its numeric limits
are exactly the maximum of the parents: 253440 raw / 102656 gzip B, not a new
allocation. It exceeds those limits by 535 / 78 B. The current composition is
reproducible with:

```sh
git merge-tree --write-tree \
  ee1e943e9aab12711056ee18b71e5ce0a2c42a03 \
  6e6f842e1cdab9e4d6eba42f9ebf8fe60dbf8d2a
```

It merges cleanly, without source or generated-asset reconstruction. Archive the
returned tree with `git archive`, install/link the same locked dependencies, and
build as above. It exceeds max-parent limits by 582 / 107 B; against current
main's lower gzip ceiling, the breach is 363 B. A second pristine-main build and
a second current-composition build produce byte-identical client JS/CSS rows
(paths, hashes and sizes). Server totals wobble by at most 2 B in those pairs.

## Growth and duplicate audit

Relative to current main, the composition costs **+1705 raw / +797 gzip B** and
one JS file. The Vite manifest and SHA-256 inventory account for that entire
client delta:

| Generated output | Raw delta B | Gzip delta B |
| --- | ---: | ---: |
| New shared admin helper `chunks/D5KmFpmb.js` | +1320 | +643 |
| App entry / import table | +33 | +11 |
| Node 12 | -295 | -145 |
| Node 19 | +514 | +224 |
| Node 20 | +133 | +64 |
| **Sum** | **+1705** | **+797** |

The shared helper contains activity-log/join paging, investigation context,
missing-evidence labels and empty-state copy, rather than another framework
runtime. All other client JS files are byte-identical to current main. Locked
runtime packages remain single deduplicated versions.

There are **pre-existing**, not newly introduced, identical generated wrappers:
nodes 0/2/5 each contain 146 raw / 144 gzip B; nodes 29/31 each contain
377 raw / 217 gzip B on current main and its composition. Both groups already
exist in both original parents. They stay counted, without exclusions. No new
identical-content group, duplicate CSS, or unexplained client delta appears.
The server's identical `manifest.js` / `manifest-full.js` pair also exists in
both parents and both compositions and remains counted.

## Minimum allocation and controls

Use the existing 512 B raw / 256 B gzip step sizes, not a percentage allowance:

| Client JS ceiling | Main before | New | Increase from main | Current-composition margin |
| --- | ---: | ---: | ---: | ---: |
| Raw B | 253440 | 254464 | 1024 (two steps) | 442 |
| Gzip B | 102400 | 102912 | 512 (two steps) | 149 |

The behavior parent already carries 102656 gzip B; measured from the max-parent
union, the additional gzip allocation is only one 256 B step. The actual change
in this main-based PR is nevertheless 512 B, not 256 B.

Controls use retained build output and the unchanged exported checker, altering
only a disposable copy of the budget:

- Proposed ceilings pass all five measured trees (exit 0).
- One fewer raw step, 253952 B, rejects the current composition by 70 B.
- One fewer gzip step, 102656 B, rejects it by 107 B.
- Both original and current compositions pass at their exact observed client
  raw/gzip/file totals, and reject with either byte ceiling one byte below
  actual, or the file ceiling one file below actual (exit 1).
- The existing six checker selftests and 13 checker tests pass unchanged,
  including incomplete/empty output and unbudgeted-asset refusals.

Everything else stays fixed: worker 3584/1536 B (actual 2551/1219), server
1203200/333312 B and 126 files (current composition 1158448/328601–328603 B,
115 files), client CSS 3072/1024 B and four files (actual 2861/1019, two files),
client JS 55 files, and startup 60000 ms. The byte check does not measure actual
startup latency; the unchanged parity readiness timeout enforces that ceiling.

The margins are deliberately thin: **149 B client gzip, 5 B CSS gzip, and zero
spare client JS files** on this composition. This allocation is not reserved
capacity for another feature. Any subsequent integrated head must be rebuilt and
pass all unchanged CI, security and independent-review gates.

## Undo

Revert this PR's two numeric changes and this note. No application state or
schema changes. That restores main's 253440/102400 B limits and intentionally
rejects the measured behavior composition until its bytes are reduced or a new
separately reviewed allocation is justified.
