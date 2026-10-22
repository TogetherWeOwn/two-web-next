# Profile composition limits

## Short UI contract

- **Audience / screen job:** signed-in members editing their own profile. Explain the Bio and Games composition limits before they try to save, so a refusal is never the first they hear of them.
- **Primary action:** keep Save/Cancel semantics exactly as they are. The new content is guidance, not controls: a persistent hint plus a live count above each of the Bio and Games fields.
- **Real content:** Bio hint `Up to 1000 characters.` with a `{n} of 1000 characters` count; Games hint `Up to 20 games, one per line: 80 characters per game, 1700 characters total.` with a `{d} of 20 games, {r} of 1700 characters` count. Over-budget states add words (`{o} over the limit`, `line {n} over 80 characters`), never color alone. Counts use Unicode code points and mirror the server validator exactly (CRLF/CR/LF split, trim, blank omission, case-sensitive dedupe).
- **References / assumptions:** the [existing Hono profile form](../src/profiles/pages.tsx), the [Kit profile view](../web/src/lib/ProfileView.svelte) and the shared [composition copy](../src/profiles/composition.ts) are the references. Reuse the profile theme's helper-text direction rather than introduce a new one. Assumed: hints belong above their label (helper text before the field), errors stay directly after their label.
- **Layout / typography / tokens:** hint and count are plain paragraphs in the existing `.9rem` helper style (counts tuck slightly tighter at `.25rem` top margin). No live regions: typing announces nothing. No native `maxlength`: UTF-16 maxlengths cannot express code-point limits.
- **Responsive / keyboard:** native paragraphs reflow at 1280×800 and 390×844 with no horizontal overflow; nothing focusable is added, so keyboard flows and focus ownership are unchanged.
- **Required states:** normal (seeded counts), over-limit (live worded overages, untruncated drafts), and error (refusal keeps hints/counts and appends field errors after them) in both renderers; explicit reset and accepted-save normalization refresh counts. Timezone helper, participation CTA, drafts and pending/rejected/late response ownership are unchanged.
- **Non-goals:** changing validator limits or normalization, native maxlengths, new network writes or telemetry, timezone behavior, draft persistence redesign, or a profile redesign.

## Opened Hono screenshots

Captured from the real Hono profile routes over a local socket with synthetic memory-store fixtures and shipped CSS/fonts/islands, in real Chromium. Each image was opened for visual review. These are full-page captures with the stated viewport. There are no before captures: the change only adds the four hint/count paragraphs (the failing-first acceptance run proves their prior absence), so the before state is each capture minus those lines.

| State / viewport | 1280×800 | 390×844 |
| --- | --- | --- |
| Normal, seeded counts | [Opened capture](images/profile-composition/after-normal-hono-1280.png) | [Opened capture](images/profile-composition/after-normal-hono-390.png) |
| Over-limit, live counts | [Opened capture](images/profile-composition/after-over-limit-hono-1280.png) | [Opened capture](images/profile-composition/after-over-limit-hono-390.png) |
| Refused save, errors beside hints | [Opened capture](images/profile-composition/after-error-hono-1280.png) | [Opened capture](images/profile-composition/after-error-hono-390.png) |

Hints and counts sit above their labels in the existing helper-text rhythm at both widths. Over-limit counts name the overage in words while the full draft stays in the controls. The refused save shows the error summary with field links plus inline errors directly under their labels, with hints and counts intact above. The focused games field keeps its visible focus ring; mobile wraps with no horizontal overflow. No screenshot baseline changed: the visual specs cover public routes only, and the profile page is not among them.

## Implementation and verification boundaries

Both renderers seed the same nodes from the shared composition module; the member-profile island refreshes those nodes after input, explicit reset (past native restore) and accepted-save normalization. Typing makes zero requests. `aria-describedby` is exactly `hint count`, with the field-error id appended while its error renders; clearing errors removes only the error token. Count nodes carry no `aria-live` or `role`.

Independent acceptance uses synthetic fixtures, real Hono routes, the compiled Svelte SSR twin, the shipped minified binder and real-Chromium typing/reset/save journeys, including emoji, combining marks, CRLF/CR/LF splits, blanks, duplicate and case-distinct names, and the 80/1000/1700/20 boundaries. Record exact-head CI/review and staging/production release evidence separately from local fixture screenshots. No visual baseline or budget change is intended.

### Kit evidence and existing layout limitation

The local Kit fixture SSR-compiles the real `ProfileView` with the same stored member and serves it over loopback with the shipped assets. Profile reads stay Hono-owned, so these captures are supplemental styling studies under the same public sheets the Hono page links, not deployed-route evidence or a styled-profile parity pass (see the navigation doc's limitation note, which still applies). DOM parity between the twins is proven by the SSR twin tests; the captures below confirm the twin's nodes lay out identically given the same sheets.

| Kit SSR state | 1280×800 | 390×844 |
| --- | --- | --- |
| Normal, seeded counts | [Opened capture](images/profile-composition/after-normal-kit-1280.png) | [Opened capture](images/profile-composition/after-normal-kit-390.png) |

Hono accessibility/Lighthouse/visual gates do not exercise a Kit route. Kit component/browser evidence is separate; it is not proof that production serves Kit-owned profile reads. Profile route ownership and release configuration are unchanged.
