# Integrated event detail: client raw budget

## Decision

Allocate only `client.js.maxRawBytes`, from **254976 to 256000 bytes**. This is
1024 additional bytes, the minimum two 512-byte steps needed for the measured
integration of [#1499](https://github.com/TogetherWeOwn/two-web-next/pull/1499).
The next lower aligned ceiling, 255488, still rejects the output by 112 bytes.
The proposed ceiling leaves 400 bytes, not reserved capacity for later features.

Every other ceiling and file cap stays identical to pinned main. Keep its entire
`$comment` history byte-for-byte, including the independent correlation allocation
and the older sharing/roster measurements. This document adds a new measurement;
it neither replaces that history nor claims that its old composition is current.
No runtime, acceptance test, dependency, lockfile, checker, workflow, security
control or quality floor changes. No deployment is authorized by this decision.

**ACT:** grant the minimum measured raw allocation in this separate PR.
**WHY:** required event-detail states exceed the current integrated raw ceiling;
gzip and all other measured groups already fit.
**UNDO:** revert this raw-only numeric delta and these evidence documents, preserving
all independently landed allocations.

## Frozen inputs and method

- Main: `2f9e60791d27378d4b07f0cfd615c8af86f04f76`.
- Feature #1499: `26fd963642faef083e77db37c37d458217111a6a`.
- Integrated tree: `3dfd8ba769c3783e6c067e47e0c1962804f04af2`, produced by
  `git merge-tree --write-tree <main> <feature>` (exit 0; no conflict or repair).
- Node **24.22.1**, npm **11.19.1**. Separate archived trees use the same locked
  root/web dependencies installed outside the tracked tree with
  `npm ci --include=dev --no-audit --no-fund`. Database-URL environment keys are
  absent from every build. No database, staging probe, migration or deploy runs.
- Both manifests, both locks, Vite configuration, checker and inventory scripts
  are byte-identical between trees. Root lock SHA-256:
  `023b560fb97de0f5a91332701e2d0100c24d53e964dbd19863e5d5133d18631d`;
  web lock: `feaa492a89fb6ffe07ea4114e2111219e1f8ff4d2a99dc53fc7b7898f8be565e`.
- Twice per tree: `npm run build --prefix web`, then
  `node ci/check-kit-perf.mjs --format json`. All four builds exit 0. Checker
  reports use Node's `gzipSync`, exactly as enforcement does, not another gzip
  implementation. [Machine-readable evidence](performance-evidence/event-detail-client-budget.json)
  retains all four canonical reports and boundary-control outcomes.

## Repeated canonical inventory

| Tree / build | Worker raw / gzip | Server files; raw / gzip | Client JS files; raw / gzip | CSS files; raw / gzip | Checker exit |
| --- | --- | --- | --- | --- | ---: |
| Main 1 | 2551 / 1219 | 115; 1176056 / 333148 | 54; 253949 / 102273 | 2; 2833 / 1006 | 0 |
| Main 2 | 2551 / 1219 | 115; 1176056 / 333149 | 54; 253949 / 102273 | 2; 2833 / 1006 | 0 |
| Integrated 1 | 2551 / 1219 | 115; 1179090 / 333721 | 54; 255600 / 102655 | 2; 2833 / 1006 | 1 |
| Integrated 2 | 2551 / 1219 | 115; 1179088 / 333720 | 54; 255600 / 102655 | 2; 2833 / 1006 | 1 |

Both failures name **only client raw**, 624 bytes over 254976. Current main has
already raised that ceiling since the feature's handoff measurement; this proposal
uses current main, not the superseded 254464-byte ceiling.

Unchanged limits: Worker 3584/1536; server 126 files, 1203200/334080; client JS
55 files and 102912 gzip; CSS 4 files, 3072/1024. Startup stays 60000ms and was
**not timed** by these builds. Server variation is retained in the reports, not
misrepresented as exact reproducibility. Client raw/gzip/count, CSS and Worker
measurements agree across repeats.

## Attribution and reduction assessment

The only client files whose hashes change between the second builds are the
`nodes/22` event-detail chunk and `entry/app`. All other 52 client files are
byte-identical. Node gzip measurements:

| Client file | Main raw / gzip | Integrated raw / gzip | Delta raw / gzip |
| --- | ---: | ---: | ---: |
| `nodes/22` | 17086 / 5706 | 18737 / 6086 | +1651 / +380 |
| `entry/app` | 5606 / 1527 | 5606 / 1529 | 0 / +2 |
| Total client | 253949 / 102273 | 255600 / 102655 | +1651 / +382 |

The entry change is the same-length hashed reference to the new event-detail
chunk. The source delta in `web/src/lib/EventDetail.svelte` adds a shared
closed/paused RSVP verdict, a venue-TBD row, and distinct guest, non-member and
empty-member roster branches. The copy and links differ deliberately; closed
states do not invite an impossible RSVP. Existing timezone comparison, final
attendance, native sharing and accessibility notes remain present in the
composition. There is no new import, dependency or shared client chunk to remove.

A source/compiled-output inspection found no obvious unused import or duplicated
controller responsible for these 1651 raw bytes. Removing the extra markup would
remove required states or their accessible headings and recovery links. A larger
markup refactor would change the feature under review rather than safely reclaim
624 bytes. This allocation therefore preserves the reviewed behavior instead of
claiming an unproven reduction. It is not evidence that every possible refactor
has been exhausted.

All 54 integrated client JS files contain zero occurrences of `drizzle-orm`,
`postgres`, `kit-session`, `cloudflare:workers`, `SESSION_SECRET` and
`DISCORD_BOT_TOKEN`. This marker scan is a bounded check, not a general privacy
proof.

## Actual-output boundary controls

Run the unchanged checker against the second integrated artifact, changing only
the indicated client-JS limit in a disposable copy. All other fields and output
bytes remain fixed. Restore the original budget afterward.

| Control | Raw ceiling | Gzip ceiling | File cap | Exit / failing group |
| --- | ---: | ---: | ---: | --- |
| Incoming main | 254976 | 102912 | 55 | 1 / client JS only |
| Proposal | 256000 | 102912 | 55 | 0 |
| One raw step lower | 255488 | 102912 | 55 | 1 / client JS only |
| Exact raw | 255600 | 102912 | 55 | 0 |
| Raw minus one | 255599 | 102912 | 55 | 1 / client JS only |
| Exact gzip | 256000 | 102655 | 55 | 0 |
| Gzip minus one | 256000 | 102654 | 55 | 1 / client JS only |
| Exact count | 256000 | 102912 | 54 | 0 |
| Count minus one | 256000 | 102912 | 53 | 1 / client JS only |

**9/9** expected exits and failing-group identities match. Proposed caps pass;
raw, gzip and count enforcement each still reject their own boundary violation.
The unchanged checker's existing selftests remain the policy regression suite;
no Test Author file is edited to admit the feature.

## Integration handoff

This prerequisite is not feature approval. After the allocation lands, read
#1499's actual latest head again and build its composition with landed main.
Record those immutable refs, all canonical groups and the checker exit on the task.
A historical-head fit alone must not unblock the feature. If main or the feature
moves, repeat that final proof rather than extrapolating the 400-byte margin.
