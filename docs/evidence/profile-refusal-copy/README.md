# Profile refusal copy evidence

## Design contract

- Audience: signed-in members editing their bio and games.
- Screen job: explain a refused draft without losing the member's edits.
- Primary action: correct the draft and press Save.
- Real content: the profile form, with synthetic cooperative-game text containing a C0 control character; the server's existing wording, “Remove control or invisible characters.”
- References: [profile browser contract](../../../src/islands/contracts-member-profile.ts), [server validator](../../../src/profiles/validation.ts), and [the earlier validation change](https://github.com/TogetherWeOwn/two-web-next/pull/2069).
- Layout, typography and tokens: retain the existing profile styles and design-kit tokens. No new visual direction.
- Responsive behavior: existing layout at 1280×800 and 390×844. The longer message wraps naturally on mobile.
- Required states: browser-side refusal and native server 422, both retaining the draft and performing no save.
- Non-goals: admission-policy changes, expanding client validation, new components, budget changes or visual-baseline changes.
- REA angle: use the existing shipped island and authoritative server contract; no external reverse engineering is needed.

## Capture

The real Hono profile route and shipped island ran over in-memory profile/session stores on ephemeral loopback sockets, with the real stylesheets and display font. No database, external identity or staging/production service was used. Each PNG was opened for visual review. These are viewport screenshots scrolled to the error summary, not full-page captures or visual-regression baselines.

The focused regression failed before the copy change and passed afterward (one selected test, 59 deselected). The first diagnostic run also exposed an incorrect test selector and timed out; after correcting the selector, the pre-fix failure was solely the expected wording mismatch.

```sh
env -u DATABASE_URL -u A11Y_DATABASE_URL -u BOT_DATABASE_URL \
  A11Y_BROWSER_TESTS=true PROFILE_REFUSAL_SCREENSHOTS=/tmp/profile-refusal-after \
  timeout 90 npx vitest run test/profile-native-length.test.ts \
  -t 'matches browser and native server control-refusal wording at both widths'
```

Use a different output directory for the pre-fix capture. The test closes its browser contexts and loopback servers in teardown.

| State | Desktop, 1280×800 | Mobile, 390×844 |
| --- | --- | --- |
| Browser before | [Screenshot](before-browser-1280.png) | [Screenshot](before-browser-390.png) |
| Browser after | [Screenshot](after-browser-1280.png) | [Screenshot](after-browser-390.png) |
| Server before | [Screenshot](before-server-1280.png) | [Screenshot](before-server-390.png) |
| Server after | [Screenshot](after-server-1280.png) | [Screenshot](after-server-390.png) |

Browser and native-server error summaries now match. The server screenshots are unchanged controls. The field-associated text remains in the real form below the summary. The existing markup, focus behavior and styles are unchanged.

Full suites, accessibility/Lighthouse gates and visual-regression specifications run in GitHub Actions, not locally. This capture is focused diagnostic and visual evidence, not a substitute for those gates. No intentional baseline changes.
