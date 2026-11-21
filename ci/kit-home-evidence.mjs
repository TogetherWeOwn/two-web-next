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
const observedAt = new Date(HOME_EVIDENCE_NOW).toISOString();
const freshSnapshot = { memberCount: 42, onlineCount: 7, observedAt, stale: false };
const zeroOnline = { ...freshSnapshot, onlineCount: 0 };
const states = {
  guest: {},
  member: { session: member },
  guestEvents: { upcomingEvents: [event] },
  memberEvents: {
    session: member,
    upcomingEvents: [event],
    memberRsvps: [{ eventKey: event.eventKey, status: "going" }],
  },
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

export function homeEvidencePage(state) {
  if (!Object.hasOwn(states, state)) throw new Error(`Unknown home evidence state: ${state}`);
  const data = {
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
  return `<script>
import Home from '../+page.svelte';
import { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO } from '../../../../src/home-copy';
const data = ${JSON.stringify(data)};
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
  for (const id of ["home-standing", "home-event-own-rsvp"])
    assert.equal(await count(id), state === "memberEvents" ? 1 : 0, `${state}: ${id}`);
  assert.equal(await count("notice"), state === "joinFailed" ? 1 : 0, `${state}: notice`);
  assert.equal(await page.getByTestId("home-highlights").locator("li").count(), 4);
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
      state === "eventsOutage" ? "unavailable" : "empty",
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
