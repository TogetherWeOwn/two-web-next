# UTC-window scope cut: measured same-feature size allowance

This decision supersedes the **no ceiling changes** conclusion of
[the earlier renderer-fit decision](2026-10-30-admin-utc-window-fit.md), not
its historical measurements. It is part of the existing UTC-window feature PR,
not a separate budget or test PR.

## Narrower scope and cause

Restore the pre-existing search/status/RSVP/series/fill/sort/order fields and
Filter/Clear actions to their inline Hono and Svelte markup. Keep only the
feature's date controls and feedback shared. This removes the generic HTML
boundary that broke the existing Kit form contract and introduced avoidable
selected-state test coupling. Native controls, labels and selected values stay
in their established renderer. No new framework, dependency or database import
pays for the bytes.

A hidden correction-only `starts_required` marker now carries the rejected date
endpoint(s) through native GET submission. It prevents an unchanged blank date
control from silently turning a refused window into a broader successful read.
A valid correction satisfies the marker; explicit Clear filters removes it.
The marker has no authorization role and is never a database predicate.

## Baseline, composition and measurements

Current main is `2e55cb1e3`; the feature source before this correction is
`b3a4e460f5343ff9863e00acd479f0275d48dce6`. Main's only change since the previously
integrated `a6b2ee88` is `REVIEW.md`. Current main is incorporated into this same
feature composition before allocating bytes. Main's source and budgets were
also independently built from a pristine archive, using the same pinned root
and web dependencies, Node 24.22.1 and canonical build/check commands.

The corrected composition contains the inline-filter restore, date correction
marker, and unchanged production compression configuration. Its measurements
were taken before changing any ceiling. A second rebuild varied server raw by
two bytes and gzip by one byte; both observed values are retained below.

| Group | Pristine current main | Narrow correction | Old ceiling | New ceiling |
|---|---:|---:|---:|---:|
| Server JS raw | 1206784 | 1209760–1209762 | 1207040 | 1209856 |
| Server JS gzip | 337548 | 336029–336030 | 337664 | unchanged |
| Client JS raw | 259442 | 259993 | 259584 | 260096 |
| Client JS gzip | 103580 | 103746 | 103680 | 103936 |
| Client CSS raw/gzip | 2861 / 1019 | 2910 / 1037 | 3072 / 1280 | unchanged |

Both compositions have 116 server JS files, 53 client JS files and two CSS files.
Worker entry is 2551 raw / 1219 gzip bytes in both. Their limits, server gzip,
all CSS/file-count/startup and class-A budgets remain unchanged.

## Smallest supported allocations and cap

The in-feature class-B/C exception permits at most 0.5% total raise per budget.
Only these three axes move:

| Axis | Delta | Percent of old ceiling | Final measured margin |
|---|---:|---:|---:|
| Server raw | +2816 | 0.2333% | at least 94 bytes |
| Client raw | +512 | 0.1972% | 103 bytes |
| Client gzip | +256 | 0.2469% | 190 bytes |

Use the existing narrow 256-byte server-raw ladder instead of the default 25%
headroom formula. Its preceding step, 1209600, is below both observed correction
builds. Client raw uses the next 512-byte step; the preceding 259584 fails.
Client gzip uses the next 256-byte step; the preceding 103680 fails. These are
least-cover allocations, not new general sizing policy. The unchanged old
ceilings actually failed the canonical checker by 2722 server-raw, 409
client-raw and 66 client-gzip bytes on the first correction build.

Before allocation, exact source-head class-A checks were verified successful:
[a11y and Lighthouse](https://github.com/TogetherWeOwn/two-web-next/actions/runs/41154012836),
[browser-smoke and e2e](https://github.com/TogetherWeOwn/two-web-next/actions/runs/41154012810).
The overall CI run remains red on the known Kit source-contract test, not a
class-A failure. Its correction is the inline restore; no failed check is
bypassed. Fresh full CI/quality and independent exact-head review still gate
merging the corrected composition.

## Reproduction and independent test boundary

```sh
npm run build --prefix web
node ci/check-kit-perf.mjs --format json
```

The restored Kit source contract and refusal-correction tests passed after
observed RED proofs. The final focused selection executes 234 cases, with five
pre-existing browser opt-in skips; real Chromium executes all 19 required
cases, zero skipped. Full-suite, PostgreSQL, broad audit and final-head review
limits are disclosed separately in the PR; these counts are not release proof.

Append the new server allocation and exact client pair to the fragment
admissions. The existing independent fixed-literal shipping boundary tests need
their owner to admit server 1209856/1209857, client raw 260096/260097 and client
gzip 103936/103937, plus mixed-pair and adjacent-value negatives. Keep all
historical admissions, use literal boundaries independent of loaded caps, and
ship those corrections in this same feature PR. The Builder does not edit the
independently owned admission/boundary suites. Until their correction arrives,
the nine observed admission/boundary failures are pending, not green.

Rollback the feature and these fragment changes together. Do not retain an
unused allowance, edit historical decisions, relax a class-A limit, or revive
the broad generic extraction merely to save bytes.
