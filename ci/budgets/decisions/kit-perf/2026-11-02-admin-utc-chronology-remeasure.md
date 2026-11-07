# Resilient UTC roster and activity times, remeasured after review hardening

`2026-11-01-admin-utc-chronology.md` admitted the composed roster-plus-
activity stack at server 1212416/339200 and client 261632/104704, measured
while the shared adapter (`src/admin/chronology.ts`) was still in its first
form. Review then hardened the adapter's no-fabrication contract: written
components are calendar-validated before a `Date` is built (V8 normalizes
2026-02-30 to March 2, so impossible dates must be refused, not rendered),
expanded years keep their seconds, minute-precision zoned instants are
validated, and `24:00` is refused with a stated rationale. The adapter grew
from 1359 to 3125 source bytes and outgrew the 43-byte server-raw margin the
first admission shipped with. This decision remeasures the same composed
stack; it moves no gate, file-count cap or user-facing performance target.

## Measurements

Canonical builds are `npm run build --prefix web`, then
`node ci/check-kit-perf.mjs`, on Node v24.21.0. The roster head alone was
built twice locally and the composed stack three times; exact-head CI on
the stack agrees within 2 bytes on every axis.

| Metric | First-admission build (stack) | Roster head, two builds | Stack local / CI | Old ceiling | New ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| Server JS raw | 1212373 | 1212789 / 1212791 | 1213135 / 1213133 | 1212416 | 1213440 |
| Server JS gzip | 339026 | 339298 / 339297 | 339319-339320 / 339318 | 339200 | 339456 |
| Client JS raw | 261380 | 261536 | 261850 | 261632 | 262144 |
| Client JS gzip | 104463 | 104514 | 104682 | 104704 | 104704 (unchanged) |

Since the first admission the composed stack grew +762 server raw, +294
server gzip, +470 client raw and +219 client gzip (0.06%, 0.09%, 0.18% and
0.21%). The growth is the hardened adapter shipping in the server admin
chunk and the shared client chunk; the adapter still has no imports, so no
dependency ships with it. The breach surfaced only now because earlier
stack heads failed an earlier step of the same `check` job (an unrelated
expired test fixture, since fixed on main) before the Kit performance step
ran.

## Sizing

Least-cover aligned steps on each breached axis, as before:

- Server raw 1212416 -> 1213440: +1024 bytes (0.084%); margin 305 bytes
  over the worst build. The lower 512-byte step 1212928 rejects the worst
  build by 207.
- Server gzip 339200 -> 339456: +256 bytes (0.075%); margin 136 bytes.
  The previous ceiling rejects the worst build by 120.
- Client raw 261632 -> 262144: +512 bytes (0.196%); margin 294 bytes.
  The previous ceiling rejects the worst build by 218.
- Client gzip stays 104704: the worst build is 104682, margin 22 bytes.
  This axis is not breached, so least-cover discipline leaves it alone;
  the local and CI builds above agree within 2 bytes on every axis, and
  exact-head CI remeasures every later composition.

The roster head alone also breaches the old server ceilings (worst build
1212791/339298), so the admission stays in the roster PR admitting the
composed stack, exactly as the first decision set out. Each raise is under
1% and admits this product feature's own review hardening inside its own
PR stack.

## Enforcement

Both shipping oracles keep every earlier allocation (including the first
admission's 1212416/339200 and the client pair 261632/104704) and add
server raw 1213440, server gzip 339456 and the client pair 262144/104704.
Fixed fixtures accept the measured sizes and exact ceilings, and reject
one byte over each.

Undo: revert this admission commit. The server and client fragments, this
decision and the oracle additions go together; the roster and stacked
activity PRs then re-measure against the restored ceilings.
