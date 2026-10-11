# Daily staging explorer and QA routine

`.github/workflows/explore-staging.yml` crawls the staging Worker
(`https://next.togetherweown.com`) every day at 05:17 UTC as a guest, at desktop
(1280×800) and mobile (390×844) widths, following same-origin links breadth-first
(up to 40 pages per width, small pagination only). Sign-in, Discord, admin,
profile and feed paths are skipped, and every non-GET request is blocked by the
watch guard (`e2e/watch-guard.mjs`). A page that lands off-origin after a
redirect (for example `/discord` 302s to Discord) is recorded as a low
off-origin finding and is not audited. It never targets production.

## What counts as a finding

`e2e/explore/explore.spec.ts` with the helpers in `e2e/explore/crawl-utils.mjs`:

| Kind | Severity |
| --- | --- |
| Page status 5xx / uncaught page error / critical axe violation | high |
| Page status 4xx, failed same-origin subresource, broken image, horizontal overflow, serious axe violation, blocked write attempt | medium |
| Console error / off-origin redirect (info, not audited) | low |

Each finding has a stable `id` (kind + path + viewport + detail with volatile
numbers normalised), so the same problem keeps the same id across days. Findings
and full-page screenshots are uploaded as the `explore-findings` artifact (14
days) and summarised on the run page. The run itself only fails if staging's home
page is not 200.

## Loop

A daily Paperclip routine (06:07 UTC) asks the QA & Release Engineer to read the
newest `explore-findings` artifact, skip ids that already have an open
`[explore]` card, and file one card per new high/medium finding for the Web
Engineer (project TWO Web Next), with the path, viewport, detail, screenshot link
and run link. The fix goes through a normal PR, where `browser-smoke`, visual
regression, Lighthouse and the standards gates apply. The finding disappears from
the next day's run once the fix is deployed to staging.
