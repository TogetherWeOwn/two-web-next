# Hotzone bad-season recovery

## Design contract

- Audience: guests and members following an invalid hotzone season link.
- Screen job: explain a bad request without claiming a server outage.
- Recovery actions: primary “Browse all events”; secondary “Back to the homepage”.
- Real content: **400**, **Check your request**, “Check the address or filters and try again.” Never echo the invalid season.
- References: [Hono recovery shell](../../../src/error-pages.tsx), [Kit error shell](../../../web/src/lib/ErrorShell.svelte), and the shared 400 copy/recovery treatment in [#1347](https://github.com/TogetherWeOwn/two-web-next/pull/1347).
- Layout, typography and tokens: reuse each renderer's existing recovery shell, site header/footer, heading, decorative code and home-theme styles. No CSS or framework change.
- Responsive behavior: existing stacked mobile actions and desktop inline actions. Review at 1280×800 and 390×844.
- Required state: bad seasons on the index and three signal routes; no grid, no outage wording, honest HTTP 400 and recovery navigation. Valid seasons, unknown signals and outages keep their existing contracts.
- Non-goals: season grammar, board aggregation/logging, route ownership and visual-baseline changes.

## Before and after

Screenshots show the real Hono app and adapter-built Kit Worker on local fixture origins, without database bindings. All eight images were opened for visual review. Each signal route returned the same bad-season representation as its index twin. The final pages had no horizontal overflow and no WCAG A/AA axe violations at either width. These are manual-review evidence, not replacement visual baselines.

| Renderer / viewport | Before | After |
| --- | --- | --- |
| Hono desktop | [Bare text](before-hono-desktop.png) | [Branded 400](after-hono-desktop.png) |
| Hono mobile | [Bare text](before-hono-mobile.png) | [Branded 400](after-hono-mobile.png) |
| Kit desktop | [Incorrect 500 shell](before-kit-desktop.png) | [Honest 400 shell](after-kit-desktop.png) |
| Kit mobile | [Incorrect 500 shell](before-kit-mobile.png) | [Honest 400 shell](after-kit-mobile.png) |

## Behavioral proof

`npx vitest run test/hotzone-bad-season-acceptance.test.ts test/hotzone-read-admission-acceptance.test.ts test/kit-hotzones.test.ts test/hotzones-seasonal-acceptance.test.ts`: **63 passed, 5 database-gated skipped** with no database URL configured. The new 18-test acceptance suite first produced **12 failed, 6 passed** on the baseline. Its passing controls cover zero admission spend/DB opens, valid-season cache headers, unknown signals and Kit's pre-read 400 rejection.

Three separately planted representation mutants failed the new acceptance suite: restoring bare text (**9 failures**), excluding 400 from the Kit predicate (**2 failures**) and dropping its recovery branch (**1 failure**). Exact source bytes were restored before the final green focused run.

Real built-Worker requests to all four invalid-season paths returned HTML 400 with “Check your request”, recovery navigation and no table. Kit's `/hotzones/__data.json?season=bogus` remained `application/json`, transport status 200 and a data-protocol error node with `status: 400` / `message: "Unknown season"`, byte-identical to the baseline payload. No Kit data handler changed.

The Hono accessibility/Lighthouse fixtures and CI visual specs do not exercise the Kit route; the built-Worker screenshots above are its visual evidence. CI-only parity and pinned-runner visual comparisons must pass separately. Staging and production verification are not represented by these local screenshots.
