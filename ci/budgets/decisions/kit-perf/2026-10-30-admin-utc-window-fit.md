# UTC planning window fits the inherited Kit ceilings

No ceiling changes are needed. The feature now fits current main's budget
fragments after removing duplicate native filter and feedback renderers.

## Reproduction and attribution

Canonical commands are `npm run build --prefix web` and
`node ci/check-kit-perf.mjs --format json`, using Node v24.22.1 and both
committed lockfiles. Pristine main `a6b2ee88fd1e67d17aea1532fa1828b886d9f8a3`
and the feature composed with that main were built with identical dependencies.

The original failing CI composition had server raw 1207310/1205504 bytes and
client raw 258925/258560 bytes. Integrating current main alone did not repair
it: the local integrated feature still exceeded server raw and client raw/gzip.

| Metric | Pristine main | Integrated feature before repair | Final feature | Unchanged ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1206782 | 1209515 | 1206732 | 1207040 |
| Server JS gzip | 337547 | 335812 | 335661 | 337664 |
| Client JS raw | 259442 | 260004 | 257644 | 259584 |
| Client JS gzip | 103580 | 103764 | 102927 | 103680 |
| Server JS files | 116 | 116 | 116 | 126 |
| Client JS files | 53 | 53 | 53 | 55 |
| Client CSS raw | 2861 | 2861 | 2910 | 3072 |
| Client CSS gzip | 1019 | 1019 | 1037 | 1280 |
| Client CSS files | 2 | 2 | 2 | 4 |
| Worker entry raw | 2551 | 2551 | 2551 | 3584 |
| Worker entry gzip | 1219 | 1219 | 1219 | 1536 |

The final feature reclaims 2783 server raw bytes, 2360 client raw bytes and
837 client gzip bytes relative to its integrated, unrepaired tree. It is also
50 server raw bytes and 1798 client raw bytes smaller than pristine main.
The scoped notice foreground adds 49 CSS raw / 18 gzip bytes and still fits
unchanged CSS limits.

Cause: both SSR twins emitted the same native filter controls, options and
feedback, and Kit additionally compiled the inert form into client JS despite
`csr=false`. The existing escaped server-HTML boundary now supplies the shared
fields, actions, date controls and feedback to both inventories. All values
that reach HTML attributes/text are escaped; select vocabulary is fixed.
No dependency, parser authority, authorization, database read or route owner
was added or broadened.

The existing SSR admin group also co-compresses native loaders with their
renderers: the final `chunks/admin.js` grows 7946 raw bytes versus main, while
the corresponding loader entries shrink. This is regrouping, not an omitted
measurement: every generated server JS file remains included in the totals.
The renderer extraction removes duplicate emitted code and lets the client
prune unused filter/clear helpers. Conservative minification stays unchanged.

## Checks and limits

The final Kit build/budget passes every existing raw, gzip and file-count cap.
No fragment, quality threshold, startup limit, coverage floor or measurement
inventory is changed. There is no extra allocation to reconcile with other PRs.

Focused DB-free regressions passed 96 cases across eight files, with five
pre-existing browser-opt-in skips. The separate real Chromium suite passed
19/19 with no skips. New renderer-escaping and refusal-navigation regressions
were observed failing before their implementations and passing afterwards.
An initial inline foreground failed under the actual style-src policy
(Kit contrast 1.03:1). It was replaced with a narrowly scoped external CSS
rule, not a CSP relaxation. Final invalid-window notice contrast was measured
at 17.44:1 through both real stylesheet cascades, with the actual response
security headers, at both viewport widths.

The complete local `npm run check` did not finish within its 600-second bound;
its remaining processes were stopped. Disposable-DB verification could not
start because the approved test service did not resolve. These are not green
full-suite or SQL claims. Exact-head CI and independent review still gate merge.

Undo: revert the feature and shared-renderer extraction together. No budget
rollback or admission-history edit is needed because all ceilings are unchanged.
