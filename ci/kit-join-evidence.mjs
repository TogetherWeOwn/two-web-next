import assert from "node:assert/strict";

// Synthetic page data exercises the actual Kit components, not OAuth callbacks
// or the disabled route dispatch. Keep this list limited to implemented states.
const joinStates = {
  join: {
    widgetSnapshot: {
      name: "Together We Own",
      presenceCount: 1,
      inviteUrl: null,
      channels: [],
      members: [{ username: "Synthetic Fixture Member" }],
    },
  },
  joinStartFailed: { notice: "start-failed" },
  joinAdded: { joinResult: "added" },
  joinAlreadyMember: { joinResult: "already_member" },
  joinRestoredWrite: { restoredWrite: true },
};

const joinRetry = {
  retryUrl: "/join/discord?next=%2Fevents&source=web-homepage",
  retryLabel: "Try again",
  inviteUrl: "https://discord.gg/invite",
};

// These models are supplied by the fixture, not by a public callback route.
const callbackRecoveryStates = {
  joinDenied: { title: "Join cancelled", message: "No problem. Nothing was shared." },
  joinBotFailed: {
    title: "We couldn't add you automatically",
    message: "The bot will give you your rank when it's back.",
    supportReference: "fixture <em>42</em> & queued",
  },
  joinExpired: {
    title: "Join approval expired",
    message: "That Discord approval expired. Try again or use the invite below.",
  },
};

export const joinEvidenceStates = Object.freeze([
  ...Object.keys(joinStates),
  ...Object.keys(callbackRecoveryStates),
  "recovery",
  "eventGone",
]);

export function isJoinPage(state) {
  return Object.hasOwn(joinStates, state);
}

export function joinEvidencePage(state) {
  if (!joinEvidenceStates.includes(state)) throw new Error(`Unknown join evidence state: ${state}`);
  if (state === "recovery") {
    const data = {
      title: "Your session expired",
      message:
        "Your earlier changes were not saved. Sign in again, then review and submit them when you are ready.",
      retryUrl: "/auth/discord?next=%2Fevents",
      retryLabel: "Log in with Discord",
      inviteUrl: "/discord",
    };
    return `<script>
import RecoveryPage from '../auth/recover/+page.svelte';
const data = ${JSON.stringify(data)};
</script>
<RecoveryPage {data} />`;
  }
  if (Object.hasOwn(callbackRecoveryStates, state)) {
    const model = { ...callbackRecoveryStates[state], ...joinRetry };
    return `<script>
import Recovery from '#lib/Recovery.svelte';
const model = ${JSON.stringify(model)};
</script>
<Recovery {...model} />`;
  }
  if (state === "eventGone") {
    const model = {
      title: "Cancelled game night",
      game: "Chess",
      eventKey: "game-night",
      icsUrl: "/events/game-night.ics",
      markdownAlternate: "/e/game-night.md",
      upcomingUrl: "/events",
      related: [],
      existingResponses: 0,
      jsonLd: "{}",
      siteJsonLd: "{}",
    };
    return `<script>
import EventGone from '#lib/EventGone.svelte';
const model = ${JSON.stringify(model)};
</script>
<EventGone {model} />`;
  }
  const data = {
    inviteUrl: "https://discord.gg/invite",
    widgetUrl: null,
    widgetSnapshot: null,
    oneClickHref: "/join/discord?next=%2Fevents&source=web-homepage",
    appUrl: "https://example.test",
    joinResult: null,
    notice: null,
    restoredWrite: false,
    ...joinStates[state],
  };
  return `<script>
import JoinPage from '../join/+page.svelte';
import { HOME_JOIN_RESULT_COPY, JOIN_INTRO } from '../../../../src/home-copy';
const data = ${JSON.stringify(data)};
data.joinCopy = { HOME_JOIN_RESULT_COPY, JOIN_INTRO };
</script>
<JoinPage {data} />`;
}

export async function assertJoinEvidence(page, state, shell) {
  if (!joinEvidenceStates.includes(state)) throw new Error(`Unknown join evidence state: ${state}`);
  if (!["baseline", "ember"].includes(shell)) throw new Error(`Unknown join shell: ${shell}`);
  assert.equal(await page.locator("[data-kit-site-header]").count(), 1);
  assert.equal(await page.locator("main").count(), 1);
  assert.equal(await page.locator("main#main").count(), 1);
  assert.equal(await page.locator("footer").count(), 1);
  assert.equal(await page.locator("footer.ember-footer").count(), shell === "ember" ? 1 : 0);
  assert.equal(
    await page.getByRole("link", { name: "Skip to content" }).getAttribute("href"),
    "#main",
  );
  if (state === "eventGone") {
    assert.equal(
      await page.getByRole("heading", { level: 1 }).textContent(),
      "Cancelled game night",
    );
    assert.equal(await page.getByTestId("event-cancelled").textContent(), "Cancelled");
    assert.equal(
      await page.getByRole("link", { name: "See upcoming events" }).getAttribute("href"),
      "/events",
    );
    assert.equal(
      await page.getByTestId("event-cancelled-ics").getAttribute("href"),
      "/events/game-night.ics",
    );
    return;
  }
  if (Object.hasOwn(callbackRecoveryStates, state)) {
    const { title, message, supportReference } = callbackRecoveryStates[state];
    assert.equal(await page.locator("#recovery-heading").textContent(), title);
    assert.equal(await page.locator(".recovery-hero .lead").textContent(), message);
    const reference = page.getByTestId("error-support-reference");
    assert.equal(await reference.count(), supportReference ? 1 : 0);
    if (supportReference) {
      assert.equal(await reference.textContent(), supportReference);
      assert.equal(await reference.locator("*").count(), 0);
    }
    const retry = page.getByTestId("recovery-retry");
    assert.equal(await retry.textContent(), joinRetry.retryLabel);
    assert.equal(await retry.getAttribute("href"), joinRetry.retryUrl);
    assert.equal(
      await page.getByTestId("recovery-invite").getAttribute("href"),
      joinRetry.inviteUrl,
    );
    return;
  }
  if (state === "recovery") {
    assert.equal(await page.locator("#recovery-heading").textContent(), "Your session expired");
    assert.equal(
      await page.getByTestId("recovery-retry").getAttribute("href"),
      "/auth/discord?next=%2Fevents",
    );
    assert.equal(await page.getByTestId("recovery-invite").getAttribute("href"), "/discord");
    return;
  }
  assert.equal(
    await page.getByTestId("join-oneclick").getAttribute("href"),
    "/join/discord?next=%2Fevents&source=web-homepage",
  );
  assert.equal(
    await page.getByTestId("join-invite").getAttribute("href"),
    "https://discord.gg/invite",
  );
  assert.equal(
    await page.getByTestId("join-start-notice").count(),
    state === "joinStartFailed" ? 1 : 0,
  );
  assert.equal(
    await page.getByTestId("join-result").count(),
    ["joinAdded", "joinAlreadyMember"].includes(state) ? 1 : 0,
  );
  assert.equal(
    await page.getByTestId("reinvite-link").count(),
    state === "joinAlreadyMember" ? 1 : 0,
  );
  assert.equal(await page.getByTestId("auth-error").count(), state === "joinRestoredWrite" ? 1 : 0);
  if (state === "join") {
    assert.match(await page.getByTestId("join-widget-online").innerText(), /1\s+member online/);
    assert.doesNotMatch(await page.locator("body").innerText(), /Synthetic Fixture Member/);
  }
  if (state === "joinAdded") {
    assert.equal(
      await page.getByTestId("join-result").innerText(),
      "You are in. Finish Discord's rules screening before you can post.",
    );
  }
  if (state === "joinAlreadyMember") {
    assert.match(
      await page.getByTestId("join-result").innerText(),
      /You are already in the server\./,
    );
    assert.equal(await page.getByTestId("reinvite-link").getAttribute("href"), "/discord");
  }
  if (state === "joinStartFailed") {
    assert.equal(
      await page.getByTestId("join-start-notice").innerText(),
      "The Discord approval failed to start — try again below.",
    );
  }
  if (state === "joinRestoredWrite") {
    assert.match(
      await page.getByTestId("auth-error").innerText(),
      /Your earlier changes were not saved\./,
    );
  }
}
