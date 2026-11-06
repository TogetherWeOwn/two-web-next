# Authored text: before and after

## Design contract

Members scan organizer descriptions and moderator posts before opening an event
or its full description. Preserve authored line and paragraph breaks only on
schedule descriptions, excerpts and full text, featured bodies, and archive
search passages. References are the existing event-detail description and
profile-bio `pre-line` treatment. Keep Open Lobby/Logo 1, layout, typography,
tokens, titles, time lines, action columns and responsive grids unchanged.

Required states: multi-paragraph, single-line, trailing newline, long unbroken
word, marked search passage, closed/open full-description disclosure and literal
markup/URLs. No Markdown interpretation, autolinking, print redesign, new
framework, route-flag change or budget allowance.

## Fixture evidence

Each image pairs **before on the left** with **after on the right**. Full-page
captures use desktop 1280×800 and mobile 390×844 viewports. All 32 original
captures were opened for visual inspection. These are local fixtures rendered
through the real Hono screens, the shared Kit calendar endpoint renderer, and
compiled Svelte home/archive components, with the served public stylesheets and
built Kit global CSS. No live database, production data or external resource
requests were used for these screenshots.

The home fixture includes multi-paragraph, single-line, trailing-newline and
long-word/literal-markup bodies. Schedule fixtures include a marked short
passage, long excerpt/disclosure, single-line control and long-word/literal
markup. Archive fixtures include marked multi-paragraph, single-line,
trailing-newline and long-word/literal-markup passages. The fixture home scroll
and disclosure click can expose the existing skip link; it is unchanged.

The renderer fixtures retain their respective existing shell palettes. Hono
accessibility/Lighthouse gates do not exercise the Svelte home/archive routes.
These images are rendering evidence, not CI baseline replacements or evidence
of a deployed release.

| Renderer and surface | Desktop | Mobile |
| --- | --- | --- |
| Hono schedule, closed | [Before / after](hono-schedule-1280.png) | [Before / after](hono-schedule-390.png) |
| Hono schedule, open | [Before / after](hono-schedule-1280-open.png) | [Before / after](hono-schedule-390-open.png) |
| Kit schedule, closed | [Before / after](kit-schedule-1280.png) | [Before / after](kit-schedule-390.png) |
| Kit schedule, open | [Before / after](kit-schedule-1280-open.png) | [Before / after](kit-schedule-390-open.png) |
| Hono featured bodies | [Before / after](hono-home-1280.png) | [Before / after](hono-home-390.png) |
| Kit featured bodies | [Before / after](kit-home-1280.png) | [Before / after](kit-home-390.png) |
| Hono archive passages | [Before / after](hono-archive-1280.png) | [Before / after](hono-archive-390.png) |
| Kit archive passages | [Before / after](kit-archive-1280.png) | [Before / after](kit-archive-390.png) |

## Browser observations

- The five authored-text targets compute `white-space: pre-line` after the change.
- Multi-paragraph short descriptions and archive passages display three nonblank
  text lines separated by the authored blank line, rather than one collapsed run
  at desktop width. Search marks remain present.
- All 12 single-line surface/renderer/viewport controls retain identical text,
  width, height, rendered-line count, mark count and link count before/after.
  This is structural/dimensional evidence, not a whole-page pixel-equality claim.
- All 12 long-token surface/renderer/viewport probes compute
  `overflow-wrap: anywhere`; none has horizontal element or page overflow.
- Authored markup and URLs remain literal text. No links or executable elements
  are introduced by the whitespace treatment.

The independent regression command is:

```sh
npx vitest run test/authored-text-line-breaks-acceptance.test.ts test/calendar-card-scan-acceptance.test.ts
```

The authored-text suite was observed failing 18 of 37 cases before the fix and
passing all 37 afterward. The combined command passes all 97 cases after the
independent short-paragraph class expectation correction.
