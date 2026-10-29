# 2026-10-27 decision: admin event capacity island

New served asset `public/islands/admin-event-capacity.js`: the progressive
island that explains a proposed event capacity as the moderator types, on
both admin edit twins (Hono and Kit).

- Measured: 828 raw / 488 gzip bytes (esbuild `--minify`, `npm run budget`).
- New ceilings 1536 raw / 768 gzip: measured x1.25 rounded up (raw to 512B,
  gzip to 256B), a new fragment with exactly one entry.
- Why: input-event-only advice against the server-rendered Going snapshot
  (data attributes in, advice text out). No requests, no polling, and no
  other island changes in this slice.

`SHIPPING_BUNDLE_BUDGETS` in `ci/budget-fragments.test.mjs` gains the same
entry. No checker, gate, or exclusion changes. Undo: delete the fragment, the
island source and this decision together.
