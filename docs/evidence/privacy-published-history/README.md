# Privacy published history: visual evidence

## Design contract

Audience: members and moderators. Screen job: inspect previously published
policy text without mistaking it for today's policy. Primary action: a native
`Version 5 on GitHub (public repository)` link.

Keep the Open Lobby/Logo 1 chrome, semantic tokens, typography, current legal
body and join/back navigation. Add a native `h2` plus intro plus `ul` after the
current body; the strap reads `Version 6, current policy`. References: the
existing Hono/Kit privacy twins and content-leaf navigation; no new visual
direction. Required states: normal current page and keyboard-focused history
link. Non-goals: old-body rendering, archive route, JavaScript, legal edits,
policy activation, budget or threshold changes.

## Captures

Real Chromium, JavaScript disabled, real SSR bytes per twin at 1280x800 and
390x844, via the existing browser companion:

```sh
PRIVACY_HISTORY_SCREENSHOT_DIR=<dir> NODE_OPTIONS=--import=tsx \
  npx playwright test --config=e2e privacy-published-history.spec.ts --workers=1
```

Before shots use the same command on the pre-change tree. Every image in this
directory was opened and inspected.

Limits: container font fallback can differ from the pinned CI runner, so these
captures are implementation evidence, not golden-baseline approval. The
external GitHub destination is never fetched; the browser test observes
navigation intent only. Axe (zero serious/critical), no-JS Tab/Enter follow
through, accessible link names and no-overflow checks run in the companion
spec.

## Pairs

| Twin | Width | Before | After (current) | After (history focused) |
| --- | --- | --- | --- | --- |
| Hono | 1280 | [before](before/Hono-1280-current.png) | [after](after/Hono-1280-current.png) | [focused](after/Hono-1280-history-focused.png) |
| Hono | 390 | [before](before/Hono-390-current.png) | [after](after/Hono-390-current.png) | [focused](after/Hono-390-history-focused.png) |
| Kit | 1280 | [before](before/Kit-1280-current.png) | [after](after/Kit-1280-current.png) | [focused](after/Kit-1280-history-focused.png) |
| Kit | 390 | [before](before/Kit-390-current.png) | [after](after/Kit-390-current.png) | [focused](after/Kit-390-history-focused.png) |

What changed between before and after: the strap names the current policy, and
a history section with one externally labelled Version 5 link sits between the
policy body and the join/back links. Chrome, typography, body copy, footer and
both widths' layouts are otherwise unchanged.
