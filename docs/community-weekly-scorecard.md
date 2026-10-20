# Weekly community scorecard

Use this template to report the four measures in the authoritative TWO Community goal: weekly active humans, human messages, joins, and event attendance. It is a reporting format, not a data collector or authorization to activate monetization.

## Reporting period

- **Week:** `[YYYY-Www; ISO week-year and week number]`
- **Start (inclusive):** `[YYYY-MM-DDT00:00:00Z; Monday, UTC]`
- **End (exclusive):** `[YYYY-MM-DDT00:00:00Z; next Monday, UTC]`
- **Prepared:** `[date]`
- **Sources checked:** `[source links or report/query references, with access date]`
- **Completeness:** `Complete | Partial | No source data`
- **Notes:** `[known gaps, scope, or corrections; do not include member-level exports]`

Use the [weekly reporting convention](community-participation-metrics.md#weekly-reporting-convention) adopted 2026-10-20: ISO week, Monday 00:00 UTC inclusive to the next Monday 00:00 UTC exclusive. This is a reporting convention, not a change to goal targets or policy. Each week is 168 hours regardless of local DST; ISO week-years handle W53 and year boundaries without partial weeks. Include exact UTC `[start, end)` timestamps as well as the week label. Event note: **“counted by UTC instant, displayed in host zone”**; assign events by start instant, not host-zone date. Missing-source and scope labels below remain required wherever evidence is incomplete.

## Metrics

For each metric, record a measured value only when its source is available and its scope is known. Link the actual source used, not just this scorecard or a definition. If the reporting source or its bot treatment is not established, mark the value **Not reported — source unavailable** (or **Not reported — scope unclear**) rather than entering zero.

| Goal metric | Goal definition / source | Value | Measurement source used | Bot exclusion and coverage | Status / notes |
| --- | --- | --- | --- | --- | --- |
| Weekly active humans | At least 1 message **or** at least 10 voice-minutes in the reporting week. Source: authoritative TWO Community goal. | `[value or Not reported — reason]` | `[link to report/query, or Not established]` | Exclude bot traffic. Identify the source's human/bot classification and any unavailable message/voice coverage. | `[Complete / Partial / No source data]` |
| Human messages | Human messages during the reporting week. Source: authoritative TWO Community goal; a more specific counting rule is not established here. | `[value or Not reported — reason]` | `[link to report/query, or Not established]` | Exclude bot messages; cite how the source identifies bots and what spaces it covers. | `[Complete / Partial / No source data]` |
| Joins | Community joins during the reporting week. Source: authoritative TWO Community goal; a more specific counting rule is not established here. | `[value or Not reported — reason]` | `[link to report/query, or Not established]` | Exclude bot joins; cite the join source and coverage. Website join-attempt records are not, by themselves, evidence of a completed community join. | `[Complete / Partial / No source data]` |
| Event attendance | Attendance at community events during the reporting week. Source: authoritative TWO Community goal. | `[value or Not reported — evidence unavailable]` | `[link to attendance evidence, or Not established]` | Exclude bot attendance. Do not count RSVP intent as attendance; see [website data ownership and RSVP records](architecture.md#5-data-ownership-web-owned-tables-versus-bot-owned-views) and [`src/events/routes-rsvp.tsx`](../src/events/routes-rsvp.tsx). These document the website's RSVP interface, not an attendance source; use attendance evidence only when its source and limitations are documented. | `[Complete / Partial / No source data]` |

The current goal describes its human-participation measures as bot-excluded and states a bot-noise ceiling separately. This scorecard does not calculate or imply that separate bot-noise measure; its definition and source belong in the documented bot-noise procedure.

## Missing data and zero values

- **Not reported — source unavailable:** no usable source for this metric. Leave the numeric value blank; never substitute `0`.
- **Not reported — scope unclear:** a source exists but its period, population, bot classification, or measurement meaning cannot be verified. Leave the numeric value blank and explain the gap.
- **0 (verified):** use zero only when the source covers the entire reporting period and confirms no qualifying activity.
- **Partial:** identify the missing dates, event(s), spaces, or source fields. Do not extrapolate the missing portion.
- An empty activity week is a verified zero only when all required sources cover the full week. An empty or unavailable report alone is not evidence of zero activity.
- RSVP, "going" counts, and RSVP roster entries describe intent; they are not attendance. Never use them to fill the attendance row.

## Examples (synthetic; not community measurements)

These examples demonstrate status handling only. Values and source names below are fabricated and must not be copied into a real report.

### Populated example

| Metric | Value | Source / status |
| --- | --- | --- |
| Weekly active humans | 12 | Synthetic complete weekly activity report; bots excluded; illustrative only. |
| Human messages | 86 | Same synthetic report; bot classification documented; illustrative only. |
| Joins | 3 | Synthetic complete join report; bot joins excluded; illustrative only. |
| Event attendance | 7 | Synthetic attendance evidence record (not RSVP data); illustrative only. |

Period: `2026-W02: [2026-01-05T00:00:00Z, 2026-01-12T00:00:00Z)`. Event note: “counted by UTC instant, displayed in host zone”. Completeness: `Complete`. This fictional example demonstrates a fully populated period; it is not evidence that the specified measurement sources are approved or available.

### Missing-source example

| Metric | Value | Source / status |
| --- | --- | --- |
| Weekly active humans | Not reported | Voice-minute source unavailable; coverage cannot be confirmed. |
| Human messages | Not reported | Message source unavailable. |
| Joins | 3 | Synthetic full-period join source; illustrative only. |
| Event attendance | Not reported | No documented attendance evidence source; an RSVP roster is not a substitute. |

Period: `2026-W03: [2026-01-12T00:00:00Z, 2026-01-19T00:00:00Z)`. Event note: “counted by UTC instant, displayed in host zone”. Completeness: `Partial`. Do not convert either missing value to zero.

### Empty-week example

| Metric | Value | Source / status |
| --- | --- | --- |
| Weekly active humans | 0 (verified) | Synthetic sources cover the full week and show no qualifying human message or voice activity. |
| Human messages | 0 (verified) | Synthetic full-period source; bots excluded. |
| Joins | 0 (verified) | Synthetic full-period join source; bot joins excluded. |
| Event attendance | 0 (verified) | Synthetic complete attendance evidence confirms no attendance; RSVP counts are not used. |

Period: `2026-W04: [2026-01-19T00:00:00Z, 2026-01-26T00:00:00Z)`. Event note: “counted by UTC instant, displayed in host zone”. Completeness: `Complete`. If any source is absent, incomplete, or ambiguous instead, mark the affected metric `Not reported` rather than zero.

## Source references and limits

- **Metric names, weekly-active threshold, bot exclusion, and goal context:** authoritative company goal **The TWO Community** (reviewed 2026-10-17). Its goal definition is the authority for what the targets mean; this repository does not reproduce an internal goal link in public documentation.
- **Website event and RSVP interfaces:** [README event capabilities](../README.md#what-works-today), [data ownership and schema overview](architecture.md#5-data-ownership-web-owned-tables-versus-bot-owned-views), [`src/db/admin-schema.ts`](../src/db/admin-schema.ts), and [`src/events/routes.tsx`](../src/events/routes.tsx). These describe website-owned event/RSVP records and boundaries; they do not establish RSVP as attendance or provide community-wide attendance evidence.
- **Bot-owned website read views:** [data ownership](architecture.md#5-data-ownership-web-owned-tables-versus-bot-owned-views) and [web-v1 contract](web-v1-contract.md). Those views provide homepage live counts and ranks; they are not documented here as sources for message, join, or attendance totals.
- **Metric extraction definitions, approved measurement sources, bot identification, and attendance evidence rules:** not established by this template. Until the corresponding source map and attendance contract are available, link the exact reporting evidence used and mark any unsupported metric `Not reported`. Do not invent a query, widen access, or use production/staging database reads to fill a gap.

This scorecard reports evidence; it does not establish a monetization gate. Follow the authoritative goal and separate event-gate and monetization-boundary procedures for those decisions.
