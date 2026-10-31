# Kit outage-header CTA on current main

Kit error pages for 403, 429, 500 and 503 now render Hono's invite
"Open Discord" header CTA instead of the default "Sign in with Discord"
OAuth start, which is dead or loops during those outages. The only
source change is one header snippet and its wiring in
`web/src/lib/ErrorShell.svelte`. The 404 search form already shipped on
main (#1483), so it adds no bytes here. No dependency, file-count, CSS,
worker, startup or user-facing speed target changes; server and client
file counts stay 116 and 53.

## Measurements

Canonical builds are `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs --format json`, on Node v24.21.0. Main
`2e55cb1e` and the composed feature were built in the same tree, the
feature twice.

| Metric | Composed build 1 / 2 | Main | Main ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1207118 / 1207116 | 1206784 | 1207040 | 1207552 |
| Server JS gzip | 337619 / 337619 | 337546 | 337664 | 337664 (unchanged) |
| Client JS raw | 259746 / 259746 | 259442 | 259584 | 260096 |
| Client JS gzip | 103695 / 103695 | 103580 | 103680 | 103936 |

The feature costs +334 server raw, +304 client raw and +115 client gzip.
Error routes stay `csr = false` and never hydrate, but SvelteKit still
emits the ErrorShell chunk. Shortening the source comment and inlining
the status list saved only 32 server and 4 client bytes, so the shipped
source keeps the explanation.

## Sizing

Least-cover aligned steps on each breached axis, not 25% headroom:

- Server raw 1207040 -> 1207552: +512 bytes; margin 434 bytes.
- Client raw 259584 -> 260096: +512 bytes; margin 350 bytes.
- Client gzip 103680 -> 103936: +256 bytes; margin 241 bytes.

Main's ceilings reject the composed build by 78, 162 and 15 bytes.
Server gzip fits unchanged with 45 bytes of margin. Each raise is under
0.25% and admits this product feature inside its own PR. No gate,
coverage floor, file-count cap or user-facing performance target is
changed or bypassed. Exact-head CI must remeasure composition with later
features.

## Enforcement

Both shipping oracles keep every earlier allocation and add server raw
1207552 and the client pair 260096/103936. Fixed fixtures accept the
measured sizes and exact ceilings, and reject one byte over each.

Undo: revert the ErrorShell change, these fragment and oracle edits and
this decision together.
