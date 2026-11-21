import assert from "node:assert/strict";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

// Keep the render clock stable without mutating Date in the shared process.
const HOME_EVIDENCE_NOW = Date.UTC(2026, 9, 20, 12);
const member = {
  userId: "member-1",
  username: "Member",
  avatar: null,
  member: true,
  moderator: false,
};
const event = {
  source: "canonical",
  eventKey: "game-night-1",
  title: "Game night",
  startsAt: "2026-10-20T19:00:00.000Z",
  timezone: "UTC",
  location: "Online",
  goingCount: 3,
  capacity: null,
};
const agenda = [
  event,
  {
    source: "discord",
    discordId: "community-night",
    title: "Community game night with a long title that wraps on smaller screens",
    startsAt: "2026-10-23T19:00:00.000Z",
    timezone: "America/Argentina/Buenos_Aires",
  },
  { ...event, eventKey: "later", title: "Strategy night", startsAt: "2026-11-01T19:00:00.000Z" },
];
const observedAt = new Date(HOME_EVIDENCE_NOW).toISOString();
const freshSnapshot = { memberCount: 42, onlineCount: 7, observedAt, stale: false };
const zeroOnline = { ...freshSnapshot, onlineCount: 0 };
const states = {
  guest: {},
  member: { session: member },
  guestEvents: { upcomingEvents: [event] },
  guestAgenda: { upcomingEvents: agenda },
  memberAgenda: {
    session: member,
    upcomingEvents: agenda,
    memberRsvps: [{ eventKey: event.eventKey, status: "waitlisted" }],
  },
  memberEvents: {
    session: member,
    upcomingEvents: [
      { ...event, title: "Game night with a long title that wraps on smaller screens" },
    ],
    memberRsvps: [{ eventKey: event.eventKey, status: "going" }],
  },
  memberEventsOutage: { session: member, eventsUnavailable: true },
  staleCounts: {
    countsSnapshot: { ...zeroOnline, observedAt: "2026-10-20T11:00:00.000Z", stale: true },
    upcomingEvents: [event],
  },
  quietOnline: { countsSnapshot: zeroOnline, upcomingEvents: [event] },
  nonmember: { session: { ...member, userId: "player-1", username: "Player", member: false } },
  sessionOutage: { sessionUnavailable: true },
  eventsOutage: { eventsUnavailable: true },
  missingCounts: { counts: { memberCount: null, onlineCount: null, ranks: [] } },
  joinFailed: { notice: "join_failed" },
  joinAdded: { joinResult: "added" },
  alreadyMember: { joinResult: "already_member" },
};

export const homeEvidenceStates = Object.freeze(Object.keys(states));

function fixtureData(state) {
  if (!Object.hasOwn(states, state)) throw new Error(`Unknown home evidence state: ${state}`);
  return {
    session: null,
    sessionUnavailable: false,
    notice: null,
    joinResult: null,
    inviteUrl: "https://discord.gg/invite",
    appUrl: "https://example.test",
    counts: { memberCount: 42, onlineCount: 7, ranks: [] },
    countsSnapshot: state === "missingCounts" ? null : freshSnapshot,
    memberRsvps: [],
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [],
    imageHosts: "",
    ...states[state],
  };
}

export function homeEvidencePage(state, variants = []) {
  const fixtures = Object.fromEntries([state, ...variants].map((key) => [key, fixtureData(key)]));
  return `<script>
import { page } from '$app/state';
import Home from '../+page.svelte';
import { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO } from '../../../../src/home-copy';
const fixtures = ${JSON.stringify(fixtures)};
const key = page.url.searchParams.get('state') ?? ${JSON.stringify(state)};
if (!Object.hasOwn(fixtures, key)) throw new Error('Unknown home evidence state');
const data = fixtures[key];
data.upcomingEvents = data.upcomingEvents.map(event => ({ ...event, startsAt: new Date(event.startsAt) }));
data.homeCopy = { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO };
</script>
<Home {data} />`;
}

export async function assertHomeEvidence(page, state) {
  if (!Object.hasOwn(states, state)) throw new Error(`Unknown home evidence state: ${state}`);
  const count = (id) => page.getByTestId(id).count();
  const session = states[state].session;
  assert.equal(await count("join-band"), session?.member ? 0 : 1, `${state}: join band`);
  if (!session?.member) {
    const fallback = state === "sessionOutage" || state === "joinFailed";
    const cta = page.getByTestId(fallback ? "join-band-invite" : "join-band-join");
    assert.equal(await count(fallback ? "join-band-join" : "join-band-invite"), 0);
    assert.equal(
      await cta.getAttribute("href"),
      state === "sessionOutage"
        ? "/discord"
        : state === "joinFailed"
          ? "https://discord.gg/invite"
          : "/auth/discord",
      `${state}: join band destination`,
    );
    assert.match(await page.getByTestId("join-band").innerText(), /Pull up a chair\./);
  }
  assert.equal(await count("signin"), session ? 0 : 1, `${state}: guest header`);
  assert.equal(
    await count("join"),
    !session?.member && state !== "sessionOutage" ? 1 : 0,
    `${state}: join action`,
  );
  assert.equal(await count("member-count"), state === "missingCounts" ? 0 : 1, `${state}: counts`);
  if (state === "staleCounts") {
    assert.equal(await page.getByTestId("member-count").getAttribute("data-stale"), "true");
    assert.match(await page.getByTestId("member-count").innerText(), /0 online.*Last seen/);
  }
  if (state === "quietOnline" || state === "staleCounts") {
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /It's quiet right now|evenings are busiest|In voice now/,
    );
  }
  const memberWithRsvp = state === "memberEvents" || state === "memberAgenda";
  assert.equal(await count("home-event-own-rsvp"), memberWithRsvp ? 1 : 0, `${state}: RSVP badge`);
  const standing = page.getByTestId("home-standing");
  assert.equal(await standing.count(), session?.member ? 1 : 0, `${state}: standing panel`);
  assert.equal(await count("rank-stack"), session?.member ? 0 : 1, `${state}: public rank ladder`);
  if (session?.member) {
    const next = standing.getByRole("link").first();
    const board = standing.getByRole("link", { name: "See where you place" });
    const outage = states[state].eventsUnavailable;
    const href = memberWithRsvp ? "/e/game-night-1" : outage ? "/discord" : "/events";
    assert.equal(await next.getAttribute("href"), href);
    assert.equal(await board.getAttribute("href"), "/leaderboards/members?scope=relative");
    assert.match(
      await standing.innerText(),
      state === "memberAgenda"
        ? /on the waitlist/
        : memberWithRsvp
          ? /going/
          : outage
            ? /couldn’t load your next RSVP/
            : /No upcoming RSVP in this preview/,
    );
    const band = await standing.boundingBox();
    const card = await standing.locator(".standing-card").boundingBox();
    const events = await page.locator(".event-band").boundingBox();
    assert.ok(
      band && card && events && band.y >= events.y + events.height,
      `${state}: standing order`,
    );
    if (page.viewportSize().width <= 820) {
      assert.equal(card.width, band.width, `${state}: standing fills mobile column`);
    } else {
      assert.ok(card.x >= band.x + band.width / 2, `${state}: standing is in desktop right column`);
    }
    await page.locator(".event-band a").last().focus();
    await page.keyboard.press("Tab");
    assert.ok(
      await next.evaluate((el) => el === document.activeElement && el.matches(":focus-visible")),
      `${state}: Tab reaches the next RSVP link from Upcoming Events`,
    );
    await page.keyboard.press("Tab");
    assert.ok(
      await board.evaluate(
        (el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle === "solid",
      ),
    );
    await board.evaluate((el) => el.blur());
  }
  assert.equal(await count("notice"), state === "joinFailed" ? 1 : 0, `${state}: notice`);
  assert.equal(
    await page.getByTestId("home-highlights").locator("li").count(),
    session?.member ? 0 : 4,
  );
  const intro = page.getByTestId("home-guest-intro");
  assert.equal(await intro.count(), session?.member ? 0 : 1, `${state}: guest intro`);
  if (!session?.member) {
    const items = intro.getByRole("listitem");
    const boxes = await Promise.all((await items.all()).map((item) => item.boundingBox()));
    const mobile = page.viewportSize().width <= 820;
    assert.ok(
      boxes.every((box, i) => {
        if (!box) return false;
        if (i === 0) return true;
        const previous = boxes[i - 1];
        return mobile ? box.y > previous.y : box.x > previous.x && box.y === previous.y;
      }),
      `${state}: four highlights in reading order`,
    );
    const lobby = intro.getByRole("link", { name: "View the Discord lobby" });
    const invite = intro.getByRole("link", { name: "Open Discord" });
    assert.equal(await lobby.getAttribute("href"), "/join#join-heading");
    assert.equal(await invite.getAttribute("href"), "/discord");
    await lobby.focus();
    await page.keyboard.press("Tab");
    assert.ok(await invite.evaluate((el) => el.matches(":focus-visible")));
    await page.keyboard.press("Shift+Tab");
    assert.ok(await lobby.evaluate((el) => el.matches(":focus-visible")));
    await lobby.evaluate((el) => el.blur());
  }
  if (!session?.member && state !== "sessionOutage" && state !== "joinFailed")
    assert.match(await page.getByTestId("join-band").innerText(), /Approve once with Discord/);
  assert.equal(
    await count("join-result"),
    ["joinAdded", "alreadyMember"].includes(state) ? 1 : 0,
    `${state}: join result`,
  );
  assert.equal(
    await count("reinvite-link"),
    state === "alreadyMember" ? 1 : 0,
    `${state}: reinvite`,
  );
  assert.equal(
    await count("discord-join"),
    ["sessionOutage", "eventsOutage"].includes(state) ? 1 : 0,
    `${state}: fallback`,
  );
  if (states[state].upcomingEvents) {
    assert.equal(await count("home-events-list"), 1, `${state}: event list`);
    assert.match(await page.getByTestId("home-events-list").innerText(), /Game night/);
  } else {
    assert.equal(
      await page.getByTestId("home-events-empty").getAttribute("data-state"),
      states[state].eventsUnavailable ? "unavailable" : "empty",
    );
  }
  if (state === "guest" && page.viewportSize()?.width === 390) {
    const menu = page.locator(".ember-home-menu");
    const events = menu.getByRole("link", { name: "Events" });
    const summary = menu.locator("summary");
    assert.equal(await events.isVisible(), false);
    await summary.press("Enter");
    const box = await events.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 844, "open Events link is on-screen");
    await page.keyboard.press("Tab");
    assert.equal(await events.evaluate((el) => el === document.activeElement), true);
    await summary.press("Enter");
  }
  if (session?.member)
    assert.equal(
      await page
        .locator(".hero-action")
        .getByRole("link", { name: "Open Discord" })
        .getAttribute("href"),
      "https://discord.gg/invite",
    );
  if (state === "joinFailed")
    assert.equal(
      await page
        .getByRole("link", { name: "Join with an invite link instead" })
        .getAttribute("href"),
      "https://discord.gg/invite",
    );
}

// One disposable build, with each state rendered as its own allowlisted SSR navigation.
export async function withKitHomeEvidenceStates(callback) {
  const [first, ...variants] = homeEvidenceStates;
  return withKitOfflineBrowser(
    {
      page: homeEvidencePage(first, variants),
      searches: homeEvidenceStates.map((state) => `?state=${encodeURIComponent(state)}`),
      now: HOME_EVIDENCE_NOW,
    },
    async ({ page, open }) => {
      await callback(async (state) => {
        await page.setViewportSize(
          state === "guest" ? { width: 390, height: 844 } : { width: 1280, height: 720 },
        );
        await open(`?state=${encodeURIComponent(state)}`);
        await assertHomeEvidence(page, state);
        return page;
      });
    },
  );
}

export async function withKitHomeEvidence(state, callback) {
  return withKitOfflineBrowser(
    { page: homeEvidencePage(state), now: HOME_EVIDENCE_NOW },
    async (fixture) => {
      if (state === "guest") await fixture.page.setViewportSize({ width: 390, height: 844 });
      await assertHomeEvidence(fixture.page, state);
      return callback(fixture);
    },
  );
}
