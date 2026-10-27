# 2026-10-28 decision: measured admin chronology JS capacity on current main

Admit the measured bundle cost of the admin UTC chronology in
[PR #1954](https://github.com/TogetherWeOwn/two-web-next/pull/1954), without
changing its product behavior in this PR:

| Fragment / dimension | Old ceiling (B) | New ceiling (B) |
| --- | ---: | ---: |
| `kit/server-js.json` / server JS gzip | 336640 | 337152 |
| `kit/client-js.json` / client JS raw | 258048 | 258048 (unchanged, retained) |
| `kit/client-js.json` / client JS gzip | 103424 | 103680 |

These are the least fitting aligned ceilings, not the default measured
size x1.25 rule. Raw uses the documented 512B step; gzip uses 256B steps.
Only server gzip and client gzip change; the higher merged client raw ceiling
is preserved, not lowered. Server raw/file count, client file count, worker,
client CSS and startup ceilings stay unchanged. No checker, dependency,
product source, legacy history, exclusion or quality floor changes.

This supersedes the 336896 / 257536 / 103680 proposal measured on the older
base: main has since admitted the unrenderable-time server step (336640) and
the event-detail client pair (258048/103424). The old client raw rung would
now be a downgrade below a merged allocation, so it is dropped.

## Frozen inputs and repeated builds

Node 24.22.1, npm 11.19.1, committed root and web lockfiles (byte-identical
across all trees), production Vite builds. Dependencies were installed once
from the locked manifests and copied verbatim into each tree. Each input was
built independently with `npm run build --prefix web`, then measured with
`node ci/check-kit-perf.mjs`. Gzip is the sum of individual file gzip sizes,
not compression of concatenated output.

- Pristine main: `def3274b31fd63de16924252ab4ad3be626e491c`.
- Exact feature head: `f30927cf1505e67f8900d503943ab1239fca8fe4`
  (unchanged since the prior measurement; only the base moved).
- Clean main-plus-feature tree from an uncommitted
  `git merge --no-commit --no-ff` (no conflicts; neither source branch was
  moved): `969ddea813e86321c75217867aa87e73d955431a`.

| Input | Server gzip, builds (B) | Client JS raw (B) | Client JS gzip (B) | Original gate |
| --- | ---: | ---: | ---: | --- |
| Pristine main (2 builds) | 336637 / 336634 | 256819 | 103102 | exit 0 |
| Main plus feature (4 builds) | 337042 / 337045 / 337041 / 337042 | 257805 | 103667 | exit 1, server gzip and client gzip exceed their caps |

Combined worst composition: server gzip 337045, client raw 257805, client
gzip 103667. Client bytes are bit-deterministic across all four builds;
server gzip rebuild jitter is at most 4B. The composed server has 116 files /
1193783 raw bytes; client JS has 55 files, exactly at its file ceiling.
Worker remains 2551 raw / 1219 gzip bytes, and client CSS remains two files /
2861 raw / 1019 gzip bytes. All unchanged dimensions fit.

Per-file attribution (content-hash diff of the built trees): server growth is
+1439 raw / +408 gzip, of which `chunks/admin.js` is +1367 / +393 with the two
admin route nodes +36 / +9 each (109 of 116 files byte-identical). Client
growth is +986 raw / +565 gzip: the two admin route nodes change, one new
shared chunk adds 346 / 262, and the app entry re-hashes at +30 / +14 (48 of
55 files byte-identical).

## Least-cover and real-artifact boundary proof

On the fourth main-plus-feature build, change only the target cap in an
isolated scratch fragment, keeping the other axes at the proposed ceilings.
Run the real checker on the same built artifacts for each case (artifact:
337042 / 257805 / 103667), then restore the fragments byte-for-byte:

| Axis | Main cap: exit 1 | Old proposal: exit 1 | Measured-minus-one: exit 1 | Exact measurement: exit 0 | Proposed cap: exit 0 | Headroom (B) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Server gzip | 336640 | 336896 | 337041 | 337042 | 337152 | 107 |
| Client raw | 258048 (fits, kept) | 257536 | 257804 | 257805 | 258048 | 243 |
| Client gzip | 103424 | n/a (same rung) | 103666 | 103667 | 103680 | 13 |

All 14 controls behave as expected, including rejection of the superseded
336896 server rung and the old 257536 raw rung, and admission of the exact
measurements. The full build fits after applying the proposed JS fragments
(exit 0).

Thin-margin disclosure: client gzip headroom is 13B and client files sit
exactly at the 55-file ceiling. Both values are deterministic across four
builds with no observed jitter on this axis, but the next client growth of
any kind re-opens this fit.

The feature's import-free shared timestamp adapter and conditional semantic
`time` markup add readable UTC labels while retaining exact machine instants
and a per-row unavailable-time fallback. The bounded guidance explains that
response updates are not attendance or original waitlist join times. Removing
that fallback or rendering raw ISO strings to fit would undo the feature's
acceptance criteria. This allocation does not authorize unrelated growth;
equivalent simplification remains preferable to extra capacity.

## Shipping tests and scope

`ci/check-kit-perf.test.mjs` already pins the 258048 raw and 103680 gzip
ceilings with exact-ceiling cases, but its server map ends at 336896: the
test owner must add the 337152 interval/exact/one-byte-over literals and the
exact-ceiling case. `ci/budget-fragments.test.mjs` must coevolve to admit
server gzip 337152 and pin the measured client pair 258048/103680, retaining
prior server allocations, unsupported-allocation controls, off-axis drift
checks and frozen-history hashes. The test owner supplies those corrections
before this PR becomes ready; the implementer does not rewrite acceptance
tests.

The real-artifact controls preserve exit 0 (fits), 1 (breach), and the
unchanged selftests preserve exit 2 (cannot enforce). No page behavior,
security/data policy, runtime latency, staging verification or deployment is
claimed here. This capacity decision still requires exact-head CI and
independent review. A sibling landing first requires remeasurement against
its new main, not addition of nominal allowances. Undo: revert this focused
allowance PR and its matching oracle corrections.
