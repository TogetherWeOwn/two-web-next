# Kit admin contrast evidence

## Design contract

Moderators need to read timezone/image guidance and recurrence labels while creating
or editing events and featured content. Preserve the existing single-column forms,
field order, copy, native controls, actions, typography, spacing and responsive
behavior. Reuse the Open Lobby `lobby-muted` and `lobby-raised` tokens on the existing
dark canvas. The references are the current root palette (`web/src/app.css`),
moderator chrome (`web/src/lib/AdminShell.svelte`) and shared light admin sheet
(`assets/styles.css`). There is no new visual direction or external design input.

Scope the correction to `.kit-admin`. Hono keeps its original light palette;
public Kit routes do not acquire the wrapper. Auth, save behavior, live data,
threshold changes and golden-baseline regeneration are non-goals.

## Fixture and limits

Baseline: pristine main `2540adb21d03c0e36eab1ca9fd8c6fbbbdabe106`.
The browser test uses the production-built SvelteKit `Server.respond`, generated
manifest, actual root layout, AdminShell, leaf components and generated styles.
Only hooks and server data loads are replaced with synthetic fixtures. All browser
requests are intercepted; external and non-GET requests fail. The fixture runs
shipped islands, but does not prove authorization, database access, route ownership,
Cloudflare/workerd integration or hydration. Admin is server rendered.

Capture command after installing both lockfile roots and Chromium:

```sh
npm run build --prefix web
KIT_ADMIN_CONTRAST_EVIDENCE_DIR=artifacts/kit-admin-contrast \
  node --import tsx --test --test-timeout=60000 ci/kit-admin-contrast.test.mjs
```

Each capture is full-page at a viewport of **1280×800** or **390×844**. Both the
author and an independent visual checker opened all 16 images. The local font
fallback is serif; these are fixture evidence, not pinned-runner golden images.

## Before / after

| Form | Width | Before | After |
| --- | --- | --- | --- |
| Event new | 1280 | [before](before/event-new-1280.png) | [after](after/event-new-1280.png) |
| Event new | 390 | [before](before/event-new-390.png) | [after](after/event-new-390.png) |
| Event edit | 1280 | [before](before/event-edit-1280.png) | [after](after/event-edit-1280.png) |
| Event edit | 390 | [before](before/event-edit-390.png) | [after](after/event-edit-390.png) |
| Featured new | 1280 | [before](before/featured-new-1280.png) | [after](after/featured-new-1280.png) |
| Featured new | 390 | [before](before/featured-new-390.png) | [after](after/featured-new-390.png) |
| Featured edit | 1280 | [before](before/featured-edit-1280.png) | [after](after/featured-edit-1280.png) |
| Featured edit | 390 | [before](before/featured-edit-390.png) | [after](after/featured-edit-390.png) |

## Results and critique

- **Red before:** eight Kit cases failed axe color-contrast on pristine main.
  Help/footer measured 3.01:1 and recurrence labels/legend 1.07:1 (axe reports;
  required 4.5:1). The Hono control passed.
- **Green after:** nine cases passed, zero failed/skipped; targeted axe checks
  reported zero violations and zero incompletes at both widths. Computed-color
  ratios are at least 8.07:1 after the correction.
- **Preserved Hono:** separate event/featured fixtures retain light canvas, dark
  ink, muted help/footer and light recurrence surface. Shared styles are unchanged.
- **Visual:** help/footer are legible and the repeat group is coherent on the dark
  canvas. Field geometry, actions and mobile wrapping remain unchanged. No new
  clipping or layout regression found by either visual checker.
- **Existing concern, not claimed fixed:** the brand remains dark-on-dark in both
  sets. This targeted test is not a whole-page accessibility approval.
- **Unchanged Kit ceilings:** worker 2551 raw / 1219 gzip bytes; server 118 files,
  1124117 raw / 327973 gzip; client JS 53 files, 243942 raw / 98755 gzip; CSS 2 files,
  2892 raw / **1024 gzip** bytes. All fit the existing limits; CSS has no gzip slack.
- **Coverage distinction:** Hono accessibility/Lighthouse and public visual specs
  do not exercise these Kit admin leaves. The new built-runtime check runs after
  the Kit adapter build in CI and verifies nine executed cases with a TAP guard.
  No masks, budgets or committed golden baselines change.
