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

## Accepted staged delivery: local diagnostic, not provider validation

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

No deployment, upload or production probe was run. The delivery-sequence decision
now accepts **diagnostic-first staged delivery**, not a substitution for provider
startup acceptance. Authoritative `startup_time_ms`: **unavailable**. Production
margin under the provider's startup limit: **unmet**. Neither is passed by proxy.

`node ci/check-worker-startup.mjs` builds the adapter anew, serializes one staging
configuration upload with `wrangler deploy --dry-run --outfile`, then runs exactly
three fresh `wrangler check startup` processes over that same upload. Each creates
a fresh Miniflare and dynamically imports the module once; no warmed import or
retry replaces a slow run. Only `(idle)` samples are excluded. GC, wrapper,
import, request and response work remain included. Sample node IDs and deltas
must pair exactly; microseconds are converted to milliseconds.

`ci/worker-startup-budget.json` gates the maximum of all three
`local_startup_non_idle_sample_ms` values: warning **>=400 ms**, failure
**>=700 ms**. Exit 0 is a local pass/warning, 1 is a local breach, 2 is unavailable
or invalid evidence. Tool versions must match the pinned diagnostic budget.
The controlled Linux x64 Node 24 runner uses the immutable image
`node:24-bookworm@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413`.
The CI container selection and diagnostic image identity must match. Local
integrations use that same image and set `STARTUP_RUNNER_IMAGE` to its full ref;
an arbitrary host run without it is unavailable. The OS-release content hash,
CPU model/count, memory, kernel, Node and local/CI class are retained.

Cgroup v2 ancestry is visible through the read-only hierarchy with
`--cgroupns=host`: every ancestor's `cpu.max`, controller availability/enabling
and effective cpuset are recorded alongside process CPU affinity. Effective
quota is the tightest ancestor quota, and effective CPU count is bounded by
both quota and affinity. Unlimited is explicit and verified, not inferred from
a missing file: absent per-cgroup limits require proof that the parent's
controller is disabled (the hierarchy root has no parent quota). Root process
membership is rejected: a private cgroup namespace can otherwise hide ancestor
quotas behind a seemingly complete root mount. Membership is parsed component by
component without nested regex repetition, so bounded malformed paths cannot
trigger exponential backtracking. Subtree mounts, unknown/malformed
quota/cpuset/controller/affinity evidence, cgroup v1 and missing required files
fail closed. Reads are capped at 16 KiB and ancestry at 64 levels;
runner facts must still match after profiling. Local and CI observations are not
interchangeable trends.
This is not per-thread CPU, an authoritative Cloudflare measurement, or proof of
300 ms production headroom.

The output directory must be new (default `artifacts/worker-startup-local`, or
`--outdir artifacts/<new-name>`). Retain all three original `cold-N.cpuprofile`
files and their numeric `cold-N.json` records, plus `report.json` and `summary.md`.
The report binds source commit and actual tracked/unignored source content,
both lockfiles, exact staging config, serialized upload and profiles by SHA-256;
it also records tool implementation/binary hashes, versions, runner identity,
commands and bounds. Failed/incomplete runs never yield a local pass. No raw
child output, environment dump, serialized upload or binding values are published
to the CI artifact. The summary explicitly preserves outstanding provider
acceptance on success, warning, breach and unavailable evidence.

Each build is bounded to 240 seconds, serialization to 60 seconds, and each
profile to 30 seconds, with 2 MiB child-output caps and process-group cleanup.
Profiles are limited to 8 MiB, 50,000 nodes, 100,000 samples and a 15-second window.
Missing, non-finite, malformed, incomplete, mismatched, wrong-build/tool,
failed and timed-out evidence fails closed. Sample timestamps are rebuilt from
`startTime + cumulative timeDeltas` and must stay within the inclusive profile
window, without clamping. V8 `15.7.112.5` in pinned workerd `1.20261101.1`
drains samples by code-event id rather than timestamp (see
[`SamplingEventsProcessor::ProcessOneSample`](https://github.com/v8/v8/blob/15.7.112.5/src/profiler/cpu-profiler.cc)
and [workerd's V8 pin](https://github.com/cloudflare/workerd/blob/v1.20261101.1/build/deps/v8.MODULE.bazel)).
Small timestamp reversals are accepted only up to 1,000 us each and
`min(3, floor(0.02 * sample count))` per profile; fewer than 50 samples allow none.
Samples are stable-sorted by timestamp, with each sorted interval charged to
that sample's node as before. Sampled time remains the raw delta sum, and the
`sampledUs <= windowUs + 1000` check is unchanged. Each numeric run and the human
summary report `reversals` and `maxReversalUs`. Larger, excessive or out-of-window
reversals fail with the offending sample index; no samples are replaced or retried.
Pinned Wrangler only rejects module
failure when unsupported bindings exist, so upload admission deliberately requires
an unsupported Hyperdrive binding; a future change must replace this failure
proof, not silently drop it. Local environment/dotenv binding inclusion and
Wrangler telemetry are disabled. Both Wrangler invocations additionally receive
`--env-file` pointing to a newly created, read-only empty file; the real pinned
CLI's global dotenv loader otherwise restores runtime overrides independently
of its development-binding setting. The file stays empty before/after each
invocation, its empty-content hash is recorded, and actual executable/argv/cwd
are bound to the report. A real-loader fixture proves ignored `.env` and
`.env.local` cannot select an alternate owned runtime. Runtime override variables (including
`MINIFLARE_WORKERD_PATH`, V8 flags, Node preloads and alternate esbuild paths)
are removed before spawning. `checkpoint.json` persists source/tool/runner
identity before the build, upload identity before profiling and every completed
numeric run; unavailable reports refer to that checkpoint instead of losing the
failed attempt's provenance. SIGINT/SIGTERM cancellation kills the owned process
group immediately, including grandchildren; pipe cleanup is bounded to one
second. Cancellation is sticky and cannot produce pass evidence or begin a
replacement invocation. Signal listeners are removed when each command settles.

## Three-cold-run integration observation

A fresh offline build and one serialized upload produced **68.736, 70.715 and
103.422 ms**; the maximum **103.422 ms** passed the local diagnostic. These were
real profiles, not unit-test fixtures. Runner: Linux x64, Node 24.21.0, AMD Ryzen
9 9950X, 32 logical CPUs; the JSON artifact retains the full bounded runner facts.
Upload SHA-256: `d5da9a25faca4445096c8bab2bf03114de85b6f33dd1cc5d3d23c64d0098158a`.
Actual source inventory SHA-256:
`b6ee7367bdebc0abf36e3a4126331aa22631ceb4e876fd3c35a01249e98d963b`.
This observation predates the subsequent provenance/checkpoint hardening; the PR
also records its final-head integration separately. No provider acceptance is
claimed from either local observation.

An initial implementation attempt rejected a valid 15.393 ms unsampled profile
tail using an invented 10 ms gap cap. That attempt remained unavailable and its
original evidence was retained. The regression now explicitly preserves the
unsampled tail in `unsampledMs`, without adding it to the non-idle sample metric.
No breach was retried or slow completed profile discarded to obtain a pass.

CI runs the diagnostic as the Kit adapter build in the existing hard `check` job,
then uploads all profiles/numeric evidence on success or failure for 14 days.
The upload and worker fixture remain offline; the independent readiness timeout
and every hard visitor-facing/raw/count/whole-Worker gate remain unchanged.
Security and QA review, CI, and exact-head production merge approval still apply.
The earlier single-profile numbers above establish tool feasibility only; they
are not the required three-run implementation integration evidence.

Undo: revert this change to restore server gzip hard failures and remove the
local diagnostic/check wiring; do not change any client/Worker ceiling or the
independent server-readiness timeout.
