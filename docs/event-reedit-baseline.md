# Event re-edit baseline (Goal 4)

Goal 4 — moderators run events with fewer mistakes — needs a baseline taken
before the first Goal 4 change ships, so the follow-up measurement compares
against a number recorded with the same method. This page defines the
metric, states how to reproduce it, and records each measurement. The
runner is [`bin/event-reedit-baseline.mjs`](../bin/event-reedit-baseline.mjs);
keep this page and that script in step.

## Metric definition (method v1)

**Share of published events re-edited within one hour** =

> (events first published in the window that have a moderator content edit
> in the 60 minutes after publishing) ÷ (all events first published in the
> window)

Source: the `activity_log` write-audit table
([schema](../src/db/admin-schema.ts)). One row lands per moderator save
that changed something.

- **Window:** 28 days by default, the half-open interval
  `[end − 28 days, end)` in UTC. State the exact timestamps with every
  recorded number.
- **Publish:** an activity row for an event subject whose status changed
  into `published`. Two `properties` shapes exist
  ([data-import.md](data-import.md)): rows the current app writes use
  `{status: {before, after}}`; imported legacy rows keep the spatie
  `{attributes, old}` shape. The runner accepts both. An event counts
  once, at its first publish ever, and only when that first publish falls
  inside the window: the query also reads earlier publish rows, so an
  event republished inside the window after an earlier publish is left out.
- **Re-edit:** a moderator content edit of the same event at time `t` with
  `publish < t ≤ publish + 60 minutes` — the app's `updated event …`
  rows, or a legacy `updated` row, that changed a content field. The app
  stamps `updatedAt` (and may bump `agentVersion`) on every save, so a
  save that changed only those bookkeeping fields is not a re-edit. Cancel
  and RSVP pause/reopen rows are status changes, not content edits, and
  never count.
- **Observation completeness:** an event published less than 60 minutes
  before the data ends cannot yet show its full hour. The runner excludes
  such events from both counts and reports them as under-observed, so a
  run made minutes after a publish never dilutes the share.
- **Empty window:** the share is `null`, never `0` — no denominator, no
  share. Record it as “not reported — nothing published”.

### Limits of the source

- The admin activity-log page is a paginated viewer with no aggregation,
  which is why this metric uses the script instead of the page.
- Events created through the agent-events ingress write no
  `activity_log` rows, so the metric covers moderator-run events — the
  population Goal 4 is about. A moderator editing an agent-created event
  does write rows, but with no publish row the event stays outside both
  counts.
- Editing a recurring series parent shifts its future children, and each
  shifted child writes its own `updated event …` row. A child published
  within its own previous hour therefore counts as re-edited even though
  the moderator edited the parent. Rare, and conservative (it can only
  raise the share).
- Legacy rows key events by their legacy numeric id; current rows by
  event key. A publish and an edit one hour apart share a key unless the
  production cutover fell inside that hour, so cross-era joins are not
  attempted.
- `created_at` on the activity row is the save instant (UTC), which is
  what both the publish and the edit sides use.

## How to run it

Agents never query the production or staging database. The owner (or an
operator the owner names) runs the read-only script and pastes the output
back. The session sets `default_transaction_read_only=on`, runs one
bounded `SELECT`, and prints aggregate counts only — no titles, causers
or row contents.

```sh
DATABASE_URL='<production read URL with sslmode=verify-full>' \
  node bin/event-reedit-baseline.mjs --target=production --json
```

Production is the PlanetScale `two-web-next-production` database reached
through Hyperdrive; run with the read-only backup role after confirming
the session is read-only (`transaction_read_only=on`). The Neon `main`
branch database has no `activity_log` table, so a run pointed there fails
with `REEDIT_BASELINE_FAILED sqlstate=42P01` — that code names the error
class only and is safe to paste back. Delete any local copy of the
production URL after the run.

Pin a historical window with `--end=<ISO timestamp>` and
`--window-days=<1-366>`. Exit 0 prints the report; exit 2 is a
usage/configuration refusal (for example a production-looking URL without
`--target=production`); exit 1 is a run failure. Refusals print a stable
code only, never driver details.

## Recorded measurements

| Label | Publish window (UTC) | Published | Re-edited ≤60 min | Share | Method |
| --- | --- | ---: | ---: | ---: | --- |
| Baseline (pre–Goal 4) | 2026-10-05T13:48:32.000Z – 2026-11-02T13:48:32.000Z | 0 | 0 | n/a (nothing published) | v1 |
| Follow-up | 28 days from the last Goal 4 merge — not yet due | — | — | — | v1 |

**Baseline window.** The baseline window ends at the first Goal 4 merge,
2026-11-02T13:48:32Z (pull request #2027), so no Goal 4 change could have
shaped the baseline. The runner reads a past window, so the measurement
could be taken after that merge. Run 2026-11-06 by the operator, with the
read-only backup role over verify-full TLS, after confirming
`transaction_read_only = on`, at head `4d209c2c`:

```sh
node bin/event-reedit-baseline.mjs --target=production --end=2026-11-02T13:48:32Z --json
```

`{"metric":"event-reedit-within-1h","methodVersion":1,
"windowStart":"2026-10-05T13:48:32.000Z","windowEnd":"2026-11-02T13:48:32.000Z",
"observedUntil":"2026-11-02T14:48:32.000Z","published":0,"reedited":0,
"underObserved":0,"sharePercent":null}`.

Production `activity_log` holds **0 rows in total**, not just 0 event
rows, so the pre–Goal 4 baseline is n/a (nothing published), not 0%. Any
Goal 4 comparison has to start from data written after the merges.
The app code does write the table on moderator event transitions and
edits (`src/admin/store-event-writes.ts`), which points at missing
production writes rather than missing publishes. A follow-up card tracks
this before Goal 4 relies on the metric.

**Follow-up window.** Measure the same way over the 28 days that start
at the last Goal 4 merge: pass `--end=<last Goal 4 merge + 28 days>`
once that instant has passed by at least 60 minutes, and record the
merge it starts from.

**Superseded run.** An earlier run on 2026-11-01 (head `3aa37080`) used
the window 2026-10-04T07:23:27.601Z – 2026-11-01T07:23:27.601Z and
returned the same empty result. Its window ended about 30 hours before
the first Goal 4 merge, so the pinned run above replaces it.

**Method v1 corrections.** Before any non-empty measurement, v1 was
corrected to read earlier publish rows (republished events) and to ignore
saves that changed only bookkeeping fields. Both recorded runs read an
empty `activity_log`, so their results are the same under the corrected
code, and the version stays at 1.

Record a measurement by replacing the pending cells with the runner's
`windowStart`/`windowEnd`, `published`, `reedited` and `sharePercent`
values, in the same change that notes the run date. If the method ever
changes, bump `METHOD_VERSION` in the runner, add a new row labelled with
the new version, and never restate an old number under a new method.
