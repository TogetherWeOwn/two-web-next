# Admin event input: seeded property coverage

Source: [TOG-10849](/TOG/issues/TOG-10849). Pure functions and local fixtures only;
no database, HTTP service or recurrence materialisation is involved.

## Reuse check

On 2026-09-30, [TOG-10789](/TOG/issues/TOG-10789) had a remaining-domain plan
but no per-behavior ledger or comments. Its plan reserves events/RSVP/feeds/jobs
and race acceptance and requires reuse of existing suites. This slice does not
replicate those route, database or race tests. `test/admin.test.ts` retains the
admin guard and CRUD examples; `test/admin-validation.property.test.ts` exercises
the previously untested pure input invariants.

## Reproduction and CI budget

```sh
npm ci --include=dev
# Unset inherited DB/service bindings; these properties only use local fixtures.
env -u DATABASE_URL -u REDIS_URL timeout 10s npm run test:admin-properties
env -u DATABASE_URL -u REDIS_URL npm run check
```

Every fast-check assertion uses seed **10849** and **100 runs**. Important boundary
and failing inputs are explicit examples, not left to random chance. The suite
contains 25 tests / 26 property assertions. Vitest prints the seed, shrink path
and counterexample on failure. CI runs the suite under a whole-process `timeout
10s` before migrations, and the ordinary `check` also discovers the file. The
first passing local run on Node 24.21.0 / Vitest 5.0.2 took **1.58 s**.

On 2026-10-01, [TOG-10853](/TOG/issues/TOG-10853)'s required
[check job](https://github.com/TogetherWeOwn/two-web-next/actions/runs/36824310965/job/110249434280)
exhausted this budget without an assertion result. About 4.2 s elapsed before
Vitest's `RUN` banner; the same test tree passed on another runner. The precise
host slowdown was not established. To preserve the 10 s gate, `wallToUtc` now
reuses one formatter within each conversion instead of constructing six for
its offset samples. It does not cache between requests or change validation.
The unchanged 25 properties (seed 10849, 100 runs and all boundary examples)
passed three local whole-process runs before (**3.63 / 3.51 / 2.95 s**) and after
(**1.63 / 1.40 / 1.48 s**) this optimization. A separate formatter regression
pins the construction count and fold/unknown-zone behavior. Runner startup
remains outside that optimization; exact-head CI is still required.

## Coverage matrix

| Invariant | Generator / independent oracle | Boundary coverage |
| --- | --- | --- |
| Wall → UTC → wall | Minute instants in 2020–2035; runtime IANA zone list plus UTC; independent `Intl` h23 renderer | Both space and T naive separators; fractional-offset and southern zones are in the domain |
| Zone / wall shape | Generated unknown identifiers and embedded Z/offset/zone suffixes | Field-specific `ValidationError`, not any exception |
| Spring gaps rejected | Generated minute within known 2026 transitions | London, Berlin, New York, Sydney, Lord Howe; first/last gap minute; a carrier cannot rescue an invalid wall |
| Fold resolution | Independent first/second UTC fixture instants with generated fold minute | Earliest fresh occurrence; untouched second occurrence and seconds preserved; equal wall text ordered using UTC carriers |
| Forbidden text | C0/C1, bidi overrides/isolates, U+200B–U+200D, BOM inserted at start/middle/end | Title, description, location checked before trim; embedded NUL, edge BOM and non-emoji ZWJ pinned |
| Legitimate Unicode | Accents, CJK, Arabic including letter mark, emoji ZWJ sequences, tab/LF/CR | Family, profession and heart-on-fire emoji stay accepted; not a blanket Cf ban |
| Capacity | Integers in the stored signed-32-bit range and invalid numeric/text domains | 1, 2147483647, 0, 2147483648, 400-digit overflow, fractional values, blank unlimited |
| End after start | Generated zones, instants and signed minute deltas; compare resolved UTC | Equal start/end rejected, +1 minute accepted, negative deltas rejected; fold carriers covered separately |

## Regressions found and fixed in this slice

All four defects reproduce with seed **10849**, path **`0`**, with the explicit
example named below. Before fixes, 13 tests failed and 8 passed (552 ms total).

| Defect | Counterexample | Fix |
| --- | --- | --- |
| Iterative offset resolution chooses the later fold occurrence | London `2026-10-25 01:00` resolves to 01:00Z instead of 00:00Z; Berlin/Sydney/Lord Howe fail too | Sample nearby offsets, retain round-tripping candidates and select the earliest UTC instant; no fixed one-hour assumption |
| Invalid wall time bypasses validation when an edit carrier exists | London gap `2026-03-29 01:00` plus carrier `2026-01-01T12:00:00Z`; all five gap fixtures fail | Preserve a carrier only when parsed submitted wall text equals its rendered wall; otherwise run normal gap/shape validation |
| Controls/invisible text accepted (or silently removed by trim) | `U+FEFF + "safe"` in each text field | Check raw submitted text using the legacy NoControlCharacters targeted rules, allowing multiline whitespace and genuine emoji joiners |
| Capacity overflows the destination integer | `"2147483648"` | Require an integer in 1–2147483647 before persistence |

Reference contracts were read without modifying or running the frozen legacy
repository: `app/Support/EventInput.php`, `app/Rules/NoControlCharacters.php`,
`app/Rules/IanaTimeZone.php`, `app/Http/Requests/StoreEventRequest.php`, and
`app/Filament/Resources/Events/Schemas/EventForm.php`. Capacity's upper bound comes
from Next `src/db/admin-schema.ts` (`integer("capacity")`), not a new product limit.

## Independent review regressions

[TOG-10928](/TOG/issues/TOG-10928) found two regressions on the first head.
Four added properties reproduced both before the fixes (21 passed / 4 failed).
They keep seed **10849**, with explicit examples and shrinkable inputs:

| Defect | Failing seed / path / counterexample | Fix |
| --- | --- | --- |
| Whitespace deletion manufactures an emoji ZWJ sequence | 10849 / `0:0:0` / `["\t", false]`: `👩‍` + tab + `💻` accepted in title, description and location | Check forbidden Cc separately, but match emoji sequences on the original text; pin LF before and tab after ZWJ and generate tab/LF/CR on either side |
| Three-digit Intl years falsely produce a gap error | 10849 / `0:0` / `[100]`: `0100-07-15 20:00` UTC rejected; explicit `0999` example also fails | Pad rendered and parsed-wall years to four digits; generate years 0100–0999 and assert the exact UTC instant, rendered wall and edit carrier |

After fixes: `timeout 10s npm run test:admin-properties` passes 25 tests in
**2.13 s**; `npm run check` passes typecheck and **620 tests**, with **150 SQL
skips** because database bindings were deliberately unset. Only local fixtures
were used; no staging or production service was contacted.

## Evidence limits

This proves pure input validation, not staging acceptance, browser integration,
recurrence, or production readiness. A local `check` without `DATABASE_URL` skips
live SQL suites; CI's separate disposable Postgres service supplies SQL coverage.
The exact-head required `check`, `gitleaks` and `pr-lint` results and independent
review/merge receipt belong on the issue work products before final delivery.
