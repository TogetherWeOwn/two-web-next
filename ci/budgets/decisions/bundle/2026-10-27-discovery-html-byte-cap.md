# 2026-10-27 decision: discovery HTML byte cap island costs

Measured-budget allocation for the slice that bounds the schedule and
archive page-turn reads: each island now reads the response body as a
stream, counts consumed bytes against one finite cap
(`DISCOVERY_HTML_MAX_BYTES`, 1 MiB), cancels on overflow and never hands
a rejected body to DOMParser. Two served assets grow; both raises are the
minimal 512B raw / 256B gzip steps that cover the measured growth, not
x1.25.

## public/islands/events-calendar.js: 10240/3840 -> 10752/4096

- Measured on main cd50096f3: 9848 raw / 3669 gzip. With the slice:
  10363 raw / 3898 gzip (+515 / +229).
- New ceilings: one 512B raw step (389B margin), one 256B gzip step
  (198B margin). x1.25 would be 12954/4873.
- Why: the stream reader (getReader loop, TextDecoder, byte count,
  cancel, abort check) and the body-less text() fallback with its UTF-8
  length count.

## public/islands/past-events.js: 4608/1792 -> 5120/2048

- Measured on main cd50096f3: 4408 raw / 1758 gzip. With the slice:
  4918 raw / 1991 gzip (+510 / +233).
- New ceilings: one 512B raw step (202B margin), one 256B gzip step
  (57B margin). x1.25 would be 6148/2489.
- Why: the same reader as above; the islands are standalone scripts, so
  the helper is duplicated and pinned to the contract constant by
  `test/discovery-html-cap-mirror.test.ts`.

## Scope

Carries measured bytes only. No checker, gate or exclusion changes;
`SHIPPING_BUNDLE_BUDGETS` in `ci/budget-fragments.test.mjs` moves with
the fragments. Undo: revert this allocation together with the slice.
