import assert from "node:assert/strict";

// Synthetic rows for the real Kit home component. The capture clock is fixed
// at 2026-10-20 12:00 UTC by kit-home-capture.mjs.
const baseEvent = {
  source: "canonical",
  eventKey: "game-night",
  title: "Game night",
  startsAt: "2026-10-20T19:00:00.000Z",
  timezone: "UTC",
  location: "Table 2",
  game: "  Wingspan  ",
  organizer_name: "  Riley  ",
  goingCount: 1,
  goingOccupancy: 1,
  capacity: 4,
};

const cases = {
  ended: { endsAt: "2026-10-20T11:00:00.000Z", rsvpOpen: false, capacity: 1 },
  paused: { rsvpOpen: false, capacity: 1 },
  full: { capacity: 1 },
  oneSeat: { capacity: 2 },
  seats: {},
  unlimited: { capacity: null },
  blank: { game: "  ", organizer_name: "  " },
  discord: {
    source: "discord",
    discordId: "123",
    title: "Community night",
    startsAt: "2026-10-20T19:00:00.000Z",
    timezone: "UTC",
    location: "Online",
  },
};

export const eventEvidenceStates = Object.freeze(Object.keys(cases));

export async function assertEventEvidence(page, state, viewport) {
  const labels = {
    ended: "Ended",
    paused: "RSVPs paused",
    full: "Full",
    oneSeat: "1 seat left",
    seats: "3 seats left",
    unlimited: "No seat limit",
    blank: "3 seats left",
    discord: "Discord-managed",
  };
  const card = page.locator(".home-events .card");
  assert.equal(await card.count(), 1, `${state}: event card`);
  assert.equal(
    await card.getByText(labels[state], { exact: true }).count(),
    1,
    `${state}: verdict`,
  );
  const host = card.getByTestId("event-card-host");
  assert.equal(await host.count(), ["blank", "discord"].includes(state) ? 0 : 1, `${state}: host`);
  if (await host.count())
    assert.equal(await host.isVisible(), viewport === "desktop", `${state}: host visibility`);
  assert.equal(
    await card.getByText("Wingspan", { exact: true }).count(),
    ["blank", "discord"].includes(state) ? 0 : 1,
    `${state}: game`,
  );
}

// Inject only data into the reviewed home fixture; use Date objects as the
// actual Kit loader does rather than relying on JSON string coercion.
export function eventEvidencePage(homePage, state) {
  if (!Object.hasOwn(cases, state)) throw new Error(`Unknown event evidence state: ${state}`);
  const event = state === "discord" ? cases[state] : { ...baseEvent, ...cases[state] };
  const marker = "data.homeCopy = ";
  if (!homePage.includes(marker)) throw new Error("Home evidence fixture marker missing");
  return homePage.replace(
    marker,
    `data.upcomingEvents = [${JSON.stringify(event)}];\n` +
      "data.upcomingEvents[0].startsAt = new Date(data.upcomingEvents[0].startsAt);\n" +
      "if (data.upcomingEvents[0].endsAt) data.upcomingEvents[0].endsAt = new Date(data.upcomingEvents[0].endsAt);\n" +
      marker,
  );
}
