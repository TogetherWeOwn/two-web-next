# Event host and joining details on the current base

PR #1825 carries existing host and joining information into the Kit detail
view. It also shares the existing joining-URL entry policy with both renderers:
legacy malformed or non-HTTP(S) URLs remain escaped text, not active links.
No dependency, asset-count, CSS, startup, or user-facing speed-target changes
ship. The old branch's obsolete 256512-byte proposal is not restored.

## Frozen inputs and repeated measurements

The initial rebuild used main `789e8a664abc9ad7f1aaccfe2dd5556380980184`.
On that base, three feature builds measured server gzip 336851 / 336849 /
336850, client raw 258282 and client gzip 103538. Base alone measured server
gzip 336631 and client raw/gzip 256819/103102. A server ceiling of 336896
and client ceilings 258560/103680 covered that composition.

While verification ran, #1869 landed on main
`728b70054b50623e921ee8da1c8ad92132772a15`. This feature was rebased onto it,
preserving its server allocation, history, and admission tests. That first
composition measured server gzip 337015 and client raw/gzip 258565/103629:
server 336896 failed by 119 bytes, and client 258560 failed by 5 bytes.

The URL predicate's explicit empty-string comparisons were replaced with
boolean checks on URL's string properties, preserving the same protocol,
hostname, credential, and malformed-input policy. This saves 11 client bytes
and avoids a second client-raw step. Final repeated canonical builds use
Node v24.21.0 and locked dependencies:
`npm run build --prefix web`, then
`node ci/check-kit-perf.mjs --format json`.

| Metric | Final build 1 | Final build 2 | Current main ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS gzip | 337010 | 337011 | 336896 | 337152 |
| Client JS raw | 258554 | 258554 | 258048 | 258560 |
| Client JS gzip | 103627 | 103627 | 103424 | 103680 |

Server raw is 1195480 (ceiling 1203200); server/client file counts stay
116/54 (ceilings 126/55); client CSS stays 2861 raw / 1019 gzip. Every group
passes. The URL predicate is shared, not copied or imported through moderator
form parsing into the client. Svelte also shares one paragraph around its
link/plain-text alternatives.

## Least-cover sizing and bounded admissions

Use one aligned step on each breached current-main axis, not 25% headroom:

- Server gzip 336896 -> 337152: +256 bytes, 0.0760%; worst margin 141 bytes.
- Client raw 258048 -> 258560: +512 bytes, 0.1984%; margin 6 bytes.
- Client gzip 103424 -> 103680: +256 bytes, 0.2475%; margin 53 bytes.

The client raw margin is intentionally thin but byte-identical on repeated
builds. The old current-main ceilings reject the final worst build by 115,
506, and 203 bytes respectively. All steps are product-feature admissions in
the feature PR, not a standalone budget change. Even counting the server
increase conservatively from the original rebuild's 336640 ceiling to the
final 337152 ceiling, the aggregate per-PR increase is only 0.1522%.

For the calendar week beginning 2026-10-26, the last preceding main commit
`2f9e60791d27378d4b07f0cfd615c8af86f04f76` has server gzip 334080, client raw
254976, client gzip 102912. Including this admission, weekly increases are
0.920%, 1.406%, and 0.746% respectively, each below 2%.

Exact-head CI and the merge queue must remeasure composition with later
features. No gate, coverage floor, file-count cap, or class-A performance
target is changed or bypassed.

## Enforcement

Both shipping oracles retain every previous approved allocation and rejection
fixture, including #1869's 336896 allocation. They additionally admit server
gzip 337152 and the client pair 258560/103680. Fixed literal fixtures accept
the newly allowed intervals and exact ceilings, and reject server 337153,
client raw 258561, and client gzip 103681. The fragment oracle still rejects
one-byte drift and mismatched client pairs. The combined allocation test was
observed failing under each prior oracle before admission was implemented.

Undo: revert this feature's fragment changes, oracle additions, and decision
together. Reverting the feature removes the reason for its allocation; retain
other features' independently shipped allocations.
