# Website roadmap

Last reviewed: 2026-11-09 (UTC).

Together We Own's website helps community members find a game night, join it,
and understand what happens next. This is a public summary of approved direction,
not a delivery schedule or a live task tracker. The website maintainers keep it
aligned with accepted product scope; priorities and execution stay in the internal
planning system.

## Direction

- **Find a night worth joining.** Make the home page and event schedule useful at
  a glance: readable descriptions, game and host context, times, and availability.
  Keep discovery fast and usable on mobile, with or without JavaScript where the
  journey supports it.
- **Make participation understandable.** Give members clear sign-in, RSVP,
  waitlist and recovery states. Shared links, calendar subscriptions and event
  details should agree about the event a member is joining.
- **Help moderators publish with confidence.** Make event review, local and UTC
  times, attendance records and waitlist order clear, without expanding access to
  member data.
- **Keep community information trustworthy.** Preserve privacy boundaries,
  accessible interactions and bounded public content. Performance and reliability
  remain part of delivering these journeys, not reasons to bypass safeguards.

## Ember Hours

Ember Hours is the coordinated website and bot experience that this direction
builds toward. Its accepted scope brings the shared visual system to the site's
home, events, join and sign-in, member discovery, profiles and moderator screens.
It also includes clearer seat and reserve-offer journeys, Event Echoes from
recorded attendance, profile history and privacy controls, honestly labelled
season rankings, live voice context, event action timelines and a privacy-filtered
bot activity feed.

These are scope intentions, not a claim that every surface is available today.
Completing Ember Hours means the required website and bot surfaces are actually
serving together in production, with their acceptance and release gates met;
merged code alone is not completion. Later expansion does not become a commitment
merely because it appears in a backlog or historical proposal.

The site uses one accepted page-rendering direction: SvelteKit with Svelte 5,
with Hono retaining non-page APIs for now. The
[renderer decision](docs/adr/0001-sveltekit-page-renderer.md) records that boundary
and the retirement plan; this roadmap does not replace it or authorize further
API migration.

## Boundaries and non-goals

This summary does not commit to dates, a delivery order or every possible future
feature. It does not authorize new analytics, monetization, broader public APIs,
or changes to permissions or release safeguards. Those need their own accepted
scope and review.

The [post-cutover milestone proposal](docs/post-cutover-milestone.md) is retained
as history, not an active milestone or a source of new commitments. Any remaining
ideas need acceptance through normal product planning before implementation.
Architecture decisions and repository specifications retain their own scope;
this file is an entry point, not a replacement for them.

## Follow along or suggest a change

See the [README](README.md#what-works-today) for implemented capabilities and
[releases](https://github.com/TogetherWeOwn/two-web-next/releases) for shipped
history. Neither this roadmap nor an open pull request promises availability.

The website maintainers welcome public-safe questions and suggestions through
[GitHub issues](https://github.com/TogetherWeOwn/two-web-next/issues).
Do not include member data or credentials. Report vulnerabilities privately using
[SECURITY.md](SECURITY.md), not a public issue.
