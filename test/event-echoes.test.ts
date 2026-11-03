// Event Echoes — hermetic unit tests (contract §4 §-fixture answers).
//
// These tests build and exercise the writer against stubbed §4 answers only:
// `not_found`, `final:false`, and `final:true`. No test here claims a live-bot
// Echo; production has zero Echoes until the bot ships and the flag flips.
import { describe, expect, it, vi } from "vitest";
import { parseAttendanceResult, type AttendancePayload } from "../src/bot/attendance-read";
import {
  buildEchoInsert,
  canRefreshEcho,
  closeDueEchoes,
  echoAnnouncementBody,
  ECHO_CLOSE_GRACE_MS,
  ECHO_HEADLINE_MAX,
  echoWindowDueAt,
  isPreEchoEvent,
  projectModeratorEchoMembers,
  projectOwnEchoMinutes,
  projectPublicEcho,
  recordLabel,
  updateEchoHeadline,
  validateEchoHeadline,
  writeEventEcho,
} from "../src/events/echoes";

const FINAL_TRUE = {
  v: 1,
  event_key: "01KTESTEVENTKEY000000000001",
  window: { starts_at: "2026-10-20T18:00:00Z", ends_at: "2026-10-20T21:00:00Z" },
  threshold_minutes: 10,
  peak_concurrent: 24,
  rooms: [
    { channel_id: "111111111111111111", name_at_close: "Tavern" },
    { channel_id: "222222222222222222", name_at_close: "Side Room" },
  ],
  members: [
    {
      discord_id: "900000000000000001",
      minutes: 95,
      sessions: 2,
      first_joined_at: "2026-10-20T18:05:00Z",
    },
    { discord_id: "900000000000000002", minutes: 12, sessions: 1, first_joined_at: null },
    {
      discord_id: "900000000000000003",
      minutes: 4,
      sessions: 1,
      first_joined_at: "2026-10-20T19:00:00Z",
    },
  ],
  final: true,
} as const;

const FINAL_FALSE = { ...FINAL_TRUE, final: false } as const;

function finalPayload(overrides: Partial<Record<string, unknown>> = {}): AttendancePayload {
  const parsed = parseAttendanceResult(
    JSON.parse(JSON.stringify({ ...FINAL_TRUE, ...overrides })),
    FINAL_TRUE.event_key,
  );
  if (!parsed) throw new Error("fixture failed to parse");
  return parsed;
}

const publishedEvent = {
  id: 7,
  eventKey: FINAL_TRUE.event_key,
  status: "published",
} as const;

describe("buildEchoInsert", () => {
  it("freezes counts from a final:true payload with the payload threshold", () => {
    const built = buildEchoInsert(publishedEvent, finalPayload());
    expect(built.echo.attendedCount).toBe(2);
    expect(built.echo.peakConcurrent).toBe(24);
    expect(built.echo.thresholdMinutes).toBe(10);
    expect(built.echo.headline).toBeUndefined();
    expect(built.members).toHaveLength(3);
    expect(built.members.map((m) => m.minutes)).toEqual([95, 12, 4]);
  });

  it("refuses final:false, key mismatch, and ineligible statuses", () => {
    expect(() => buildEchoInsert(publishedEvent, finalPayload({ final: false }))).toThrow(
      /not final/,
    );
    expect(() =>
      buildEchoInsert(
        { ...publishedEvent, eventKey: "01KOTHERKEY0000000000000000" },
        finalPayload(),
      ),
    ).toThrow(/event_key/);
    for (const status of ["draft", "cancelled"]) {
      expect(() => buildEchoInsert({ ...publishedEvent, status }, finalPayload())).toThrow(
        /never carries attendance/,
      );
    }
  });
});

describe("writeEventEcho (stub transaction)", () => {
  function stubDb(existing: { id: number; posted: Date | null } | null, insertedId = 42) {
    const calls: string[] = [];
    let transactions = 0;
    const tx = {
      select: () => {
        calls.push("select");
        return { from: () => ({ where: async () => (existing ? [existing] : []) }) };
      },
      update: () => {
        calls.push("update");
        return {
          set: (values: Record<string, unknown>) => {
            calls.push(`set:${Object.keys(values).sort().join(",")}`);
            return { where: async () => {} };
          },
        };
      },
      delete: () => {
        calls.push("delete");
        return { where: async () => {} };
      },
      insert: () => {
        calls.push("insert");
        return { values: () => ({ returning: async () => [{ id: insertedId }] }) };
      },
    };
    const db = {
      transaction: async (fn: (t: unknown) => unknown) => {
        transactions++;
        return fn(tx);
      },
    };
    return { db: db as never, calls, transactions: () => transactions };
  }

  it("writes one Echo in one transaction on final:true", async () => {
    const { db, calls, transactions } = stubDb(null);
    const outcome = await writeEventEcho(db, publishedEvent, finalPayload());
    expect(outcome).toEqual({ written: true, echoId: 42 });
    expect(transactions()).toBe(1);
    // One Echo insert plus one member-rows insert, inside the single transaction.
    expect(calls).toEqual(["select", "insert", "insert"]);
  });

  it("replaces member rows on a pre-publication re-pull and keeps the headline out of the set", async () => {
    const { db, calls } = stubDb({ id: 9, posted: null });
    const outcome = await writeEventEcho(db, publishedEvent, finalPayload());
    expect(outcome).toEqual({ written: true, echoId: 9 });
    expect(calls).toContain("delete");
    const setCall = calls.find((c) => c.startsWith("set:")) ?? "";
    expect(setCall).not.toContain("headline");
    expect(setCall).toContain("attendedCount");
  });

  it("refuses after publication and on final:false without touching the database", async () => {
    const posted = stubDb({ id: 9, posted: new Date("2026-10-21T00:00:00Z") });
    expect(await writeEventEcho(posted.db, publishedEvent, finalPayload())).toEqual({
      written: false,
      reason: "echo already published",
    });
    expect(posted.calls).toEqual(["select"]);

    const draft = stubDb(null);
    expect(await writeEventEcho(draft.db, publishedEvent, finalPayload(FINAL_FALSE))).toEqual({
      written: false,
      reason: "payload is not final",
    });
    expect(draft.calls).toEqual([]);
  });
});

describe("closeDueEchoes (stub §4 answers)", () => {
  const event = {
    id: 7,
    eventKey: FINAL_TRUE.event_key,
    title: "Friday Tavern Night",
    status: "published",
    endsAt: new Date("2026-10-20T21:00:00Z"),
  } as const;

  function baseDeps(overrides: Record<string, unknown> = {}) {
    return {
      listDue: async () => [{ ...event }],
      read: async () => ({ ok: true as const, attendance: finalPayload() }),
      write: async () => ({ written: true as const, echoId: 42 }),
      announce: async () => {},
      ...overrides,
    };
  }

  it("writes and dispatches on final:true; delivery confirms later, never at enqueue", async () => {
    const dispatched: { body: string; echoId: number }[] = [];
    const result = await closeDueEchoes(
      baseDeps({
        announce: async (_e: unknown, body: string, echoId: number) => {
          dispatched.push({ body, echoId });
        },
      }),
    );
    expect(result).toEqual({ checked: 1, written: 1, announced: 1, pending: [] });
    // The echoId rides the carrier so the queue consumer confirms the row
    // only on bot-confirmed delivery. Enqueue stamps nothing on the row.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.echoId).toBe(42);
    expect(dispatched[0]!.body).toContain("Last time, as the bot recorded it");
  });

  it("treats not_found as honest pending, never written", async () => {
    const write = vi.fn(async () => ({ written: true as const, echoId: 1 }));
    const result = await closeDueEchoes(
      baseDeps({ read: async () => ({ ok: false as const, code: "not_found" }), write }),
    );
    expect(result).toEqual({
      checked: 1,
      written: 0,
      announced: 0,
      pending: [{ eventKey: event.eventKey, code: "not_found" }],
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("treats final:false as pending, never written", async () => {
    const write = vi.fn(async () => ({ written: true as const, echoId: 1 }));
    const result = await closeDueEchoes(
      baseDeps({
        read: async () => ({ ok: true as const, attendance: finalPayload(FINAL_FALSE) }),
        write,
      }),
    );
    expect(result.pending).toEqual([{ eventKey: event.eventKey, code: "final_false" }]);
    expect(write).not.toHaveBeenCalled();
  });

  it("writes without posting when no channel key is configured", async () => {
    const announce = vi.fn(async () => {});
    const result = await closeDueEchoes(baseDeps({ announce: null }));
    expect(result.written).toBe(1);
    expect(result.announced).toBe(0);
    expect(announce).not.toHaveBeenCalled();
    expect(result.pending).toEqual([{ eventKey: event.eventKey, code: "announce_unconfigured" }]);
  });

  it("keeps the Echo when the post fails and reports announce_failed", async () => {
    const result = await closeDueEchoes(
      baseDeps({
        announce: async () => {
          throw new Error("queue down");
        },
      }),
    );
    expect(result.written).toBe(1);
    expect(result.announced).toBe(0);
    expect(result.pending).toEqual([{ eventKey: event.eventKey, code: "announce_failed" }]);
  });
});

describe("headline (the one editable field)", () => {
  it("accepts host placement text, clears on blank, rejects over-long and non-text", () => {
    expect(validateEchoHeadline("3rd of 24 — ties held as ties")).toBe(
      "3rd of 24 — ties held as ties",
    );
    expect(validateEchoHeadline("   ")).toBeNull();
    expect(validateEchoHeadline(null)).toBeNull();
    expect(() => validateEchoHeadline("x".repeat(ECHO_HEADLINE_MAX + 1))).toThrow(/at most/);
    expect(() => validateEchoHeadline(42)).toThrow(/must be text/);
  });

  it("updates exactly the headline column (plus updatedAt)", async () => {
    let setArg: Record<string, unknown> = {};
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          setArg = values;
          return {
            where: () => ({
              returning: async () => [{ id: 1, headline: values.headline }],
            }),
          };
        },
      }),
    };
    await updateEchoHeadline(db as never, 1, "2nd of 16");
    expect(Object.keys(setArg).sort()).toEqual(["headline", "updatedAt"]);
  });
});

describe("F20 projections", () => {
  const echoRow = {
    eventId: 7,
    eventKey: FINAL_TRUE.event_key,
    headline: null,
    attendedCount: 2,
    peakConcurrent: 24,
    rooms: [{ channel_id: "111111111111111111", name_at_close: "Tavern" }],
    windowEndsAt: new Date("2026-10-20T21:00:00Z"),
    thresholdMinutes: 10,
  };
  const members = [
    { userId: "900000000000000001", minutes: 95, sessions: 2 },
    { userId: "900000000000000002", minutes: 4, sessions: 1 },
  ];

  it("public projection carries counts only — no member rows, no absence", () => {
    const projected = projectPublicEcho({ ...echoRow });
    expect(projected).toMatchObject({
      eventId: 7,
      label: "attendance record",
      attendedCount: 2,
      peakConcurrent: 24,
      rooms: [{ name: "Tavern" }],
    });
    expect(JSON.stringify(projected)).not.toContain("900000000000000001");
    expect(Object.keys(projected)).not.toContain("members");
  });

  it("own minutes resolve one row, and null reads the same for below-threshold and never-there", () => {
    expect(projectOwnEchoMinutes(members, "900000000000000001", 10)).toMatchObject({
      minutes: 95,
      attended: true,
    });
    expect(projectOwnEchoMinutes(members, "900000000000000002", 10)).toMatchObject({
      minutes: 4,
      attended: false,
    });
    expect(projectOwnEchoMinutes(members, "900000000000000099", 10)).toBeNull();
  });

  it("moderator projection keeps every row, sorted by minutes", () => {
    expect(projectModeratorEchoMembers(members, 10).map((m) => m.userId)).toEqual([
      "900000000000000001",
      "900000000000000002",
    ]);
  });
});

describe("copy and policy labels", () => {
  it("shared site/Discord copy names the bot record and fits the body bound", () => {
    const body = echoAnnouncementBody("Friday Tavern Night", {
      attendedCount: 2,
      peakConcurrent: 24,
      rooms: FINAL_TRUE.rooms.map((r) => ({ ...r })),
      headline: "3rd of 24",
    });
    expect(body).toContain("Last time, as the bot recorded it");
    expect(body).toContain("3rd of 24");
    expect(body.length).toBeLessThanOrEqual(2000);
  });

  it("pre-Echo events keep the sign-up record label forever", () => {
    expect(recordLabel(true)).toBe("attendance record");
    expect(recordLabel(false)).toBe("sign-up record");
  });

  it("due instant is the bot window plus the site grace", () => {
    const endsAt = new Date("2026-10-20T21:00:00Z");
    expect(echoWindowDueAt(endsAt).getTime()).toBe(
      endsAt.getTime() + 15 * 60_000 + ECHO_CLOSE_GRACE_MS,
    );
  });

  it("refresh guard and pre-Echo policy", () => {
    expect(canRefreshEcho({ announcementPostedAt: null })).toBe(true);
    expect(canRefreshEcho({ announcementPostedAt: new Date() })).toBe(false);
    expect(isPreEchoEvent(new Date("2026-01-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"))).toBe(
      true,
    );
    expect(isPreEchoEvent(new Date("2026-11-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"))).toBe(
      false,
    );
  });
});
