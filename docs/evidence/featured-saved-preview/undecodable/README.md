# Undecodable saved-window correction

## Design contract addendum

Audience: moderators inspecting a saved featured slot. Screen job: keep the saved
card inspectable without claiming that an undecodable window is eligible.
Primary action remains the existing explicit Save; inspection performs no write.
Real content: a saved community-night card with an infinite start or a BC end.

References: the [existing design contract](../README.md) and
[moderator workflow](../../../moderator-admin-guide.md#preview-and-safe-editing).
Assumption: the established status badge and inherited text color are sufficient
for an unavailable verdict. No new layout, typography, palette, component,
endpoint, script, route ownership, or guest-query behavior. Both widths retain
the existing stacked card, eligibility and form order. Ordinary finite windows
and open bounds keep their existing status authority; unpublished takes
precedence even when a bound cannot be decoded. Published undecodable bounds
show **unavailable**, an explanation, and the exact saved text. This is not a
negative SQL eligibility verdict: the editor explicitly withholds its verdict.

## Captured and opened

The before source is reviewed commit `35593d971acb2862a75f062a14950863210ff1ca`.
The after source is the correction in this commit. Both use real PostgreSQL
rows read through production `getFeatured`, the Hono page and the compiled,
unchanged Svelte leaf. Local HTTP fixtures serve the real rendered HTML and
checked-in stylesheet with UTF-8 content encoding. No staging or production
request, credentials, or member data. Screenshots are full page; viewports are
1280×800 and 390×844. Every PNG below was opened for visual inspection.

| Twin | Width | Infinite-start before | Infinite-start after | BC-end after |
| --- | --- | --- | --- | --- |
| Hono | 1280 | [before](before-hono-infinity-1280.png) | [after](after-hono-infinity-1280.png) | [BC](after-hono-bc-1280.png) |
| Hono | 390 | [before](before-hono-infinity-390.png) | [after](after-hono-infinity-390.png) | [BC](after-hono-bc-390.png) |
| Kit | 1280 | [before](before-kit-infinity-1280.png) | [after](after-kit-infinity-1280.png) | [BC](after-kit-bc-1280.png) |
| Kit | 390 | [before](before-kit-infinity-390.png) | [after](after-kit-infinity-390.png) | [BC](after-kit-bc-390.png) |

The [machine report](report.json) records eight database/render witnesses and
twelve browser views. PostgreSQL's exact start-inclusive/end-exclusive predicate
is false for infinite start, negative-infinite end and BC end; both corrected
panels withhold the verdict. The open/open control remains live and SQL-eligible.
All twelve views keep JavaScript disabled, retain named headings and keyboard
movement from Headline to Body, make no writes and have no horizontal overflow.
Separate JavaScript-enabled axe contexts audit the eight after views: zero
violations, including zero critical/serious violations. They do not substitute
for the no-JavaScript inspection.

The existing Hono accessibility/Lighthouse gates do not exercise Kit routes.
Pinned public-page visual baselines remain CI-owned; none is changed here.
These PNGs are review evidence, not accepted regression baselines.
