# Game-scoped calendar subscriptions: visual evidence

Real Hono `/events` SSR against the acceptance SQL/Discord fixture
(`test/helpers/calendar-game-subscription.ts`), served with `public/` and shot
in headless Chromium. Every image below was opened and read.

- `after-all-1280.png`, `after-all-390.png`: unfiltered schedule. Byte-identical
  to before the change (`test/calendar-subscribe-affordance.test.ts` pins the
  exact Subscribe/download markup), so these stand as the before shots too.
- `after-game-1280.png`, `after-game-390.png`: `?game=Helldivers 2`. The facet
  select shows the game; Subscribe/download carry the scope in their hrefs.
- `after-game-open-1280.png`, `after-game-open-390.png`: same page with the
  subscription help open. The label reads "Helldivers 2 calendar feed URL" and
  the input holds `https://calendar.example.test/events.ics?game=Helldivers+2`.

Unchanged: Open Lobby theme, Logo 1, tokens, layout, guidance wording, RSS link,
past-archive links. Hostile/Unicode game rendering (no element injection) and
keyboard/no-JS journeys are covered by
`test/calendar-game-subscription-acceptance.test.ts` (16/16 green).

Design contract (short): audience = members who play one game; screen job =
subscribe to that game only; primary action = Subscribe/download/copy feed URL;
layout = unchanged schedule page, only hrefs + the feed label gain the scope;
tokens/type = untouched; responsive = same breakpoints; states = all-events
(unchanged bytes), scoped, scoped-unknown (empty calendar, truthful label),
failed/superseded fragment (previous scope intact); non-goals = RSS, personal
feeds, q-as-filter, wording/order of the subscribe controls.

Mechanism note: the help `<details>` itself is the `subscribe` swapped zone,
so fragment commits refresh the scoped fields with the head links while the
stable node keeps its open state; the replaced copy button rebinds through
copy-link.js. No events-calendar.js change was needed (its budget had 43B raw
/ 20B gzip headroom); copy-link.js fits at 2017/2048B raw, 970/1024B gzip.
