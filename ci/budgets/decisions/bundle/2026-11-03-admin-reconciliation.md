# Admin reconciliation stylesheet

The new moderator reconciliation screens need long scalar facts to wrap and table
UTC timestamps to stay intact. Serve these two rules in an admin-only stylesheet,
following the existing admin RSVP-review stylesheet pattern. Putting them in the
shared stylesheet would increase the homepage's inlined critical CSS.

Measured with `npm run build:assets` and `node ci/check-bundle-budget.mjs`:

| Asset | Measured raw | Measured gzip | Old ceiling | New raw ceiling | New gzip ceiling |
| --- | ---: | ---: | --- | ---: | ---: |
| `public/admin-reconciliation.css` | 93 B | 94 B | None (new asset) | 128 B | 128 B |

The 128 B ceilings intentionally stay tighter than the default rounded allocation
for this two-rule file. No existing asset ceiling or homepage budget changes.
