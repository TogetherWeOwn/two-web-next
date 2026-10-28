# Compare event times with your device timezone

The host schedule remains authoritative. Select **Show in my device timezone**
under **Starts** or **Ends** to compare that instant with your device's clock.
The comparison shows the full local date, time, timezone identifier and the
UTC/GMT offset at the event instant, not today's offset. Dates can differ, and
repeated clocks during the autumn daylight-saving change have different offsets.
Even when both zones match, the comparison is labelled as device time.

Conversion runs only after you activate the button and only in this browser.
Nothing is saved to your profile, cookies or storage, and no location lookup or
request is sent. Activating it again rechecks your device timezone. It does not
change the event, host schedule, RSVP or calendar links. Each button converts
only its own instant: activating Ends leaves the Starts comparison empty.

If your browser cannot resolve or format its timezone, the comparison says it is
unavailable. Use the host schedule above or **Add to calendar (.ics)** / **Google
Calendar** instead. Without JavaScript, the complete host schedule and calendar
links remain available. Check your device settings if its timezone is not the
one you intended.

## Compare the range in a chosen timezone

Planning with friends elsewhere? Under **Compare in another timezone**, type an
IANA timezone identifier (for example `Europe/London`) and select **Compare
times**. The comparison shows BOTH the start and the end instants as full dates
and times in that zone, with the UTC/GMT offset that applies to each instant,
so a range that crosses midnight or a daylight-saving change reads correctly.

This converts the event's scheduled range, not your device clock: the
device-timezone buttons above convert one instant each using your device
setting, while the profile editor helper only previews the zone saved on your
profile. The chosen zone is used for this one comparison only. Nothing is saved
to your profile, cookies or storage, and no request is sent; typing alone never
converts. Surrounding whitespace is ignored. An unknown or overlong identifier, or a browser without Intl
formatting, yields honest guidance pointing back at the host schedule and
calendar links.

## Read the time commitment and calendar clocks

**Duration** in event details is elapsed time between the scheduled instants,
not the difference between the two host clocks. It remains accurate overnight
and across daylight-saving changes. It uses whole hours/minutes, rounding down
residual seconds, or **Less than a minute** for a positive sub-minute interval.
An unusable or nonpositive interval has no Duration entry. Starts, Ends, RSVP
and calendar exports keep their existing values and behavior, with or without
JavaScript.

Timed entries in the month grid name the host IANA timezone beside the clock,
for example **19:00 Europe/London**. Invalid zones read as **UTC**, matching the
clock's fallback. Discord-only entries use the page's fallback zone. Long labels
wrap inside the existing horizontally scrollable mobile grid; the title is not
hidden by CSS truncation. Screen-reader names keep the visible prefix, full
title and day. **Continues** entries keep their displayed-day/cancellation
wording without gaining a clock or timezone.

## UI contract

Audience: guests and members comparing the start or end instant without
losing the host schedule. Primary action: **Show in my device timezone**.
Existing references are [Hono detail](../src/events/pages-detail.tsx),
[Kit detail](../web/src/lib/EventDetail.svelte) and the
[event theme](../public/event-theme.css). This is an existing-stack
extension, not a new visual direction.

Keep each host `<time>` unchanged. Place a secondary native button below each
one, then a polite status paragraph for either the comparison or honest
fallback guidance. The Ends mount reuses the Starts shape verbatim; both mounts
carry button/status testids (`event-device-timezone-{starts,ends}-{button,status}`)
so each conversion is addressed separately. The chosen-range mount reuses the
same block class after the Ends block: a labelled bounded native input with
compact examples, an explicit Compare action and one polite status showing both
instants with per-instant offsets. Retain the current typography and
color tokens; wrap long zones/dates inside the metadata cell and retain the
existing mobile single-column grid. Do not move focus or convert on page load.
Hide the actions until JavaScript binds them; no-JS keeps the host presentation.
The Kit detail route is server-rendered with `csr=false`, so it uses the same
deferred native island as Hono, not a hydration handler. Navigating to another
event loads a fresh comparison.

Required evidence: desktop 1280×800 and mobile 390×844 before/default,
converted and unavailable states in Hono and Kit, for Starts
([evidence](./evidence/event-device-timezone/README.md)) and Ends
([evidence](./evidence/event-device-timezone-ends/README.md)). The Ends bundle
currently omits the required unavailable-state images at both widths in both
renderers; its browser tests cover the behavior, not that visual evidence.
Those captures remain outstanding. Hono a11y/Lighthouse/visual gates do not
exercise the Kit route; Kit needs its own
real-browser fixture proof and release-build budget check. Visual baseline
updates require reviewed CI failure artifacts; no wider masks or threshold
changes are part of this feature.

The shared native-Intl formatter is bundled once into the native island used by
both renderers. The Kit client graph does not duplicate conversion logic.
The island keeps its 2048-byte raw / 1024-byte gzip ceiling; no existing
asset ceiling changes. The independent acceptance suites run 30 browser cases
each in CI (Starts and Ends), including DST folds, rollover, same-zone,
side-effect guards, keyboard activation and Intl failures. Additional formatter
cases cover UTC, fractional offsets and unsupported offset formatting.
