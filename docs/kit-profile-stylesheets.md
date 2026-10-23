# Kit profile stylesheet restoration

## Design contract

- **Audience and job:** signed-in members reading their own or a permitted member's profile, including moderators. Keep the existing self-only editor and native navigation usable.
- **Primary action and content:** edit the existing profile fields. Preserve current labels, new-member guidance, member data, metadata and controls; screenshots use synthetic records only.
- **References:** the existing [Hono profile layout](../src/page-shell.tsx), [Kit stylesheet cascade](../web/src/lib/SiteMetadata.svelte) and [profile theme](../public/profile-theme.css).
- **Layout, type and tokens:** restore `/styles.css`, `/theme.css`, then `/profile-theme.css` in the shared view's head. Keep the Vite-built Kit `app.css` token source; do not add Hono's token sheet or invent a new theme.
- **Responsive behavior and states:** retain the theme's desktop grid and narrow-screen stacking. Inspect new/completed owners, permitted other-member readers and moderators at 1280×800 and 390×844.
- **Non-goals:** no redesign, new navigation, read/write changes, framework, dependency, stylesheet rule or route-ownership change. Both shipped Kit profile GET entries remain disabled; Hono still owns POST/PATCH writes.

## Browser evidence

The captures render both actual route loaders, their actual Svelte pages and the root layout inside the real dispatcher. A fixture-only manifest enables the two reads in memory. Local memory profiles, an audit sink and null stats replace external dependencies. Browser requests are intercepted: the document, emitted Vite/Tailwind root CSS, actual linked public stylesheets, fonts and islands are served from local bytes; other requests are refused. No missing profile stylesheet is inserted by the harness.

These are **dispatcher/loader/SSR fixture captures**, not built adapter-Worker end-to-end or staging proof. Only the compiled root CSS is supplied as the framework-owned asset link. Before the repair it loads successfully, but the three public profile sheets are absent. After the repair all four sheets load, the profile details compute to `display: grid`, the display font loads, and no horizontal overflow or page JavaScript error is observed.

All 28 before/after images were opened individually: seven reachable route/presentation combinations at both widths per phase. Other-member and moderator member views have no editor; the moderator's own `/profile` retains it. The representative self-profile owner captures below show the restoration. The same owner fixtures were also inspected at `/members/:user` at both widths.

| State and viewport | Before | After |
| --- | --- | --- |
| New owner, desktop | [Before](images/kit-profile-stylesheets/before-owner-new-1280.png) | [After](images/kit-profile-stylesheets/after-owner-new-1280.png) |
| New owner, mobile | [Before](images/kit-profile-stylesheets/before-owner-new-390.png) | [After](images/kit-profile-stylesheets/after-owner-new-390.png) |
| Completed owner, desktop | [Before](images/kit-profile-stylesheets/before-owner-completed-1280.png) | [After](images/kit-profile-stylesheets/after-owner-completed-1280.png) |
| Completed owner, mobile | [Before](images/kit-profile-stylesheets/before-owner-completed-390.png) | [After](images/kit-profile-stylesheets/after-owner-completed-390.png) |

These evidence images are not visual-regression baselines. No baseline, mask or threshold changed. The repository's Hono a11y/Lighthouse and pinned visual suites do not exercise the disabled Kit profile routes; their results must not be described as Kit parity or enablement evidence.

## Independent regression coverage

The immutable acceptance contribution in [kit-profile-stylesheet-acceptance.test.ts](../test/kit-profile-stylesheet-acceptance.test.ts) exercises both real loaders and root-layout SSR across seven reachable presentations. The original contribution and its one-line loader-event correction are credited through their preserved commit history. Before implementation, seven assertions observed the missing stylesheet cascade; 23 acceptance controls and 19 existing route controls passed. After the three-link repair, all 49 cases passed. Metadata, native controls, bounded reads, private cache policy, self-only editing and disabled ownership remain covered without a live database.
