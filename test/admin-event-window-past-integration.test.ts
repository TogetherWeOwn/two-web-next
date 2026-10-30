import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listEvents } from "../src/admin/store-event-reads";
import {
  createPlanningWindowFixture,
  type PlanningWindowFixture,
} from "./helpers/admin-event-planning-window-db";

// Pin the integration boundary: date bounds must AND with the entire Past OR,
// including stored-past rows whose end is still in the future.
describe("UTC start window with both Past eligibility branches", () => {
  let fixture: PlanningWindowFixture;
  const now = new Date("2030-06-17T12:00:00.000Z");
  const keys = (rows: { eventKey: string }[]) => rows.map((row) => row.eventKey).sort();

  beforeAll(async () => {
    fixture = await createPlanningWindowFixture([]);
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await fixture.reset();
    for (const status of ["past", "published"] as const) {
      for (const [key, startsAt] of [
        ["before", "2030-06-13T23:59:59.999Z"],
        ["lower", "2030-06-14T00:00:00.000Z"],
        ["inside", "2030-06-15T12:00:00.000Z"],
        ["upper", "2030-06-16T00:00:00.000Z"],
      ]) {
        await fixture.insertEvent({
          eventKey: `${status}-${key}`,
          title: `${status} ${key}`,
          status,
          startsAt: new Date(startsAt!),
          endsAt: new Date(status === "past" ? "2030-06-18T00:00:00Z" : "2030-06-16T01:00:00Z"),
        });
      }
    }
    await fixture.insertEvent({
      eventKey: "ongoing",
      title: "Published ongoing",
      status: "published",
      startsAt: new Date("2030-06-15T12:00:00Z"),
      endsAt: now,
    });
    await fixture.insertEvent({
      eventKey: "draft-ended",
      title: "Draft ended",
      status: "draft",
      startsAt: new Date("2030-06-15T12:00:00Z"),
      endsAt: new Date("2030-06-16T01:00:00Z"),
    });
  });
  afterEach(() => vi.useRealTimers());

  it("ANDs the half-open window with stored-past AND elapsed-published eligibility", async () => {
    const rows = await listEvents(fixture.db, {
      status: "past",
      starts_from: "2030-06-14",
      starts_before: "2030-06-16",
    });
    expect(keys(rows)).toEqual([
      "past-inside",
      "past-lower",
      "published-inside",
      "published-lower",
    ]);
    expect(rows.find((row) => row.eventKey === "published-inside")?.status).toBe("published");
  });

  it("applies an inclusive lower bound to both branches without an upper bound", async () => {
    expect(
      keys(await listEvents(fixture.db, { status: "past", starts_from: "2030-06-14" })),
    ).toEqual([
      "past-inside",
      "past-lower",
      "past-upper",
      "published-inside",
      "published-lower",
      "published-upper",
    ]);
  });

  it("applies an exclusive upper bound to both branches without a lower bound", async () => {
    expect(
      keys(await listEvents(fixture.db, { status: "past", starts_before: "2030-06-16" })),
    ).toEqual([
      "past-before",
      "past-inside",
      "past-lower",
      "published-before",
      "published-inside",
      "published-lower",
    ]);
  });

  it("leaves both branches intact when no date bound was requested", async () => {
    expect(keys(await listEvents(fixture.db, { status: "past" }))).toEqual([
      "past-before",
      "past-inside",
      "past-lower",
      "past-upper",
      "published-before",
      "published-inside",
      "published-lower",
      "published-upper",
    ]);
  });

  it("refuses invalid windows rather than returning unrestricted Past rows", async () => {
    expect(await listEvents(fixture.db, { status: "past", starts_from: "2030-02-30" })).toEqual([]);
  });

  it("keeps published status literal while narrowing it by date", async () => {
    expect(
      keys(
        await listEvents(fixture.db, {
          status: "published",
          starts_from: "2030-06-14",
          starts_before: "2030-06-16",
        }),
      ),
    ).toEqual(["ongoing", "published-inside", "published-lower"]);
  });
});
