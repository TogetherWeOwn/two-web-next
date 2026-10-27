# 2026-10-27 decision: schedule-print server gzip 336384 -> 336640

Propose one 256B step for `server.js.maxGzipBytes` in
`ci/budgets/kit/server-js.json`. No other fragment or checker changes.
This is separate from the schedule-print feature (#1910); its gates
remain unchanged until an independently reviewed allocation lands.

## Exact trees and measurements

Node 24.22.1, npm 11.19.1, committed root and web lockfiles. Dependencies
were installed outside the checkout with `npm ci --include=dev
--ignore-scripts --no-audit --no-fund` and linked into isolated archives.
Each `npm --prefix <archive>/web run build` ran the normal `prebuild`
critical-CSS generator; `node <archive>/ci/check-kit-perf.mjs --format
json` measured the resulting files. Two production builds per tree;
all four builds exited 0. No remote service or database was used.

- Main: `d6e9491c2216738cf016c7020c0ea84e7a5b7f91`.
- Feature: `94c4ea4073662374a3875143cfaf349e043ed669`, which already
  includes that exact main as its second parent. No speculative merge
  or conflict resolution is part of the measurement.
- GitHub's head branch and PR metadata identify that feature head. The
  advertised `refs/pull/1910/head` still identified its older parent,
  so the archives use the exact verified head SHA, not that stale ref.

| Tree/build | Server raw | Server gzip | Client raw | Client gzip | Existing gate |
|---|---:|---:|---:|---:|---|
| Main 1 | 1190242 | 336249 | 256371 | 102994 | exit 0 |
| Main 2 | 1190242 | 336249 | 256371 | 102994 | exit 0 |
| Feature 1 | 1191564 | 336601 | 256795 | 103179 | exit 1, server and client gzip |
| Feature 2 | 1191566 | 336601 | 256795 | 103179 | exit 1, server and client gzip |

Both trees contain 116 server JS files and 54 client JS files. Worker
2551 raw / 1219 gzip and client CSS 2861 raw / 1019 gzip (2 files) are
identical in every build. Their ceilings, server/client raw ceilings,
file-count ceilings and startup timeout remain unchanged. The server raw
rebuild difference is 2B; the gzip total is identical in these two
feature builds. The earlier independently recorded 336602B measurement
also fits this step, with 38B remaining; it is not treated as a new
feature regression relative to this run's 336601B.

## Attribution and the smallest step

The measured feature costs +352B server gzip and +185B client gzip over
main. In build 2, `chunks/site-shell.js` accounts for +579 raw / +190
gzip and `chunks/events.js` for +745 raw / +162 gzip. Other shared
server chunks have small positive and negative gzip changes that net
to zero. This is the shared print-scope formatter, Hono list/archive
markup and Kit archive markup, not a new chunk or dependency. The client
raw delta is 424B; all existing raw and file-count limits still fit.

The feature's formatter is already shared between renderers. It names
the committed search, game and page, including past-only, unpaged and
empty states. Its print-only nodes live inside the swapped content
zones so navigation cannot leave a stale printed scope. No clearly
smaller behavior-preserving reduction was identified in this small
addition. Dropping states/copy, separating the twins or introducing
compression-oriented special cases would trade that contract for an
incidental size saving. This proposal instead makes its small cost
explicit and reviewable without altering the feature.

336384 rejects 336601 by 217B. 336640 admits it with 39B remaining;
336640 is the smallest 256B-aligned cover. The already-supported 336896
allocation is not used. This decision deliberately does not use the
general 1.25 multiplier: it allocates only the next measured step,
without speculative headroom.

## Independent axes and refusal controls

The client still exceeds 103168 by 11B. Existing PR #1952 proposes the
103424 client-gzip step, also proposed by #1947. Reuse whichever lands;
this PR does not duplicate that allocation or claim it is merged.
With only this server step, the real feature output still exits 1,
solely on client gzip. With both independent steps applied in scratch,
main and the feature output each exit 0; the feature client margin is
245B. No scratch client edit ships here.

A scratch-only harness using the unchanged shipping checker and fixed
high-entropy fixtures proves each axis independently:

| Axis | Observed bytes at old cap | Observed bytes at proposed cap | Exact cap | One byte over |
|---|---|---|---|---|
| Server | 336601 at 336384: exit 1 | 336601 at 336640: exit 0 | 336640: exit 0 | 336641: exit 1 |
| Client | 103179 at 103168: exit 1 | 103179 at 103424: exit 0 | 103424: exit 0 | 103425: exit 1 |

These are real per-file gzip measurements, not mocked sizes. They do
not substitute for the independently owned shipping tests. Main's
unchanged budget suites pass 123/123 before this fragment edit. Main
does not yet admit the 336640 literal; the additive correction belongs
to #1946. Keep this PR draft until that correction lands and the exact
integrated head passes all required checks and independent review.
No acceptance test files are edited here; the feature's immutable
schedule-print acceptance SHA-256 remains
`7c8ad291af0ff0e6cbad8b75fc626df64e190099078d3be5d6bb581c6bc07a8c`.

No UI, browser, staging, runtime activation or deployment claim is made
by this capacity-only PR. Undo: revert this single fragment step and
this decision record. The feature remains subject to its own full
verification after integrating both independent capacity changes.
