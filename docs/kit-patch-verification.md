# Kit and Cloudflare adapter patch verification

Source and registry verification: 2026-11-03. This records a defensive patch
update, not proof of a particular advisory's applicability or remediation.

## Selected releases

| Package | Previous exact pin | Selected exact pin | Official release |
| --- | --- | --- | --- |
| `@sveltejs/kit` | `3.1.0` | `3.1.1` | [Kit 3.1.1](https://github.com/sveltejs/kit/releases/tag/%40sveltejs/kit%403.1.1) |
| `@sveltejs/adapter-cloudflare` | `8.0.1` | `8.0.2` | [Adapter 8.0.2](https://github.com/sveltejs/kit/releases/tag/%40sveltejs/adapter-cloudflare%408.0.2) |

These are the next patch releases, published upstream on 2026-10-29. They do
not change the framework major or require a Svelte upgrade: Kit's published
Svelte peer range is `^5.57.1`, which includes the retained `5.57.2` pin.
Only `web/package-lock.json` contains these packages; the independent root
lockfile is unchanged. The `sharp` and `undici` overrides are retained.

The existing [dependency PR #2025](https://github.com/TogetherWeOwn/two-web-next/pull/2025)
contains both updates and a separate Svelte patch. This narrower patch also
supplies source/applicability evidence, lock-coherence tests and the SSR
co-compression needed to retain the existing bundle limits. It must be
reconciled with that PR rather than landed as a second independent bump.

## Advisory discrepancy

Unauthenticated GETs to both supplied advisory API URLs returned HTTP 404:

- <https://api.github.com/advisories/GHSA-m9j8-jcmv-hp69>
- <https://api.github.com/advisories/GHSA-5wg4-q3ww-283h>

The IDs, affected version ranges, trigger conditions and fixed-version
mapping could not be independently corroborated. A 404 is not evidence that
an advisory never existed, nor that the application is safe. Do not describe
these references as confirmed exposure or claim that this update verifies
remediation for them. The official release changes below are independently
inspectable without that claim.

## Upstream source and local applicability

| Upstream change | Source | Local applicability |
| --- | --- | --- |
| Return 400 for malformed paths rewritten by `reroute` | [Kit commit](https://github.com/sveltejs/kit/commit/1d21a3b0beca23f044f02789926e011a904f8959) | No application `reroute` hook is configured. |
| Parse remote form submissions in linear time | [Kit commit](https://github.com/sveltejs/kit/commit/d593e7e8960cd7e97e81cb834d7fa5c56d821944) | No application remote-function modules or `$app/server` imports were found. Existing HTML forms and reserved writes still use Hono. |
| Construct a validated absolute route-resolution import URL | [Kit commit](https://github.com/sveltejs/kit/commit/dd63fd1a2e52221e2024e3c59d6d15f7f0afca64) | No server-side router-resolution mode is configured, and current page families disable CSR. Retain the upstream defense without claiming a reproduced trigger. |
| Guard browser imports of server-only modules through parameter matchers | [Kit commit](https://github.com/sveltejs/kit/commit/ae07803806f75b8b5662ae4ab92934ca1356fd84) | No application parameter-matcher modules were found. This is still a useful build-time boundary. |
| Encode generated redirect tokens and reject special rule syntax | [Adapter commit](https://github.com/sveltejs/kit/commit/4a62beeca491147c78849cd696907561a4c91692) | No application prerendering is configured. The observed Workers build emits neither `_redirects` nor `_routes.json`; this is not a demonstrated local exploit path. |

Inspection was source-first. No exploit reproduction, production probe or
staging database access was used. The root production entry remains Hono;
the existence of the Kit Worker does not establish a completed production
renderer cutover.

The Kit hook still binds `dispatchHookRequest`, Hono dispatch and the existing
session bridges. The deliberate `csrf.trustedOrigins` configuration remains
unchanged: its documented replacement is the hardened hook's same-origin gate,
not permission to accept cross-origin writes. CSP, host admission, cookie
handling, route ownership and no-JavaScript forms are not relaxed.

## Package provenance

Both release tags resolve to upstream commit
`04aac59bad580f01ad08627e464c24f9f74401fe`. Registry provenance statements name
`https://github.com/sveltejs/kit`, `.github/workflows/release.yml`, that commit
and [release run 40975396478](https://github.com/sveltejs/kit/actions/runs/40975396478).
The subjects' SHA-512 digests agree with the selected lockfile integrity values.

- [Kit registry metadata](https://registry.npmjs.org/@sveltejs%2fkit/3.1.1)
- [Adapter registry metadata](https://registry.npmjs.org/@sveltejs%2fadapter-cloudflare/8.0.2)
- [Kit attestations](https://registry.npmjs.org/-/npm/v1/attestations/@sveltejs%2fkit@3.1.1)
- [Adapter attestations](https://registry.npmjs.org/-/npm/v1/attestations/@sveltejs%2fadapter-cloudflare@8.0.2)

`npm audit signatures --prefix web` verified 99 registry signatures and 55
attestations. `npm run deps:audit` passed the unchanged repository policy.
A plain `npm audit --prefix web --json` exited 1 with four low-severity entries
through unchanged `deepmerge` (`GHSA-gcqx-w48m-w2h4`, affected range
`>=4.2.0 <=4.3.1`). Those are not a clean audit or a new waiver. Do not run
`npm audit fix --force`: its suggested downgrade is outside this patch.

## Bundle compatibility

The two dependency updates alone exceeded the existing server-JS budget:
1,221,023 raw bytes against 1,220,608, and 341,259 gzip bytes against 341,248.
Co-compressing the existing hot-zone Hono/Kit renderers and shared board
helpers in the existing SSR profiles group reduced that to 1,220,229 raw and
339,305 gzip bytes. No threshold, minification safety setting, license-comment
policy or client grouping was changed. Client JS stayed at 261,259 raw and
104,338 gzip bytes; the generated Worker stayed at 2,551 raw and 1,219 gzip.

The AST chunk-boundary tests cover the added group matches and exclusions.
The dependency-pin tests enforce stable same-major patch floors, manifest/lock
agreement, public registry resolution and retained independent overrides.
Runtime fixture suites and the disposable Postgres gate remain necessary;
these static tests do not establish advisory applicability. The PR verification
section records the actual commands, results and any remaining limitations.
