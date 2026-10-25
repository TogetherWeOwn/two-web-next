# Native event share fixture review

## Design contract

- Audience: guests and members viewing a published public event on a supporting device.
- Screen job: send the event without copying and switching apps manually.
- Primary action: a separate, explicit Share button beside Copy link and the calendar actions.
- Real content: `Chess "night" & friends ♟`, its public canonical event URL, and existing calendar links. Never share the current query, hash, attendee names, account or session information.
- References and assumptions: retain the existing [event detail presentation](../../../src/events/pages-detail.tsx), [Kit presentation](../../../web/src/lib/EventDetail.svelte) and [Copy link fallback](../../../assets/islands/copy-link.js). No new visual direction.
- Layout, typography and tokens: existing Save the date block, linklike button with inherited typography and brand color, 44px minimum height and existing visible keyboard outline. Inline actions wrap naturally on mobile.
- States: hide the button and its separator until secure Web Share capability exists; no call on load; one pending sheet; silent cancellation; truthful failure guidance without a success claim; Copy link stays independent. Draft, gone and missing views offer no Share control.
- Non-goals: automatic posting, social SDKs, analytics, metadata/artwork changes, changed Copy link semantics.

The feature implementation existed before this recovery run. This contract was recorded during recovery before further edits, not retrospectively claimed to have preceded the original implementation.

## Images opened

Full-page images use 1280×800 and 390×844 browser viewports. The before images are the acceptance author's immutable fixture captures from before the implementation. The after images were captured by the unchanged acceptance browser suite against this implementation. All eight full-page images and all four state sheets were opened for visual review.

| Renderer / viewport | Before | After |
| --- | --- | --- |
| Hono / desktop | [Before](before-hono-1280x800.png) | [After](after-hono-1280x800.png) |
| Hono / mobile | [Before](before-hono-390x844.png) | [After](after-hono-390x844.png) |
| Kit / desktop | [Before](before-kit-1280x800.png) | [After](after-kit-1280x800.png) |
| Kit / mobile | [Before](before-kit-390x844.png) | [After](after-kit-390x844.png) |

The SSR Kit fixture omits the application-shell theme attribute, so it renders the existing light theme in both before and after images. This is not a theme change. Hono renders its normal dark theme. The device share sheet itself is stubbed: these images prove the actual rendered page and shipped island, not operating-system integration.

The following sheets show actual Save the date section captures in this order: rejected share with keyboard focus retained, pending share with focus retained, unsupported API, and JavaScript disabled. They were captured at the stated viewport widths, with visibility/focus assertions. Unsupported and no-JS states have no orphan separator.

| Renderer | Desktop states | Mobile states |
| --- | --- | --- |
| Hono | [1280px](hono-states-1280.png) | [390px](hono-states-390.png) |
| Kit | [1280px](kit-states-1280.png) | [390px](kit-states-390.png) |

## Executed focused verification

- `npx vitest run test/event-native-share-acceptance.test.ts`: 20 passed.
- `node --import tsx --test ci/event-native-share-browser.test.mjs` with the evidence directory enabled: 34 behavioral cases plus two screenshot captures passed, zero skips. Existing local browser libraries were supplied through `LD_LIBRARY_PATH`; without them Chromium failed to launch, not a product failure.
- `node --test ci/a11y-*.test.mjs ci/visual-accept.test.mjs`: 111 passed.
- `npm run lint`, `npm run build:assets:check`, `npm run budget`: passed.

The renderer suite, browser suite and shared fixture remain byte-identical to the independently authored corrected acceptance handoff. Its original missing-button RED run is recorded on public [PR #1691](https://github.com/TogetherWeOwn/two-web-next/pull/1691); the combined behavior PR supersedes that test-only handoff.

The Hono accessibility and Lighthouse gates do not exercise the Kit route. These Kit SSR captures and real-Chromium behavior cases provide the additional presentation evidence. Pinned-runner CI visual comparisons remain authoritative; no baselines or thresholds were changed here. See the PR Verification section for full-suite and quality-gate results, including any local limitations.
