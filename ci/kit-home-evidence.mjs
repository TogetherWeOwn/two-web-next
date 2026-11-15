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
const states = {
  guest: {},
  member: { session: member },
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
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [],
    imageHosts: "",
    ...states[state],
  };
  return `<script>
import Home from '../+page.svelte';
import { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS } from '../../../../src/home-copy';
const data = ${JSON.stringify(data)};
data.homeCopy = { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS };
</script>
<Home {data} />`;
}

export async function assertHomeEvidence(page, state) {
  if (!Object.hasOwn(states, state)) throw new Error(`Unknown home evidence state: ${state}`);
  const count = (id) => page.getByTestId(id).count();
  const session = states[state].session;
  assert.equal(await count("signin"), session ? 0 : 1, `${state}: guest header`);
  assert.equal(
    await count("join"),
    !session?.member && state !== "sessionOutage" ? 1 : 0,
    `${state}: join action`,
  );
  assert.equal(await count("member-count"), state === "missingCounts" ? 0 : 1, `${state}: counts`);
  assert.equal(await count("notice"), state === "joinFailed" ? 1 : 0, `${state}: notice`);
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
  assert.equal(
    await page.getByTestId("home-events-empty").getAttribute("data-state"),
    state === "eventsOutage" ? "unavailable" : "empty",
  );
  if (session?.member)
    assert.equal(
      await page.getByRole("link", { name: "Open Discord" }).getAttribute("href"),
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
      await assertHomeEvidence(fixture.page, state);
      return callback(fixture);
    },
  );
}
