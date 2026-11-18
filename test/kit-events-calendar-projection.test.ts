import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import type { KitEventsLoadData } from "../src/kit-events";
import { gathering } from "./helpers/calendar-multiday-acceptance";

let projectEventsCalendar: typeof import("../web/src/lib/server/events-calendar").projectEventsCalendar;

beforeAll(async () => {
  // Bundle the real Kit module without asking root Vitest to resolve Kit's $app/tsconfig.
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL("../web/src/lib/server/events-calendar.ts", import.meta.url)),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: {},
  });
  const encoded = Buffer.from(outputFiles[0]!.text).toString("base64");
  ({ projectEventsCalendar } = await import(`data:text/javascript;base64,${encoded}`));
});

const venueOnly = "private-venue-note";
const row = gathering({
  title: "Co-op <practice>",
  organizer_name: "  Event host  ",
  proofMarker: venueOnly,
  goingCount: 0,
  goingOccupancy: 2,
  capacity: 3,
});
const now = new Date("2027-02-14T23:45:00Z");
const data: KitEventsLoadData = {
  state: { view: "list", month: "2027-02", q: "practice", past: false, page: 1 },
  upcoming: [row],
  past: [],
  zone: "UTC",
  now,
  totalPages: 1,
  emptyState: null,
  discordFailed: false,
  games: ["Co-op"],
  gameFilter: null,
  member: false,
  moderator: false,
  session: { username: "viewer-only-name", member: false },
  inviteUrl: "https://example.test/discord",
  appUrl: "https://example.test",
  canonical: "https://example.test/events",
  loginReturnTo: "/events?q=practice",
  joinResult: null,
  queryTooLong: false,
};

describe("Kit calendar screen projection", () => {
  it("keeps public card content and occupancy without passing row metadata or viewer identity", () => {
    const result = projectEventsCalendar(data);
    expect(result.upcoming[0]).toMatchObject({
      kind: "event",
      host: "Event host",
      goingCount: 0,
      goingOccupancy: 2,
      titleSegments: expect.arrayContaining([{ text: "practice", match: true }]),
      availability: { state: "open", text: "1 seat left", ongoing: true },
    });
    const bodyInputs = JSON.stringify(result);
    expect(bodyInputs).not.toContain(venueOnly);
    expect(bodyInputs).not.toContain("proofMarker");
    expect(bodyInputs).not.toContain("viewer-only-name");
  });

  it("uses the same snapshot on each continuation, suppressing the badge on a spillover month", () => {
    const multi = gathering({
      startsAt: new Date("2027-03-31T23:00:00Z"),
      endsAt: new Date("2027-04-01T01:00:00Z"),
    });
    const props = projectEventsCalendar({
      ...data,
      state: { ...data.state, view: "calendar", month: "2027-03", q: "" },
      upcoming: [multi],
      now: new Date("2027-03-31T23:30:00Z"),
    });
    const cells = props.weeks.flat();
    expect(cells.find((day) => day.iso === "2027-03-31")?.events[0]?.ongoing).toBe(true);
    expect(cells.find((day) => day.iso === "2027-04-01")?.events[0]?.ongoing).toBe(false);
  });
});
