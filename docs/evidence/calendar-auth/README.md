# Calendar authentication destination evidence

## UI contract

- **Audience and screen job:** guests exploring events who should return to the displayed, committed view after signing in or joining.
- **Primary actions:** existing header Sign in, hero Join and in-content sign-in anchors.
- **Real content:** mounted application markup with synthetic community game nights, pagination and a past event. The browser matrix also searches reserved and Unicode text.
- **References:** the existing native Hono and shared Kit documents for `/events` and `/events?past=1`. These are behavior and appearance references, not a new visual direction.
- **Layout, typography and tokens:** unchanged existing shell, headings, CTA copy, colors, sizing and spacing. Desktop is 1280×800; mobile is 390×844.
- **Required states:** native entry; successful search, month/page/list/past commit; Back/Forward; newer drafts; HTTP failure and keyboard retry; superseded or malformed fragments; preserved input and focus.
- **Non-goals:** redesign, OAuth/session policy changes, other pages, live login or deployment.

## Before and after

The images below show the same real-app local-fixture journey before and after the implementation: navigate from `/events` to `/events?past=1`, then return the viewport to the header. Both render paths use the reviewed shipped island. Hono runs the mounted route; Kit runs its loader and shared HTML renderer, not a built adapter Worker.

| Renderer / viewport | Before | After |
| --- | --- | --- |
| Hono desktop | [Before](hono-desktop-before.png) | [After](hono-desktop-after.png) |
| Hono mobile | [Before](hono-mobile-before.png) | [After](hono-mobile-after.png) |
| Kit desktop | [Before](kit-desktop-before.png) | [After](kit-desktop-after.png) |
| Kit mobile | [Before](kit-mobile-before.png) | [After](kit-mobile-after.png) |

No pixel change is intended. The regression is in the anchors' destinations, so screenshots cannot prove the fix. The immutable browser suite compares complete hrefs with a fresh native document, asserts each distinct endpoint and decoded `next`, and clicks the actual header and hero anchors with navigation intercepted before OAuth.

## Reproduction

```sh
NODE_OPTIONS=--import=tsx env -u DATABASE_URL \
  npx playwright test --config=e2e/calendar-auth-fixtures.config.ts
```

Observed before implementation: **38 failed, 10 passed**. Observed after rebuilding the island: **48 passed, zero skipped**. Browser requests are intercepted local fixtures; no Discord or OAuth request is made. This is not staging or production delivery evidence, and no visual baseline was changed.
