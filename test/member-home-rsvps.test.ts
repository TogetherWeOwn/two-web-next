import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { getMemberHomeRsvps, MEMBER_HOME_RSVP_MAX_EVENTS } from "../src/events/member-home-rsvps";

const VIEWER = "100000000000000101";
const OTHER = "100000000000000102";
const SYNCED = new Date("2099-01-01T00:00:00Z");

function fakeDb(rows: unknown[]) {
  const where = vi.fn(async () => rows);
  const select = vi.fn(() => ({ from: () => ({ innerJoin: () => ({ where }) }) }));
  return { db: { select } as unknown as Db, select, where };
}

describe("getMemberHomeRsvps (synthetic rows, mocked db)", () => {
  it("maps the viewer's own answers by canonical event key", async () => {
    const { db, select } = fakeDb([
      { userId: VIEWER, eventKey: "k1", status: "going", syncedToDiscordAt: SYNCED },
      { userId: VIEWER, eventKey: "k2", status: "waitlisted", syncedToDiscordAt: null },
    ]);
    const answers = await getMemberHomeRsvps(db, VIEWER, ["k1", "k2", "k3"]);
    expect(select).toHaveBeenCalledTimes(1);
    expect(answers.get("k1")).toEqual({ status: "going", syncedToDiscordAt: SYNCED });
    expect(answers.get("k2")).toEqual({ status: "waitlisted", syncedToDiscordAt: null });
    expect(answers.has("k3")).toBe(false);
  });

  it("drops rows owned by someone else or with an unknown status", async () => {
    const { db } = fakeDb([
      { userId: OTHER, eventKey: "k1", status: "going", syncedToDiscordAt: null },
      { userId: VIEWER, eventKey: "k2", status: "bogus", syncedToDiscordAt: null },
    ]);
    expect((await getMemberHomeRsvps(db, VIEWER, ["k1", "k2"])).size).toBe(0);
  });

  it.each([null, undefined, "", "abc", "12345"])(
    "issues no query for viewer %j",
    async (viewer) => {
      const { db, select } = fakeDb([]);
      expect((await getMemberHomeRsvps(db, viewer, ["k1"])).size).toBe(0);
      expect(select).not.toHaveBeenCalled();
    },
  );

  it("propagates a failed member read instead of reporting no RSVPs", async () => {
    const { db, where } = fakeDb([]);
    where.mockRejectedValueOnce(new Error("read failed"));
    await expect(getMemberHomeRsvps(db, VIEWER, ["k1"])).rejects.toThrow("read failed");
  });

  it("issues no query without usable event keys", async () => {
    const { db, select } = fakeDb([]);
    expect((await getMemberHomeRsvps(db, VIEWER, ["", 1 as unknown as string])).size).toBe(0);
    expect((await getMemberHomeRsvps(db, VIEWER, [])).size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("bounds results to the first distinct requested event keys", async () => {
    const ids = Array.from({ length: MEMBER_HOME_RSVP_MAX_EVENTS + 20 }, (_, i) => `k${i}`);
    const { db, select } = fakeDb([
      { userId: VIEWER, eventKey: "k0", status: "going", syncedToDiscordAt: null },
      {
        userId: VIEWER,
        eventKey: `k${MEMBER_HOME_RSVP_MAX_EVENTS}`,
        status: "going",
        syncedToDiscordAt: null,
      },
      { userId: VIEWER, eventKey: "unrequested", status: "going", syncedToDiscordAt: null },
    ]);
    const answers = await getMemberHomeRsvps(db, VIEWER, ["k0", "k0", ...ids]);
    expect(select).toHaveBeenCalledTimes(1);
    expect([...answers.keys()]).toEqual(["k0"]);
  });
});
