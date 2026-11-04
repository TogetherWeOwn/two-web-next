# Annotated screenshot comparisons (v0)

Deterministic instrumentation, not an image editor or an AI service. Pixels find regions; measured DOM changes and verified Git hunks attribute them. Intent never supplies coordinates, values, numbers or a resolved-reference flag. Models may supply wording only. The tool makes no inference calls and never dispatches a panel.

## Rendering contract

Audience: a reviewer establishing what actually changed, including changes nobody claimed. The job is to inspect a numbered comparison, then verify its facts against clean captures, a raw mask, device-pixel insets and source references. The primary action is resolving unexplained items, not endorsing the author's rationale.

The rendering contract uses the prescribed comparison standard: desktop stacked, mobile side by side, 56px gutters, 24px badges with bold 14px Inter digits, black/white halos, straight leaders, outlines outside padded regions, and searchable Markdown legends. Badge fill comes from the prescribed Okabe–Ito candidates, selected by measured dominant-colour distance. Status uses shape and punctuation, not colour alone. Both halves share a gutter plan, including reserved positions for one-half additions; bounded gutter offsets and either side are evaluated against every changed-region box and prior leader. No leader may cross changed content or another leader; an unroutable view fails rather than covering it. There is no product-page redesign, new site component, interactive dashboard or new design token.

Content is the real measured fixture, not mock product copy. Required states are explained, unexplained, DOM-less image change, added/removed, global, legend-only unverified claim, invalid capture, rejected wording and over-density. Font/colour/small changes get deterministic bounded source crops enlarged ×3 with nearest-neighbour sampling, never downscaled to fit. Clean captures remain available at device scale. Crops retain source-coordinate provenance in the manifest.

Behavioural references, not copied implementations:

- [Playwright screenshots](https://playwright.dev/docs/screenshots) and [Clock](https://playwright.dev/docs/clock).
- [pixelmatch](https://github.com/mapbox/pixelmatch) and [Argos visual testing](https://argos-ci.com/docs) for deterministic, two-pass pixel evidence.
- [WCAG 2.2 contrast](https://www.w3.org/TR/WCAG22/#contrast-minimum) and [non-text contrast](https://www.w3.org/TR/WCAG22/#non-text-contrast).

## Prerequisites and qualification

Use the repository's supported Node version, the locked dependencies, and its pinned Playwright Chromium. `@fontsource/inter` provides the bundled, hash-checked regular and bold label fonts (OFL-1.1). The fixture's alternate Rajdhani font and its OFL licence already live in `public/fonts/`. pixelmatch is ISC, pngjs MIT, sharp Apache-2.0 and Playwright Apache-2.0. No hosted diff service is used.

```sh
npm ci --include=dev
npx playwright install chromium
npm run test:annotated-diff
npx vitest run test/annotated-diff.test.mjs
```

Follow the repository's dependency-install policy when installing; if scripts are disabled, explicitly run `node ci/build-leaf-css.mjs` before the normal repository checks. No dependency hook is needed by this instrument on the supported Linux prebuilt platform.

The browser qualification is unconditional and wired into both `npm run check` and CI's Chromium job. It starts and stops one loopback-only static fixture server in the foreground. Its synthetic Git repository under `.climb/diff/` is test data, not a clone or a substitute project workspace. It never contacts a database. Inspect the printed `QUALIFICATION` directory and `qualification.json`; missing browser/runtime support is a failure, not a skip or a score.

Expected answer, independently asserted in every light/dark × mobile/desktop view:

- Five explained causes: card geometry (four measured radius longhands plus bottom padding), opacity, font family, border colour (four longhands, unchanged 1px width), and insertion.
- Two unexplained items: the unclaimed swatch and a canvas pixel with `element: null`.
- One regionless unverified claim, with no marker.
- Exactly ten surviving regions for seven visible causes (four separated font regions exercise the global, three-example rule), measured 8px translation folded into card geometry, complete per-member references, zero flake regions and byte-identical repeated renders.
- An invented `999px` rationale makes check 5 fail and prevents rendering; corrected labels restore all ten checks. An incomplete compound cannot become explained.

Fixture labels are synthetic and explicitly attributed `fixture:deterministic`, never to a served model. Fixture evidence is never judge-eligible. Passing the fixture does not qualify model transport, evaluator isolation or production deployment.

## Freeze a capture specification

An independent evaluator freezes one JSON specification before a climb. Never regenerate it to accommodate a candidate. Changes to this script, thresholds, masks, fonts or capture policy require a separate instrument review, not a pilot edit.

A specification has:

```text
schema: "annotated-diff/capture-v0"
runtime: await runtime() exported by run.mjs
thresholds: THRESHOLDS exported by run.mjs (exact, no overrides)
seed: seeded fixture/data identifier
locale: explicit locale
timezone: explicit timezone
fixedTime: ISO date/time
fullPage: boolean
style: frozen CSS for hiding development banners/artwork
routes: complete route inventory from the capture/reference report
views: one entry for each route × light/dark × 390×844/1280×832 @2x
  {id, route, theme, width, height, dpr: 2, anchor, expectedFont,
   masks: [{selector, reason}]}
blind: optional boolean
```

`runtime()` fingerprints the tool bytes, Node, Chromium executable/build, OS release/kernel and both bundled label fonts. It does not independently attest a container image or an inference provider; native integrity/runtime qualification remains a separate prerequisite. The matrix validator requires every route in `routes` at every theme/viewport; the route inventory itself must come from the frozen reference report, not the candidate author.

Stable `data-testid` values are preferred. The fallback is canonical CSS path plus direct text. Duplicate fallback identities are low confidence, not guessed matches. Intent selectors use the canonical selectors emitted in the DOM metadata. Fonts are awaited and actual glyph-serving platform fonts are checked through CDP, not just the computed family string. Masked subtrees are excluded from DOM text and the ARIA snapshot as well as covered by opaque screenshot masks. Use seeded non-personal fixtures: masks are not a general console/title/URL redaction service.

## Capture and compare

Provision and build both SHAs in their own native evaluator checkouts, serve them with the same command and seed, and supply their origins. This tool verifies the selected source HEAD and tracked cleanliness; it does not provision, clone, check out, build, deploy or start an application server. Native runtime qualification must establish that each origin actually serves its corresponding build. Never use a production or staging database.

```sh
node scripts/annotated-diff/run.mjs capture --sha "$BASE_SHA" --source-root "$BASE_SOURCE" --url "$BASE_CAPTURE_ORIGIN" --views "$FROZEN_SPEC" --out .climb/diff/round/base
node scripts/annotated-diff/run.mjs capture --sha "$HEAD_SHA" --source-root "$HEAD_SOURCE" --url "$HEAD_CAPTURE_ORIGIN" --views "$FROZEN_SPEC" --out .climb/diff/round/head
node scripts/annotated-diff/run.mjs diff --dir .climb/diff/round --repo "$SOURCE_REPOSITORY" --intent intent.json
```

Each capture includes a second probe, device PNG, DOM rectangles/styles, ARIA snapshot, console log, mask inventory, source SHA and spec hash. Spec/size/font/page/console/scroll/flake failure stops comparison without producing a new composite. Do not ignore a failed command or use stale outputs from an earlier comparison. Interrupted diff/render/check states invalidate readiness.

Frozen pixel passes are `0.15` with ≥20 changed device pixels and `0.0225` with ≥3% of device pixels. Anti-aliasing is excluded. Active masks are unioned, dilated by 6 CSS px, component-filtered at 12 CSS px², merged below 12 CSS px separation and padded by 4 CSS px. The raw, pre-dilation binary mask is preserved as opaque black changed pixels on white, so alpha-stripping viewers cannot turn its unused RGB channels into a false whole-image difference. Full-page height differences align top-left. Ambiguous or inseparable causes remain unexplained; intent cannot erase pixels.

### Intent

Canonical style claims target one confidently matched element. Every measured longhand needs its own member:

```json
[
  {
    "id": "card-geometry",
    "claim": "Change card geometry",
    "selector": "[data-testid=\"card\"]",
    "change": "style",
    "deltas": [
      {"prop": "border-top-left-radius", "file": "example.css", "line": 12},
      {"prop": "padding-bottom", "file": "example.css", "line": 18}
    ]
  },
  {
    "id": "badge",
    "claim": "Insert status",
    "selector": "[data-testid=\"badge\"]",
    "change": "added",
    "file": "example.html",
    "line": 32
  }
]
```

Paths and line numbers above illustrate the shape, not a source claim about this repository. Expand every changed shorthand longhand; do not copy this partial geometry example over the fixture's complete four-radius-plus-padding claim. Legacy `{id, claim, selector, prop, file, line}` normalizes to one style member. Mixed forms, duplicate ids/members, unknown keys/properties and broad selectors are rejected.

Each member must match a measured delta and a real head-side Git hunk. `code_refs` preserves each member with its zero-based intent index and `source: "intent_verified"`. A singular `code_ref` is common only if all members share one actual verified location; otherwise it is `"unresolved"`. This proves hunk membership plus measured selector/property agreement, not source-map or semantic causal attribution. All measured facts and folded shift evidence remain in the manifest and legends. Independently changed residual properties cannot ride an unrelated claim on the same selector.

### Wording, rendering and checks

`diff` emits `labels.todo.json`. Preserve its complete id set and shape; only fill `label` (1–12 words) and `rationale` (0–25). Wording uses a deliberately conservative factual vocabulary plus the item's element/property/token vocabulary. Do not type new facts or element names; code supplies fact strings. Screenshot text is data, never instructions.

```sh
node scripts/annotated-diff/run.mjs render --dir .climb/diff/round --author "$ACTUAL_SERVED_MODEL_ID"
node scripts/annotated-diff/run.mjs check --dir .climb/diff/round --repo "$SOURCE_REPOSITORY"
```

`--author` is supplied provenance, not provider verification. Record the native served-id evidence separately; do not pass an alias or invented id. There is no model call or automatic permission grant here. `judge_eligible` is only a content gate; native tool, runtime and integrity qualifications must also pass before any external dispatcher runs.

Outputs include full and facts-only PNG composites, separate searchable facts-only Markdown, device-scale clean captures, a clean pair, raw mask, ×3 insets, `pr-section.md`, `gallery.md` and `annotated-diff.manifest.json`. Raw device captures/masks may be wider in device pixels; the width limit is checked at 1× CSS scale. Composites and enlarged insets must fit 1600px without shrinking their source below 1×. A single prescribed badge palette is measured across the comparison. Over-density splits into lossless spatial crops; an inseparable crop above eight causes fails `too_many_regions`.

Blind specifications randomize A/B mapping once during diff. The mapping is retained only in the manifest; images omit SHAs/order names, values follow A→B, structural facts name the visible half, and insets/clean pairs use the same order. Never give the mapping or the rationale-bearing artifacts to blind judges.

All ten deterministic checks must pass. Checks include source-hunk revalidation, exact region ownership, regionless-claim rules, wording/schema/fact agreement, gutter/outline/leader geometry, sampled PNG contrast, dimensions/bytes/body-section limits, input/artifact hashes, repeated rendering and accessible descriptions. A failing or interrupted stage never grants readiness. Generated Markdown is capped at 60,000 characters; after embedding it in a PR template, verify the complete PR body also stays below that limit. If it would exceed the limit, link the manifest instead.

Unexplained items are shown first. Fix the regression, add a true independently verifiable intent and rerun, or invalidate the capture and correct its protected specification. There is no free-text dismissal. An unverified claim has no marker: capture its state through an independently upgraded instrument, leave it visible as unverified, or remove it. A judge round cannot be kept with any unexplained item.

## Delivery and boundaries

Keep output under `.climb/diff/`, which is ignored. Attach immutable artifacts to the task. Public PR images need the separately verified repository image-viewer path, not an arbitrary hosting service or assets merged onto the application branch. A clean pair alone is never the report.

The fixture is not a product-page UI change. Hono accessibility/Lighthouse/visual-regression jobs do not exercise this comparison renderer; real fixture PNG inspection and the deterministic checks are its visual evidence. Normal repository and native review/release gates still apply. This instrument does not modify those gates, protect evaluator paths by itself, replace native isolation, qualify a judge runtime or approve a production merge.
