# Blocking occurrence diagnostic

## Design contract

- **Audience:** a moderator correcting a recurring-event edit.
- **Screen job:** identify the occurrence whose shifted end would not be after its start.
- **Primary action:** revise the series times or correct that occurrence before retrying.
- **Real content:** the existing `ends_at` refusal, with the blocking occurrence's public event key. No member data or row dump.
- **References:** [existing event form](../../../src/admin/pages/event-form-fields.tsx), [validation summary](../../../src/admin/pages/validation-summary.tsx), and [shared field rendering](../../../src/admin/pages/shell.tsx).
- **Layout, type and tokens:** unchanged native form, summary, associated field error and existing admin styles.
- **Responsive behavior:** existing stacked fields; the key and diagnostic wrap within the mobile content width.
- **Required states:** refused series edit in the native form; JSON field refusal; separate, unchanged parent-window validation.
- **Non-goals:** new controls, links, schema, recurrence behavior, locking or transaction changes.

## Native-form evidence

The captures use the real Hono admin router and a disposable SQL fixture, served on a loopback HTTP socket. A synthetic moderator session opens the edit page and submits the native form. Island scripts are blocked for this native-form proof. No staging or production database is used.

The parent is 20:00–22:00, and its individually shortened future occurrence is 20:00–20:30. Moving the parent's end to 21:00 refuses the edit with HTTP 422. The response preserves the submitted parent values and names the shortened occurrence in the existing error locations.

| State | Desktop viewport 1280×800 | Mobile viewport 390×844 |
| --- | --- | --- |
| Before | [Full-page screenshot](before-1280.png) | [Full-page screenshot](before-390.png) |
| After | [Full-page screenshot](after-1280.png) | [Full-page screenshot](after-390.png) |

All four images were opened for visual inspection. Both states at both widths have no horizontal overflow and no serious or critical axe violations. These are local Hono screenshots, not live staging evidence or Kit-route coverage. No visual baseline was changed; the existing public-page visual comparisons remain a separate CI gate.

The after captures were refreshed after integrating the duplicate-event feature. That feature accounts for the extra **Duplicate as draft** action; this diagnostic change does not add a control. The final copy retains the existing sentence, then appends `Blocking occurrence: <public event key>.`, preserving existing consumers of the validation text.

## Acceptance verification

The combined focused run executes both complete suites with the disposable test database supplied:

```sh
npx vitest run test/event-series-window-acceptance.test.ts test/event-series-post-lock-eligibility.test.ts
```

Before implementation: **34 passed, 15 failed, 0 skipped**. Every failure was the missing blocking key. After implementation: **49 passed, 0 failed, 0 skipped**. The complete Hono accessibility gate also passed. These results do not claim completion of the remaining local, CI or release gates.

The acceptance contribution is consumed unchanged from commit `567b507107990f7a37add4cca1bb5ea91561a77e`, retaining its author attribution. Neither acceptance file was rewritten by the implementer.

The later duplicate-source regression suite also requires the original validation sentence. Before the compatibility correction, its complete run produced **35 passed, 2 failed, 0 skipped**. After retaining that sentence and appending the key, all three complete suites produced **86 passed, 0 failed, 0 skipped**:

```sh
npx vitest run test/event-duplicate-source-validation.test.ts test/event-series-window-acceptance.test.ts test/event-series-post-lock-eligibility.test.ts
```

The duplicate-source tests were not modified. Both acceptance-file hashes remain unchanged.
