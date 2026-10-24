// Kit event-edit read model: GET /admin/events/:key through
// resolveKitEventEdit mirrors the Hono handler (src/admin/routes.tsx,
// admin.events.edit) — the same getEvent read with a 404 on a missing key,
// the same eventValues wall fill in the row's zone, the same bounded
// parseRosterQuery/listRoster roster page, the same status-action admission
// (publish only from draft, cancel from draft/published, RSVP pause/reopen
// only on a live published event) and the same series note, with the Hono
// 422 values/errors/draft shape carried so the Svelte page renders the
// identical error DOM when the write slice migrates. POST
// /admin/events/:key, the publish/cancel/RSVP-pause/RSVP-reopen siblings and
// the guarded /admin/events/:key/edit legacy redirect stay Hono-owned, so
// this model carries no write: UTC carriers, future recurrence propagation
// and postcommit writeback keep one Hono authority.
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { isDatabaseUnavailable } from "../src/db/errors";
import { eventContentBaseline } from "../src/admin/event-baseline";
import {
  resolveKitEventEdit,
  type KitEventEditDeps,
  type KitEventEditRosterRow,
  type KitEventEditRow,
} from "../src/admin/kit-event-edit";
import { ROSTER_PAGE_SIZE } from "../src/admin/table-list";

const db = {} as Db;

const hostJoin = {
  organizer_name: "Riley",
  join_url: "https://meet.example.test/room-9",
  join_instructions: "Use the public lobby.",
};
const baseRow: KitEventEditRow & typeof hostJoin = {
  ...hostJoin,
  eventKey: "EVTPAST01",
  title: "Game night",
  game: "Chess",
  description: "Casual play",
  // Non-null so the baseline-mint test pins notes: a mint that narrowed the
  // Kit projection to null would fail to match here.
  accessibilityNotes: "Step-free access confirmed.",
  startsAt: new Date("2026-07-01T19:00:00.000Z"),
  endsAt: new Date("2026-07-01T21:00:00.000Z"),
  timezone: "Europe/London",
  location: "Hall",
  capacity: 8,
  status: "draft",
  rsvpOpen: true,
  recurrenceFrequency: null,
};

const answeredAt = new Date("2026-06-01T12:00:00.000Z");

const baseRoster: { rows: KitEventEditRosterRow[]; total: number } = {
  rows: [
    { username: "  mod  ", status: "going", answeredAt },
    { username: null, status: "waitlisted", answeredAt },
  ],
  total: 2,
};

function depsFor(overrides: Partial<KitEventEditDeps> = {}): KitEventEditDeps {
  return {
    db,
    get: async () => ({ ...baseRow }),
    list: async () => ({ ...baseRoster, rows: [...baseRoster.rows] }),
    now: new Date("2026-06-15T12:00:00.000Z"),
    ...overrides,
  };
}

describe("resolveKitEventEdit: Hono edit-read parity", () => {
  it("fills the form from the stored row in its own wall zone, like eventValues()", async () => {
    const outcome = await resolveKitEventEdit("EVTPAST01", {}, depsFor());
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.view.key).toBe("EVTPAST01");
    expect(outcome.view.title).toBe("Game night");
    // 19:00Z July London is 20:00 wall; storage stays the UTC instant.
    expect(outcome.view.values).toEqual({
      title: "Game night",
      game: "Chess",
      description: "Casual play",
      accessibility_notes: "Step-free access confirmed.",
      organizer_name: "Riley",
      join_url: "https://meet.example.test/room-9",
      join_instructions: "Use the public lobby.",
      starts_at: "2026-07-01 20:00",
      ends_at: "2026-07-01 22:00",
      timezone: "Europe/London",
      location: "Hall",
      capacity: "8",
    });
    expect(outcome.view.endsAt).toBe("2026-07-01T21:00:00.000Z");
  });

  it("mints the Hono save baseline from the same row the form displays", async () => {
    const outcome = await resolveKitEventEdit("EVTPAST01", {}, depsFor());
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.baseline).toBe(await eventContentBaseline(baseRow));
  });

  it("renders nullables the way the Hono form does (empty strings, never null)", async () => {
    const outcome = await resolveKitEventEdit(
      "EVTPAST01",
      {},
      depsFor({
        get: async () => ({
          ...baseRow,
          game: null,
          description: null,
          accessibilityNotes: null,
          organizer_name: null,
          join_url: null,
          join_instructions: null,
          location: null,
          capacity: null,
        }),
      }),
    );
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.values.game).toBe("");
    expect(outcome.view.values.description).toBe("");
    expect(outcome.view.values.accessibility_notes).toBe("");
    expect(outcome.view.values).toMatchObject({
      organizer_name: "",
      join_url: "",
      join_instructions: "",
    });
    expect(outcome.view.values.location).toBe("");
    expect(outcome.view.values.capacity).toBe("");
  });

  it("returns the fresh-GET error shape: no errors, no draft marker", async () => {
    const outcome = await resolveKitEventEdit("EVTPAST01", {}, depsFor());
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.errors).toEqual({});
    expect(outcome.view.hasErrors).toBe(false);
    expect(outcome.view.isDraft).toBe(false);
  });

  it("answers notFound for a missing key without reading the roster", async () => {
    const list = vi.fn(async () => ({ rows: [], total: 0 }));
    const outcome = await resolveKitEventEdit("NOPE", {}, depsFor({ get: async () => null, list }));
    expect(outcome).toEqual({ kind: "notFound" });
    expect(list).not.toHaveBeenCalled();
  });

  it("answers unavailable with no database, like the Hono dbOr503 503", async () => {
    const get = vi.fn();
    const list = vi.fn();
    const outcome = await resolveKitEventEdit("EVTPAST01", {}, depsFor({ db: null, get, list }));
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("maps a classified outage on either read to unavailable, and rethrows the rest", async () => {
    const outage = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    expect(isDatabaseUnavailable(outage)).toBe(true);
    const onGet = await resolveKitEventEdit(
      "EVTPAST01",
      {},
      depsFor({
        get: async () => {
          throw outage;
        },
      }),
    );
    expect(onGet).toEqual({ kind: "unavailable" });
    const onList = await resolveKitEventEdit(
      "EVTPAST01",
      {},
      depsFor({
        list: async () => {
          throw outage;
        },
      }),
    );
    expect(onList).toEqual({ kind: "unavailable" });
    const bug = new Error("syntax error at end of input");
    await expect(
      resolveKitEventEdit(
        "EVTPAST01",
        {},
        depsFor({
          get: async () => {
            throw bug;
          },
        }),
      ),
    ).rejects.toBe(bug);
    await expect(
      resolveKitEventEdit(
        "EVTPAST01",
        {},
        depsFor({
          list: async () => {
            throw bug;
          },
        }),
      ),
    ).rejects.toBe(bug);
  });
});

describe("resolveKitEventEdit: bounded roster paging", () => {
  it("defaults an empty query exactly like parseRosterQuery", async () => {
    const list = vi.fn(async () => ({ rows: [], total: 0 }));
    const outcome = await resolveKitEventEdit("EVTPAST01", {}, depsFor({ list }));
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(list).toHaveBeenCalledWith(db, "EVTPAST01", {
      q: "",
      status: "",
      sort: "answered",
      order: "desc",
      page: 1,
    });
    expect(outcome.view.roster.query).toEqual({
      q: "",
      status: "",
      sort: "answered",
      order: "desc",
      page: 1,
    });
  });

  it("clamps hostile paging and sort input to the bounded page-one read", async () => {
    const list = vi.fn(async () => ({ rows: [], total: 0 }));
    await resolveKitEventEdit(
      "EVTPAST01",
      {
        roster_page: "9007199254740991",
        roster_sort: "status; DROP TABLE rsvps--",
        roster_order: "up",
      },
      depsFor({ list }),
    );
    expect(list).toHaveBeenCalledWith(db, "EVTPAST01", {
      q: "",
      status: "",
      sort: "answered",
      order: "desc",
      page: 1,
    });
  });

  it("renders members without leaking identifiers, with ISO instants", async () => {
    const outcome = await resolveKitEventEdit("EVTPAST01", {}, depsFor());
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.roster.entries).toEqual([
      { member: "mod", status: "going", answeredAt: "2026-06-01T12:00:00.000Z" },
      { member: "Unknown member", status: "waitlisted", answeredAt: "2026-06-01T12:00:00.000Z" },
    ]);
    for (const entry of outcome.view.roster.entries) {
      expect(entry).not.toHaveProperty("userId");
      expect(entry).not.toHaveProperty("username");
    }
  });

  it("computes the Hono range line and next-page flag from the filtered total", async () => {
    const outcome = await resolveKitEventEdit(
      "EVTPAST01",
      {},
      depsFor({ list: async () => ({ rows: baseRoster.rows.slice(0, 1), total: 250 }) }),
    );
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.roster.total).toBe(250);
    expect(outcome.view.roster.rangeStart).toBe(1);
    expect(outcome.view.roster.rangeEnd).toBe(1);
    expect(outcome.view.roster.hasPrev).toBe(false);
    expect(outcome.view.roster.hasNext).toBe(true);
    expect(outcome.view.roster.prevUrl).toBeNull();
    expect(outcome.view.roster.nextUrl).toBe(
      `/admin/events/EVTPAST01?roster_sort=answered&roster_order=desc&roster_page=2#rsvp-roster`,
    );
    expect(outcome.view.roster.emptyText).toBeNull();
  });

  it("keeps page one bare so sort and search links reset the roster", async () => {
    const outcome = await resolveKitEventEdit(
      "EVTPAST01",
      { roster_q: "mod", roster_page: "3" },
      depsFor({ list: async () => ({ rows: [], total: 250 }) }),
    );
    if (outcome.kind !== "ok") throw new Error("expected ok");
    const { roster } = outcome.view;
    expect(roster.query.q).toBe("mod");
    expect(roster.prevUrl).toBe(
      `/admin/events/EVTPAST01?roster_sort=answered&roster_order=desc&roster_q=mod&roster_page=2#rsvp-roster`,
    );
    const status = roster.sortHeaders.find((h) => h.key === "status")!;
    // Inactive sort flips to ascending with a page-one URL.
    expect(status.active).toBe(false);
    expect(status.url).toBe(
      `/admin/events/EVTPAST01?roster_sort=status&roster_order=asc&roster_q=mod#rsvp-roster`,
    );
    expect(status.linkLabel).toBe("Sort by status ascending");
    const answered = roster.sortHeaders.find((h) => h.key === "answered")!;
    expect(answered.active).toBe(true);
    expect(answered.ariaSort).toBe("descending");
    expect(answered.marker).toBe(" ↓");
    // Past-end page: no rows, working navigation, past-end copy.
    expect(roster.emptyText).toBe("No RSVPs on this page.");
  });

  it("distinguishes an empty roster from an unmatched member search", async () => {
    const empty = await resolveKitEventEdit(
      "EVTPAST01",
      {},
      depsFor({ list: async () => ({ rows: [], total: 0 }) }),
    );
    if (empty.kind !== "ok") throw new Error("expected ok");
    expect(empty.view.roster.emptyText).toBe("No RSVPs yet.");
    expect(empty.view.roster.rangeStart).toBe(0);
    expect(empty.view.roster.rangeEnd).toBe(0);
    const searched = await resolveKitEventEdit(
      "EVTPAST01",
      { roster_q: "nobody" },
      depsFor({ list: async () => ({ rows: [], total: 0 }) }),
    );
    if (searched.kind !== "ok") throw new Error("expected ok");
    expect(searched.view.roster.emptyText).toBe("No RSVPs match this member search.");
  });

  it("points the roster search form at the Hono-owned edit URL with its anchor", async () => {
    const outcome = await resolveKitEventEdit("EVTPAST01", {}, depsFor());
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.roster.searchAction).toBe("/admin/events/EVTPAST01#rsvp-roster");
    expect(ROSTER_PAGE_SIZE).toBe(100);
  });
});

describe("resolveKitEventEdit: status actions and series note", () => {
  const viewFor = async (row: Partial<KitEventEditRow>) => {
    const outcome = await resolveKitEventEdit(
      "EVTPAST01",
      {},
      depsFor({ get: async () => ({ ...baseRow, ...row }) }),
    );
    if (outcome.kind !== "ok") throw new Error("expected ok");
    return outcome.view;
  };

  it("drafts offer publish and cancel, never the RSVP toggle", async () => {
    const view = await viewFor({ status: "draft" });
    expect(view.status).toBe("draft");
    expect(view.showPublish).toBe(true);
    expect(view.showCancel).toBe(true);
    expect(view.rsvpAction).toBeNull();
  });

  it("live published events offer cancel plus pause or reopen", async () => {
    const paused = await viewFor({ status: "published", rsvpOpen: true });
    expect(paused.showPublish).toBe(false);
    expect(paused.showCancel).toBe(true);
    expect(paused.rsvpAction).toBe("rsvp-pause");
    const reopen = await viewFor({ status: "published", rsvpOpen: false });
    expect(reopen.rsvpAction).toBe("rsvp-reopen");
  });

  it("ended published events offer cancel only: the toggle stays hidden", async () => {
    const view = await viewFor({
      status: "published",
      endsAt: new Date("2026-06-01T21:00:00.000Z"),
    });
    expect(view.showCancel).toBe(true);
    expect(view.rsvpAction).toBeNull();
  });

  it("cancelled events offer no transition: the matrix refuses them all", async () => {
    const view = await viewFor({ status: "cancelled" });
    expect(view.showPublish).toBe(false);
    expect(view.showCancel).toBe(false);
    expect(view.rsvpAction).toBeNull();
  });

  it("names the series move rule only for series parents, like the Hono hint", async () => {
    const solo = await viewFor({ recurrenceFrequency: null });
    expect(solo.seriesNote).toBeNull();
    const series = await viewFor({ recurrenceFrequency: "weekly" });
    expect(series.seriesNote).toBe(
      "Part of a weekly series. Moving this event moves the not-yet-started occurrences by the same amount.",
    );
  });
});
