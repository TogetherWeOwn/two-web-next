# FAQ topic jumps and answer bookmarks

## Design contract

- **Audience and job:** newcomers finding an answer, and moderators sharing one
  answer rather than the top of the FAQ. Topic jumps are the primary action;
  “Link to this answer” is the secondary action.
- **Content:** retain the eight topics, 18 questions, answer order, prose and
  recovery-guide destination. The first three shared tuple positions remain
  question, answer and optional guide link. The fourth is an explicit answer ID.
  Treat published answer IDs as permanent, including when rank copy changes.
- **Layout and typography:** retain the existing leaf shell, typography and
  cards. Reuse the existing responsive grid for topic links. No new theme,
  icons, font, animation, accordion or client script.
- **States:** the default page, topic target, answer target, long fallback answer
  and unknown bookmark remain readable at 1280×800 and 390×844 without JavaScript.
  Hash destinations accept native focus and have a visible outline. Topic
  headings align to the start of their grid cell rather than stretching the
  target outline down an entire section.
- **Non-goals:** copy changes, new topics, live rank reads, search and analytics.

References: the existing community-information navigation and FAQ cards are the
visual authority. Behavior follows [native fragment navigation](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#linking_to_an_element_on_the_same_page)
and [descriptive link purpose](https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html).

## Local fixture screenshots

These images show real Hono route output and real Kit page SSR with the served
content-leaf transform, local assets and JavaScript disabled. They are not a
staging/deployment claim or replacements for the CI visual baselines. System
font rendering is local to this capture environment, not the pinned CI runner.
Every linked image was opened during implementation.

| Renderer / viewport | Before | After |
| --- | --- | --- |
| Hono 1280×800 | [Before](screenshots/faq-navigation/before-hono-1280.png) | [After](screenshots/faq-navigation/after-hono-1280.png) |
| Hono 390×844 | [Before](screenshots/faq-navigation/before-hono-390.png) | [After](screenshots/faq-navigation/after-hono-390.png) |
| Kit 1280×800 | [Before](screenshots/faq-navigation/before-kit-1280.png) | [After](screenshots/faq-navigation/after-kit-1280.png) |
| Kit 390×844 | [Before](screenshots/faq-navigation/before-kit-390.png) | [After](screenshots/faq-navigation/after-kit-390.png) |

The independent Playwright corpus in
`e2e/faq-answer-navigation-acceptance.spec.ts` exercises both renderers, all
published targets, copy/reordering stability, keyboard topic jumps and fresh
answer bookmarks at both widths, public caching and Markdown controls. The
existing Hono a11y/Lighthouse gates do not exercise the built Kit route. Kit
fixture screenshots and the paired SSR/browser cases supplement those gates;
CI still owns the built-worker and pinned-runner visual verdicts.
