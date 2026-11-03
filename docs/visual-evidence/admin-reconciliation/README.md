# Moderator reconciliation visual evidence

## Design contract

- **Audience:** moderators investigating keyed bot changes without confirmed outcomes.
- **Screen job:** inspect scalar facts, check Discord independently, then record a resolution without replaying the mutation.
- **Primary action:** Stamp resolved after manual investigation.
- **Content:** synthetic announcement and event intents, UTC timestamps, attempt counts, closed wire codes, and bounded moderator notes. No member data or message bodies.
- **References:** existing [admin shell](../../../src/admin/pages/shell.tsx), [admin RSVP-review stylesheet](../../../assets/admin-rsvp-review.css), and [visual verification rules](../../visual-regression.md). This extends the existing admin kit, not a new visual direction.
- **Layout and typography:** existing shell, labelled scrollable tables, stacked scalar detail facts, existing warning notice, four-row resolution textarea, separate resolved facts and read-only hint.
- **Tokens:** existing paper, ink, brand, and muted colors; no new design tokens.
- **Responsive behavior:** long detail facts wrap; UTC table timestamps stay intact inside horizontal scroll regions. Admin-only CSS stays outside public inlined critical CSS.
- **Required states:** populated/empty lists; open/resolved detail; typed note; blank and overlong validation; successful resolve; unavailable list, detail and resolve.
- **Non-goals:** replay, production flags, new navigation patterns, member-facing reconciliation controls, or a shared admin-header redesign.

## Capture method

The real Hono `adminApp` ran over local HTTP with the same-origin middleware,
a synthetic moderator session, an in-memory reconciliation store and fixture
audit writes. The SQL fixture throws if touched. Chromium via Playwright 1.64.1
navigated list/detail links, filled the textarea and submitted the real resolve
form. CSS came from the built public assets. No production/staging connections
or live Discord requests were used.

Each state was captured with a 1280×800 desktop viewport and a 390×844 mobile
viewport, using full-page screenshots. Every image was opened for inspection.
Document and body scroll widths stayed at or below their viewport widths in all
24 final captures. Wide tables scroll within their labelled regions.

The six **before** images precede the bounded admin-kit fixes. Their resolved
fixture note used announcement wording for an event; the final fixture corrects
that note. They are historical layout evidence, not current behavior.

## Before

| State | Desktop | Mobile |
| --- | --- | --- |
| List | [Before](before/recon-list-desktop.png) | [Before](before/recon-list-mobile.png) |
| Open detail | [Before](before/recon-detail-open-desktop.png) | [Before](before/recon-detail-open-mobile.png) |
| Resolved detail | [Before](before/recon-detail-resolved-desktop.png) | [Before](before/recon-detail-resolved-mobile.png) |

## After

| State | Status | Desktop | Mobile |
| --- | --- | --- | --- |
| Populated list | GET 200 | [After](after/01-list-populated-desktop.png) | [After](after/01-list-populated-mobile.png) |
| Open detail | GET 200 | [After](after/02-detail-open-desktop.png) | [After](after/02-detail-open-mobile.png) |
| Typed note | GET 200 | [After](after/03-detail-open-typed-desktop.png) | [After](after/03-detail-open-typed-mobile.png) |
| Blank note | POST 422 | [After](after/04-post-blank-422-desktop.png) | [After](after/04-post-blank-422-mobile.png) |
| Overlong note, 501 characters retained | POST 422 | [After](after/05-post-overlong-422-desktop.png) | [After](after/05-post-overlong-422-mobile.png) |
| Long scalar facts | GET 200 | [After](after/06-detail-open-long-values-desktop.png) | [After](after/06-detail-open-long-values-mobile.png) |
| Resolved event | GET 200 | [After](after/07-detail-resolved-event-upsert-desktop.png) | [After](after/07-detail-resolved-event-upsert-mobile.png) |
| Successful resolution | POST 303 → GET 200 | [After](after/08-post-valid-resolved-desktop.png) | [After](after/08-post-valid-resolved-mobile.png) |
| Both lists empty | GET 200 | [After](after/09-list-empty-desktop.png) | [After](after/09-list-empty-mobile.png) |
| List unavailable | GET 503 | [After](after/10-list-unavailable-503-desktop.png) | [After](after/10-list-unavailable-503-mobile.png) |
| Detail unavailable | GET 503 | [After](after/11-detail-unavailable-503-desktop.png) | [After](after/11-detail-unavailable-503-mobile.png) |
| Resolve audit unavailable | POST 503 | [After](after/12-post-resolve-unavailable-503-desktop.png) | [After](after/12-post-resolve-unavailable-503-mobile.png) |

Browser `required` and `maxlength` constraints were removed only in the validation
capture driver to exercise server-side refusal. The 501-character submitted note
remained in the textarea. The typed-state screenshots include a focus/skip-link
capture artifact. GET outages retain the existing plain fail-closed response;
POST audit failure uses the existing styled admin error response.

## Verification

- `bin/local-ci.sh -j 8`: 1,238 test files and 26,093 tests passed; 5 existing skipped files / 676 existing skipped tests unchanged. Additional non-UTC suite: 162 passed. Tier-0: 115 passed. Jobs branch coverage: 96.07%, above the unchanged 95.8% floor.
- `npm run a11y`: 168 scans passed, including eight reconciliation scans.
- `npx vitest run test/homepage-mobile-lcp-acceptance.test.ts test/runbook-log-lines.test.ts test/reconciliation-admin.test.ts`: 66 passed.
- `node --test ci/budget-fragments.test.mjs`: 52 passed.
- `node ci/minify-assets.mjs --check` and `node ci/check-bundle-budget.mjs`: passed.
- `npm run check`: passed against the migrated disposable database in the clean verification copy.
- `npm run lighthouse` and `npm run lighthouse:quality`: passed, each with 24/24 reports from local fixtures. These cover the public Hono pages, not the moderator-only reconciliation route.
- Final design review: pass after inspection of all 24 final screenshots; no must-fix items.
- No visual baseline was changed locally. Pinned-runner visual regression and exact-head CI remain separate release gates; fixture screenshots do not prove a deployed release.
