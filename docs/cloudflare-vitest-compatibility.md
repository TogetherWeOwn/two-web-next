# Cloudflare Workers Vitest compatibility spike

Research snapshot: 2026-11-15. This is source research, not a compatibility test
of this application. No plugin experiment was executed for this spike.

## Baseline and upstream evidence

The root lockfile resolves Vitest and `@vitest/coverage-v8` to 5.0.5 and
Wrangler to 4.156.1. Neither `@cloudflare/vitest-plugin` nor its predecessor
`@cloudflare/vitest-pool-workers` is locked. The root `vitest.config.ts` does
not configure the Workers plugin; the current Node suite and its coverage floors
are not evidence that a Workers-runtime suite passes.

[workers-sdk #15618](https://github.com/cloudflare/workers-sdk/issues/15618)
reports that the old pool 0.22.0 failed to start with Vitest 5.0.0; the reporter
said Vitest 4.1.11 passed in that reproduction. The issue closed on 2026-11-12.
It is a historical report, not proof that current plugin versions fail.
Cloudflare [renamed the package](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/)
to `@cloudflare/vitest-plugin`. Its [changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-plugin/CHANGELOG.md)
records Vitest 5 support in 1.4.0 ([upstream PR](https://github.com/cloudflare/workers-sdk/pull/16132))
and fixes for Vitest filesystem module caching and Vitest 5.0.4 V8 coverage in
1.4.3. The registry's `latest` metadata inspected for this spike declared
plugin 1.8.2's Vitest peer range as `^4.1.0 || ^5.0.0` ([metadata](https://registry.npmjs.org/%40cloudflare%2Fvitest-plugin/latest)).
A declared peer range is not evidence of compatibility with this repository's
configuration, dependencies, mocks, bindings or coverage requirements.

## Fallback and next experiment

Keep the existing suite and coverage gates intact. For HTTP/browser journeys,
the existing [local Worker and Playwright CI lane](critical-journeys.md#ci-isolation)
is a practical fallback: its dedicated Wrangler config, disposable CI database,
synthetic credentials and outbound isolation matter. `wrangler dev --local` plus
Playwright exercises the running app over HTTP; unlike the
[Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/),
it does not by itself provide in-runtime unit execution, direct binding access,
or equivalent per-test state isolation. Do not treat one as proof of the other.
Local mode alone is not proof every binding is local: inspect configuration and
avoid remote bindings and real services.

Before adopting the plugin, use a separately reviewed dependency change and a
bounded GitHub Actions experiment with an explicitly pinned plugin and Vitest
pair. Inventory peer and transitive versions, scripts, integrity, provenance,
release age and audit findings under the repository's supply-chain controls.
Use a minimal Workers fixture with no remote bindings, secrets or database;
assert an actual nonzero test count, a Worker-runtime response and a controlled
binding/state-isolation case. Exercise the required mocking and V8 coverage
behavior before proposing any migration of existing tests. Record exact versions,
configuration, head SHA, run/job URLs and full pass/fail or skipped outcomes.
Compare against the existing local Wrangler/Playwright lane without weakening
its tests or replacing the root coverage gate. Expand only after the fixture
passes and its limits are understood. No staging or production access is needed.

Cloudflare also documents a [test harness and Playwright integration](https://developers.cloudflare.com/workers/testing/test-harness/integrations/)
worth evaluating separately; it is not a result of this spike. REA angle: the
open-source Workers SDK and existing local e2e configuration expose the relevant
implementation and alternatives, so proprietary reverse engineering is unnecessary.
