# Community metrics: source and access boundary

This document maps community-goal measures to aggregate evidence already described in this repository. It does not authorize new data collection, change the privacy policy, or grant access to a database or member-level records. A metric without a supported aggregate source is **unavailable**, not zero and not permission to export members.

## Metric sources and limits

| Goal measure | Existing aggregate evidence | What it does not establish |
| --- | --- | --- |
| Current human-member population | The bot-owned, read-only `web_v1.live_counts.human_member_count` snapshot excludes bots. Null or stale snapshots are unknown; the homepage hides them. See [web-v1 contract](web-v1-contract.md#web_v1live_counts) and `src/counts.ts`. | Weekly active humans. It is a current population snapshot, not an activity window. It does not authorize reading the producer's underlying member records. |
| Joins (scorecard source) | The `/hotzones` joins grid (`loadJoinsGrid` in `src/hotzones/aggregates.ts`) counts only recorded `added` and `already_member` attempts in the selected season window, as weekday/hour aggregates. It excludes attempts whose `discord_id` maps to a profile with `leaderboard_opt_out = true`; this is the only joins source here approved to inform a community scorecard, and only for the recorded outcomes and reported window. | This is not a deduplicated new-member count or complete join history: `already_member` is not a new join, some sign-ins/joins are not recorded, and attempts are pruned after 90 days. Show the exact window and describe the measure as recorded successful join-attempt outcomes, not complete joins. |
| Admin join funnel (not a scorecard source) | The moderator-only `/admin` Join funnel (`joinFunnelStats` in `src/admin/reads.ts`) returns aggregate counts for every recorded outcome (`added`, `already_member`, `denied`, `error`, `degraded`) over 90 days. It has no opt-out filter, so it is not approved for community scorecards, including when selecting only `added` and `already_member`. See [join diagnostics](troubleshooting-join.md#moderator-diagnostics-and-escalation) and `src/admin/join-funnel.ts`. | Its totals differ from the `/hotzones` grid and include attempts linked to opted-out profiles. A proposed source change or scorecard use requires CISO review and must preserve the published opt-out commitment. |
| Human messages per week | No aggregate source for this measure is documented here. | The website privacy disclosure says message content is not stored in the website database; do not infer message volume from website records or obtain message-level exports. |
| Event attendance | Published-event counts and RSVP counts are not attendance evidence. No aggregate attendance source is documented here. | RSVP is intent, not proof of presence. Attendee names and RSVP records are member-level data; do not export them to make an attendance total. |
| Voice activity | `/hotzones/voice` is a deterministic seeded estimate, explicitly labeled as an estimate pending bot event-store calibration (`src/hotzones/aggregates.ts`). | Measured voice minutes or weekly active humans. Do not report this estimate as observed activity. |

The bot-owned `web_v1.rank_counts` view is also aggregate-only and supports the homepage rank display; it is not a substitute for any community-goal measure. Its narrow column and null semantics are defined in the [web-v1 contract](web-v1-contract.md#web_v1rank_counts).

## Before a weekly value can be reported

No entry below approves a source, query, audience, retention period, or access. Each entry lists what a future proposal would have to establish, from documented interfaces only, before the corresponding value can leave `Not reported`. Each weekly measure gets its own entry in the same shape, so further measures can be added the same way. Any proposal must supply the review inputs listed under [Escalation](#escalation) — proposed purpose, minimum fields and aggregation, audience, retention, source, and deletion/access controls — and this document selects none of them.

### Joins/week

- **What must be counted:** successful **new** guild-member additions in the reporting week. The approved `/hotzones` joins grid combines `added` with `already_member` (`JOIN_SUCCESS_OUTCOMES` in `src/hotzones/aggregates.ts:50`), so it counts recorded successful join-attempt outcomes, not new joins.
- **Weekly window:** the goal's weekly reporting period, with exact start/end timestamps and timezone stated on every reported value. The grid is reachable only through `?season=`, which accepts only absent/`all`, `YYYY`, `YYYY-MM`, or `YYYY-Qn` UTC windows (`src/hotzones/season.ts:12-14`); its smallest window is a calendar month, so it cannot select a week. The week-boundary and timezone convention is not selected here.
- **Bot exclusion:** bot traffic must not count. The `join_attempts` columns are outcome, source, request ID, Discord ID, and timestamp (`src/db/schema.ts:69-87`; `recordAttempt` in `src/join/service.ts:284-307`); there is no bot flag or bot-account predicate, so the current interface cannot prove a human-only join count.
- **Opt-out commitment:** the published promise that opting out removes a member from every board and every count (`content/privacy-policy-v5.md:86`) must hold. The current grid keeps it by dropping attempts linked to `leaderboard_opt_out = true` profiles (`src/hotzones/aggregates.ts:90-94`).
- **Coverage gap:** `join_attempts` records website join-flow outcomes only; joins through Discord invites or other paths are not recorded, some sign-ins/joins are not recorded, and attempts are pruned after 90 days (`src/hotzones/aggregates.ts:130-139`). A weekly new-join value needs guild-wide coverage the current interface does not establish.
- **Review:** a proposal must supply the purpose, minimum fields and aggregation, audience, retention, source, and deletion/access controls listed under [Escalation](#escalation) before any new source, query, or access is used.

### Weekly active humans (voice minutes)

- **What must be counted:** per-member voice minutes in the reporting week, tested against the goal's at-least-10-voice-minutes threshold; a member who also sent a human-authored message still counts once. See the goal wording in [community human participation metrics](community-participation-metrics.md#goal-wording-and-reporting-rule).
- **Weekly window:** the same weekly reporting period requirement as Joins/week above: exact start/end timestamps and timezone on every value, with the boundary and timezone convention not selected here.
- **Bot exclusion:** bot traffic must not count. The consumed `web_v1` contract exposes only `live_counts` snapshot columns and `rank_counts` ladder columns ([contract](web-v1-contract.md#web_v1live_counts)), with no weekly message or voice-activity fields; `/hotzones/voice` is a deterministic seeded estimate (`priorGrid` in `src/hotzones/aggregates.ts:171-189`), not observed activity, and must never be reported as measured voice minutes. No bot exclusion for activity data is evidenced in this repository.
- **Opt-out commitment:** the same every-board-and-every-count promise (`content/privacy-policy-v5.md:86`) must hold for any voice-derived weekly count.
- **Coverage gap:** the website database never stores voice audio (`content/privacy-policy-v5.md:58`); per-member voice minutes, if they exist anywhere, are held only by the bot system, and no bot voice source is part of the website interface reviewed here.
- **Review:** as for Joins/week: purpose, minimum fields and aggregation, audience, retention, source, and deletion/access controls under [Escalation](#escalation), with none of them selected here.

## Default access boundary

- Prefer an existing, documented aggregate/read model whose fields and purpose are explicit. Use only its aggregate output for that stated purpose. Do not select, export, retain, or publish member-level rows, identifiers, profiles, RSVP lists, join-attempt details, or message/voice content for community scorecards.
- Existing access to a view or aggregate route is not blanket approval for a new metric, query, audience, retention period, or downstream use. In particular, the homepage `web_v1` consumer is a read-only consumer of bot-owned views; it does not own their schema or authorize direct access to the producer's underlying records.
- If a goal measure has no supported aggregate source, report it as unavailable and record the limitation. Do not derive it by scraping, joining member-level data, or treating a synthetic estimate as observed activity.
- Keep publicly displayed and operational aggregates to their documented scope. The `/admin` join funnel is an aggregate-only moderator diagnostic, is optional/failure-degrading, and does not bypass admin session or audit checks. Identifier-bearing list/detail rows belong to `/admin/join-attempts`; use that surface only for a legitimate support incident, and never copy its rows to public channels.

## Tests and probes

Tests, local probes, and verification must use local fixtures or the disposable test database/service described in [README safe-test guidance](../README.md#database-and-migrations). **Never point tests, probes, or verification at production or staging databases.** Do not use production/staging credentials or live database access as a substitute for fixtures. The `web_v1` test fixture is rollback-only and refuses non-test URLs ([contract](web-v1-contract.md#test-fixture-not-producer-ddl)); it is not producer DDL or authorization to probe the bot database.

## Escalation

Stop and request CISO review before any proposal or work that would access/export member-level or personal data for a new purpose, identify members in a report, introduce a new data source or recipient, change access/retention/sharing policy, or turn an estimate into a measured claim. Provide the proposed purpose, minimum fields and aggregation, audience, retention, source, and deletion/access controls for review. A request or this document alone is not approval. Preserve existing consent, opt-out, access-log, and product-policy boundaries; escalate ambiguous classification rather than widening access by default.

## Evidence reviewed

- `README.md` — disposable test database and production/staging prohibition.
- `docs/web-v1-contract.md` — bot-owned aggregate views, homepage consumer boundary, fixture rules.
- `docs/community-participation-metrics.md` — goal-metric operational definitions and the weekly reporting rule.
- `docs/troubleshooting-join.md` — bounded moderator diagnostics and join-funnel limitations.
- `docs/member-erasure.md` and `src/privacy-content.ts` — member data, retention, and published privacy commitments.
- `src/hotzones/aggregates.ts` — aggregate joins semantics and estimated voice/games priors.
- `src/admin/reads.ts` and `src/admin/join-funnel.ts` — moderator join-funnel outcome aggregation, 90-day window, and absence of an opt-out filter.
- Goal-level metric wording — weekly active humans, human messages/week, joins/week, and event attendance; bot traffic does not count.
