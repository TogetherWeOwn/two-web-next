# Hotzone recovery evidence

## Design contract

- **Audience and screen job:** a member with a malformed `?season=` or a
  mistyped hotzone signal (`/hotzones/voic`) must get a hotzone way forward,
  not a generic dead end.
- **Primary action:** browse all hot zones (index), or pick the joins, voice
  or games signal. The way home stays on every error.
- **Content and references:** the real season grammar (all, year, month,
  quarter) and the real signal list. Recovery precedent
  [MemberBoardFilterErrorPage](../../../src/leaderboards/pages.tsx); Kit
  route-boundary precedent
  [e/\[key\]/+error.svelte](../../../web/src/routes/e/%5Bkey%5D/+error.svelte).
  No new visual direction: both twins reuse the recovery-hero shell.
- **Layout, typography and tokens:** unchanged. The branded shell (chrome,
  decorative recovery code, heading, lead, recovery actions) keeps its
  markup and classes; the recovery nav is a plain link list. No new CSS.
- **Responsive behavior:** the existing shell flow stacks the actions and
  nav at 390px with no horizontal overflow; verified at 1280×800 and
  390×844 on both twins.
- **Required states:** bad-season 400 (grammar + index + signals) and
  unknown-signal 404 (signal list + index link) on Hono and Kit.
- **Non-goals:** new season grammar, period picker, season continuity,
  503 copy, throttle rules, header/footer changes.

## Captures

All eight images were opened for visual inspection. Desktop viewport is
1280×800, mobile is 390×844.

| Twin / state | Desktop | Mobile |
| --- | --- | --- |
| Hono bad-season 400 | [Image](hono-400-desktop.png) | [Image](hono-400-mobile.png) |
| Hono unknown-signal 404 | [Image](hono-404-desktop.png) | [Image](hono-404-mobile.png) |
| Kit bad-season 400 | [Image](kit-400-desktop.png) | [Image](kit-400-mobile.png) |
| Kit unknown-signal 404 | [Image](kit-404-desktop.png) | [Image](kit-404-mobile.png) |

The Hono captures serve the real production worker (`src/worker.ts`
bundled) through `wrangler dev --local` with synthetic vars and a memory
session store: these paths touch no DB, throttle or Discord by
construction (grammar-first), so no database was needed. The drivers
asserted HTTP 400/404 and the live `error-hotzones`, `error-hotzone-*`
and `error-home` test ids before capturing; off-origin requests were
aborted.

The Kit captures are component-fixture renders of the real
`hotzones/+error.svelte` boundary (the web workspace's locked Svelte
compiler, real Shell/ErrorShell dependencies, `svelte/server`), with a
`$app/state` page fixture per status (400/404). Chromium opens the
rendered documents from a short-lived loopback server using the actual
Vite-built Kit CSS, public theme sheets, logo and local fonts.
Off-origin requests were aborted. No database, Discord, bot or staging
traffic supplies these screenshots. The fixture does not execute the
complete Kit Worker request/load pipeline.

## Gate boundaries

- `npm run a11y` is green (146 PASS, 0 failures), including the
  `/hotzones/bogus` 404 scenario at both widths.
- Lighthouse and the quality gate measure fixed URLs with no hotzone
  error paths, and this change touches no shared shell, stylesheet or
  valid-page bytes, so those scores cannot move; CI re-verifies on the PR.
- No visual-regression baseline covers these paths; none was changed or
  accepted, and no threshold was relaxed.
- Hono a11y/Lighthouse/quality gates do not exercise Kit routes; the Kit
  captures above are the Kit visual evidence.
