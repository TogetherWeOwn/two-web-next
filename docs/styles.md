# Small, external stylesheet

`public/styles.css` is minified and declaration-factored to fit the original
3072-byte raw / 1280-byte gzip ceiling. The ceiling is not adjusted when main
grows. The matching class composition lives in server-rendered page components;
islands continue to select stable data attributes, not these styling tokens.

## Tokens

| Original styling class | Current token |
| --- | --- |
| strap / lead | st / ld |
| btn / link / who | bt / ln / w |
| notice / facts / card / counts | nt / ft / cd / cnt |
| rank-stack / home-events / home-event-link | rst / hes / hel |
| featured-image / skip-link | fimg / sl |
| admin-table / field / hint / error | tbl / fd / hn / err |
| actions / filters / error-events-search | act / flt / ees |
| avatar / avatar-initial | av / ai |

Shared declarations use `rw` (flex), `ct` (center alignment), `bk` (block),
`mt` (muted color), `bd` (700 weight), `pl` (no text decoration), `cp`
(uppercase), and `ifnt` (inherited font). For example, a former `btn` renders
`class="bt ct bd cp pl"`; a former `bar` renders `class="bar rw ct"`.
Do not add just the compact structural token when its shared declarations are
also required. Preserve the avatar's `[hidden]` rule after composing flex/block
utilities: native hidden must still override both image and initial displays.

## Equivalence and gates

`test/helpers/styles-baseline.css` captures main `c502ca4` before factoring.
`test/style-equivalence.test.ts` renders the mounted public/admin/error shells
using local row doubles and memory sessions, plus populated home and both
avatar states. Only the comparison side maps styling tokens back to the original
names and removes shared declaration classes. It compares all computed CSS
properties (excluding the intentionally inlined custom properties) and element
bounds at 360px and 1280px, including keyboard focus, hover and broken-avatar
fallback. An intentional font-size change proves the comparison detects loss.
Scripts, embeds and external resource loads are disabled in this comparison.

Run:

```sh
npm run check
CSS_BROWSER_TESTS=true npx vitest run test/style-equivalence.test.ts
```

The second command requires Playwright Chromium and its OS libraries. CI runs
it in the Lighthouse job's private container before collection; failing proof
fails that job and the required `check`. This is fixture/rendering evidence,
not staging E2E or authorization for a production deployment.
