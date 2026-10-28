# Restored-write banner: bounded Kit size admission

The restored-write banner is rebuilt on main `728b70054b50623e921ee8da1c8ad92132772a15`.
It gives Kit pages the existing Hono recovery notice, with a read-only root-layout
peek and post-release cookie consumption. No dependency or client-side behavior
is added. Existing budget history stays unchanged.

## Same-toolchain measurement

Node 24.21.0, the committed root and web lockfiles, and the same installed
dependencies were used for both trees. The prior-base feature was rebuilt twice;
this table records two fresh compositions after the featured-unpublish merge
(server gzip 337895/337896 B; all other totals identical). Run
`npm run build --prefix web` followed by `npm run kit-perf`; sizes below are the canonical checker's per-file gzip sums,
not a single archive or a different compression level.

| Group | Pristine main | Rebuilt feature | Feature delta |
| --- | ---: | ---: | ---: |
| Server JS files | 116 | 116 | 0 |
| Server JS raw | 1194062 B | 1197992 B | 3930 B |
| Server JS gzip | 336799 B | 337896 B | 1097 B |
| Client JS files | 54 | 54 | 0 |
| Client JS raw | 257102 B | 258886 B | 1784 B |
| Client JS gzip | 103192 B | 103906 B | 714 B |

Pristine main passes the incoming ceilings. The feature exceeds server gzip by
1000 B, client raw by 838 B, and client gzip by 482 B. The growth comes from the
banner props and twin markup, the journey field, and the root-layout/hook wiring.

## Admission

Use only the least aligned ceilings that cover the measured feature, rather
than applying a fresh x1.25 allocation. Each change is below 0.5% of its incoming
ceiling and is included in this feature PR, not a separate budget PR.

| Ceiling | Before | After | Increase | Headroom |
| --- | ---: | ---: | ---: | ---: |
| Server JS gzip | 336896 B | 337920 B | 1024 B (0.3040%) | 24 B |
| Client JS raw | 258048 B | 259072 B | 1024 B (0.3968%) | 186 B |
| Client JS gzip | 103424 B | 103936 B | 512 B (0.4950%) | 30 B |

One alignment step lower still fails each measured overage: server gzip 337664 B,
client raw 258560 B, and client gzip 103680 B. File-count ceilings, server raw,
Worker, CSS, startup, runtime performance, Lighthouse, and all other gates stay
unchanged. Shipping-oracle pins name only the measured new allocations and add
fixed exact-ceiling, one-byte-over, and off-axis negative controls. No existing
assertion, exclusion, or enforcement logic is removed or relaxed. Actual-artifact
probes also reject each one-step-lower ceiling and pass the admitted ceilings.

For calendar week 2026-W44 (Monday 2026-10-26 UTC), main's opening ceilings at
`2f9e60791d27378d4b07f0cfd615c8af86f04f76` were server gzip 334080 B, client raw
254976 B, and client gzip 102912 B. Including this admission, their week-to-date
increases are respectively 1.1494%, 1.6064%, and 0.9950%, all below 2%.

Merge-queue composition must remeasure the exact resulting tree. This is a size
admission only, not a waiver of runtime, accessibility, visual, or review checks.
