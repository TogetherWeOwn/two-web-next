# Homepage theme

The purchased HTML landing page is the visual foundation for the homepage. Its centered landing composition, condensed uppercase typography, dark surfaces, lime palette (#a3ff12), square buttons, mirrored angular side details and compact account treatment are adapted to Hono SSR in `src/pages.tsx` and `public/theme.css`. The account reference contributes styling only: Discord OAuth, sessions, guild joins and logout remain the existing flows. There is no password/registration form.

Only the homepage opts into the stylesheet. Other routes retain their current layouts. Wrangler serves the external stylesheet, fonts and logos through the existing `public/` asset binding. No Bootstrap, jQuery, preloader, custom cursor, animation bundle, sample photos, original brand marks or third-party template folders ship. The decorative hero uses neutral CSS shapes instead of stock imagery. Feature images continue through the shared same-origin/approved public host policy, including validated configured hosts.

## Assets

- `public/fonts/display-latin-{500,700}.woff2`: Latin Rajdhani from `@fontsource/rajdhani` 5.3.0 (OFL-1.1). Its unmodified font license is retained in `public/fonts/LICENSE.txt`. Two weights total roughly 31 KB. No remote font origin.
- `public/logo.svg` and `public/icons/*.png`: generated temporary TWO wordmark, not template art. Regenerate all five consistently with `python3 ci/generate-icons.py`. The mark stays inside the maskable safe area. Existing install icon URLs, sizes and manifest identity are unchanged; theme/background colors match the new mark.
- `public/theme.css`: adapted, homepage-scoped rules, under 12 KB uncompressed. Only hover/active feedback, with transitions gated by reduced-motion preference. No client script.

## Discord preview policy

`discordWidgetUrl` accepts only a 10-25 digit configured guild ID. The lazy preview has a title, fixed dimensions, no referrer and `allow-scripts allow-same-origin` sandbox, matching the existing join preview. An invalid/missing guild shows an explicit fallback. The server CSP allows fonts from self and frames only from `https://discord.com/widget` on homepage/join GET and HEAD requests. Other routes and methods retain `frame-src 'none'`; script/style directives remain self-only, with no inline exception. This outbound-frame policy needs independent security review.

## Verification

`test/home-theme.test.ts` covers guest/member/nonmember states, original sign-in/join/logout endpoints, notices/recovery, featured/events/counts, image policy, preview/fallback, identifier validation, strict CSP and scoped assets. Existing page-shell and upcoming-event suites cover landmarks, first-tab skip link, scheduling/privacy and outages. Run only the relevant fixture suites locally; integration suites use the designated test database or CI containers, never staging/production databases.

The merged live counts/ranks reader and rank-stack rendering are retained, including zero/unclaimed and unavailable fallback semantics. Before delivery: inspect desktop/mobile and reduced-motion views, run the current automated accessibility gate, record performance/accessibility evidence, obtain exact-head independent approval and green CI, deploy and complete staging E2E at the tested revision. Local fixture screenshots are not staging proof. Real Discord consent may require an authorized browser identity; a QA-session seam is not a substitute for testing consent itself.
