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
`node ci/check-kit-perf.mjs`, on Node v24.21.0. The feature merged into
main `c0fadacb` was built twice with the same dependencies. Main's server
figures are the #1974 composed builds of `GET /version`, which `c0fadacb`
ships; client figures are main `219c532a`, since #1974 changed no client
output.

| Metric | Merged build 1 / 2 | Main | Main ceiling | Feature ceiling |
| --- | ---: | ---: | ---: | ---: |
| Server JS raw | 1207652 / 1207650 | 1207318 | 1207552 | 1208064 |
| Server JS gzip | 337793 / 337795 | 337718 | 337920 | 337920 |
| Client JS raw | 259746 / 259746 | 259442 | 259584 | 260096 |
| Client JS gzip | 103695 / 103695 | 103580 | 103680 | 103936 |

The feature costs +334 server raw, +77 server gzip, +304 client raw and
+115 client gzip. An earlier cut of this PR raised server raw to 1207552
and server gzip to 337920 on main `219c532a`; #1974 then claimed the same
two steps for `GET /version`, and the composed build crossed server raw
by 100 bytes while still fitting server gzip.
Error routes stay `csr = false` and never hydrate, but SvelteKit still
emits the ErrorShell chunk. Shortening the source comment and inlining
the status list saved only 32 server and 4 client bytes, so the shipped
source keeps the explanation.

## Sizing

Least-cover aligned steps on each breached axis, not 25% headroom:

- Server raw 1207552 -> 1208064: +512 bytes; margin 412 bytes.
- Server gzip stays 337920; margin 125 bytes.
- Client raw 259584 -> 260096: +512 bytes; margin 350 bytes.
- Client gzip 103680 -> 103936: +256 bytes; margin 241 bytes.

Main's ceilings reject the merged build by 100, 162 and 15 bytes on the
three raised axes. Each raise is under
0.25% and admits this product feature inside its own PR. No gate,
coverage floor, file-count cap or user-facing performance target is
changed or bypassed. Exact-head CI must remeasure composition with later
features.

## Enforcement

Both shipping oracles keep every earlier allocation and add server raw
1208064 and the client pair 260096/103936. Fixed fixtures accept the
measured sizes and exact ceilings, and reject one byte over each.

Undo: revert the whole PR. The ErrorShell change, these fragment and
oracle edits, this decision and
`test/kit-outage-header-404-search-acceptance.test.ts` go together. That
test expects "Open Discord" on 403, 429, 500 and 503, so it fails
against the restored sign-in header if it stays behind.
