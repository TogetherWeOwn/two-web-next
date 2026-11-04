# Separate server compression warnings from runtime enforcement

## Decision

Summed per-file Kit server gzip is advisory. It changes when a bundler regroups
chunks even if the code has not shrunk, so it is not a sound runtime CPU gate.
Only `kit.server.js` gzip overages warn: human stderr names the overage, JSON
reports `status: "warn"` and a top-level `warnings` array, and a gzip-only
overage exits 0. Combined raw/file breaches still exit 1 and retain the gzip
warning. Invalid budgets, missing/unreadable files and incomplete inventories
still exit 2. Numeric ceilings are unchanged.

Kit server raw bytes and file count, client JS/CSS raw/gzip/count, Kit Worker
entry raw/gzip and `ci/worker-bundle-budget.json` remain hard. No product,
content, accessibility aid, design, security header or test was removed. No
chunk regrouping is claimed as savings.

## Real build evidence

Source commit: `10099ce45e7f6a4f1ade945bbbca85278982109e`. Node: `24.21.0`.
`npm run build --prefix web` and `node ci/check-kit-perf.mjs --format json`
completed on 2026-11-04. The checker changes affect no build input:

| Group | Measured raw / gzip | Files | Existing raw / gzip ceilings | File ceiling |
| --- | --- | --- | --- | --- |
| Kit Worker entry | 2,551 / 1,219 B | 1 | 3,584 / 1,536 B | canonical entry |
| Kit server JS | 1,220,480 / 341,055 B | 116 | 1,220,608 / 341,248 B | 126 |
| Kit client JS | 261,250 / 104,332 B | 54 | 261,632 / 104,448 B | 55 |
| Kit client CSS | 2,861 / 1,019 B | 2 | 3,072 / 1,280 B | 4 |

These before/after bytes are identical; this is a policy boundary change, not
a byte reduction. Fixture boundary tests are separate from these observations.

## Startup measurement: unresolved, not accepted

The existing `ci/budgets/kit/startup.json` value of 60,000 ms remains the
Playwright server-readiness timeout. It is not isolate startup CPU.

REA angle: inspect the pinned shipped Wrangler profiler and run it against the
actual adapter build before inventing a replacement metric.

Wrangler `4.156.1`, its Miniflare `5.20261101.0-beta` and workerd
`1.20261101.1` successfully profiled the built staging-config Worker offline:

```sh
npm run build --prefix web
WRANGLER_SEND_METRICS=false npx wrangler deploy \
  --config web/wrangler.staging.jsonc --dry-run \
  --outfile artifacts/worker-startup/worker.bundle
WRANGLER_SEND_METRICS=false npx wrangler check startup \
  --worker artifacts/worker-startup/worker.bundle \
  --outfile artifacts/worker-startup/startup.cpuprofile
```

Observed profile window: 86.233 ms; sampled time: 86.210 ms; non-idle sampled
time: 56.919 ms; idle: 29.291 ms; GC: 4.220 ms; sample count: 57.
Upload bundle SHA-256:
`0b7959e58007d6c57c9f10bac02975807a48ff45acb688a03b43c99ae62997ee`.
Worker entry SHA-256:
`aee1a513dd9570c5a915eceee8394635baa4337cedf8f377a3b4fc5f155bfe61`.

[Wrangler's pinned profiler source](https://github.com/cloudflare/workers-sdk/blob/ca55031d783d1c062c9d2437f3be39addab235ec/packages/deploy-helpers/src/startup-profile.ts)
starts Miniflare before the profiler, then dynamically imports the built module
on a synthetic request. Its summary sums V8 `timeDeltas` and subtracts idle
samples. This is real local module-evaluation profiling, not npm/Miniflare
process startup or Playwright readiness. It is also not the provider's
validation `startup_time_ms`, a per-thread CPU clock, or proof of 300 ms
headroom under the provider's 1,000 ms startup limit.

[Cloudflare's startup command guidance](https://developers.cloudflare.com/workers/wrangler/commands/workers/#startup)
explicitly cautions against treating local profile duration as the deployment
startup duration. The [limit documentation](https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time)
reports authoritative `startup_time_ms` on deployment or versions upload.
The pinned [workerd limit interface](https://github.com/cloudflare/workerd/blob/v1.20261101.1/src/workerd/io/limit-enforcer.h)
provides startup-limit hooks, but the shipped offline Wrangler command does
not expose that provider measurement.

No deployment or production probe was run. The proposed warning at 400 ms and
failure at 700 ms have **not** been implemented against a substitute metric.
The measurement choice requires an explicit technical decision before adding
a dedicated startup budget/checker and CI summary/artifact wiring. This draft
must not be merged as completion of the combined server/runtime change while
that acceptance remains unresolved.

Undo: revert this change to restore server gzip hard failures; do not change
any client/Worker ceiling or the independent server-readiness timeout.
