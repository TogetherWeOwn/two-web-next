import { beforeAll, describe, expect, it } from "vitest";
import { parseRosterQuery, rosterUrl } from "../src/admin/table-list";
import { resolveKitEventEdit } from "../src/admin/kit-event-edit";
import type { Db } from "../src/db/index";
import { row, text, type RosterKit } from "./helpers/admin-roster-status";
import {
  compileRosterKit,
  key,
  memberId,
  middleName,
  renderRows,
  renderWaitlist,
  rosterHtml,
} from "./helpers/admin-waitlist-order";

let kit: RosterKit;
beforeAll(async () => {
  kit = await compileRosterKit();
});
const cells = (html: string, tag: "td" | "th") =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g"))].map((m) =>
    text(m[1]!),
  );
const bodyRows = (html: string) =>
  [
    ...(html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g),
  ].map((m) => cells(m[1]!, "td"));

it("WQ-Q01 admits only the queue sort token while retaining bounded normalized facets", () => {
  const parsed = parseRosterQuery({
    roster_sort: "waitlist",
    roster_order: "asc",
    roster_status: "waitlisted",
    roster_q: ` ${middleName} `,
    roster_page: "2",
  });
  expect(parsed).toEqual({
    sort: "waitlist",
    order: "asc",
    status: "waitlisted",
    q: middleName,
    page: 2,
  });
  for (const token of [
    "waitlist desc; select * from users",
    "waitlist ",
    "WAITLIST",
    "legacy_id",
    "created_at",
  ])
    expect(parseRosterQuery({ roster_sort: token }).sort).toBe("answered");
  expect(parseRosterQuery({ roster_page: "9007199254740991" }).page).toBe(1);
});

it("WQ-Q02 queue pagination and sort links retain search/facet context without FIFO carriers", () => {
  const query = parseRosterQuery({
    roster_sort: "waitlist",
    roster_order: "asc",
    roster_status: "waitlisted",
    roster_q: middleName,
  });
  const url = new URL(rosterUrl(key, query, { page: 2 }), "https://fixture.example");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    roster_sort: "waitlist",
    roster_order: "asc",
    roster_status: "waitlisted",
    roster_q: middleName,
    roster_page: "2",
  });
  expect(url.hash).toBe("#rsvp-roster");
});

for (const renderer of ["Hono", "Kit"] as const) {
  describe(`${renderer} real moderator roster markup`, () => {
    it("WQ-R01 exposes one meaningful queue-order control with current aria-sort", async () => {
      const section = rosterHtml(await renderWaitlist(renderer, kit));
      const headers = [...section.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)];
      const queue = headers.filter((m) => /Waitlist position/i.test(text(m[0])));
      expect(queue).toHaveLength(1);
      expect(queue[0]![0]).toMatch(/aria-sort="ascending"/);
      expect(queue[0]![0]).toMatch(/aria-label="[^"]*(?:waitlist|queue)[^"]*descending/i);
      const href = queue[0]![0].match(/href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
      expect(href).toBeTruthy();
      const url = new URL(href!, "https://fixture.example");
      expect(url.searchParams.get("roster_sort")).toBe("waitlist");
      expect(url.searchParams.get("roster_order")).toBe("desc");
      expect(url.searchParams.has("roster_page")).toBe(false);
    });

    it("WQ-R02 renders global numbers by member, never a rank on a non-waitlisted answer", async () => {
      const section = rosterHtml(await renderWaitlist(renderer, kit));
      const header = cells(section.match(/<thead>[\s\S]*?<\/thead>/)![0], "th");
      const position = header.findIndex((h) => /Waitlist position/i.test(h));
      expect(position).toBeGreaterThanOrEqual(0);
      const rows = bodyRows(section);
      expect(rows.map((r) => r[position])).toEqual(["57", "—", "102"]);
      expect(rows[2]![0]).toBe("Unknown member");
      expect(rows.map((r) => r[0])).toContain(middleName);
    });

    it.each(["open", "paused", "cancelled", "past"] as const)(
      "WQ-R03 %s queue visibility explains order, not a promised seat/attendance/promotion",
      async (state) => {
        const section = rosterHtml(await renderWaitlist(renderer, kit, { state }));
        const copy = text(section);
        expect(copy).toMatch(/queue order/i);
        expect(copy).toMatch(/(?:not|no|isn't|doesn't|does not)[^.]{0,160}(?:seat|guarantee)/i);
        expect(copy).toMatch(/attendance/i);
        expect(copy).toMatch(/(?:paused|closed)[\s\S]*(?:promot|move|advance)/i);
        expect(bodyRows(section).flat()).toContain("57");
        expect(section).not.toMatch(/<form\b[^>]*method="post"/i);
        expect(section).not.toMatch(
          /(?:name|href|action)="[^"]*(?:promote|override|export|assign-seat)/i,
        );
      },
    );

    it("WQ-R04 no identities or FIFO carriers escape the actual roster HTML", async () => {
      const section = rosterHtml(await renderWaitlist(renderer, kit));
      for (const forbidden of [
        memberId(57),
        memberId(102),
        memberId(108),
        "userId",
        "legacyId",
        "createdAt",
        "legacy_id",
        "created_at",
      ])
        expect(section).not.toContain(forbidden);
      expect(section).not.toMatch(/<(?:input|select)[^>]*name="[^"]*(?:position|priority)/i);
    });

    it("WQ-R05 blank member names have the same explicit deterministic unknown label", async () => {
      const section = rosterHtml(
        await renderWaitlist(renderer, kit, { rows: [{ ...renderRows[0]!, username: "  " }] }),
      );
      expect(bodyRows(section)[0]![0]).toBe("Unknown member");
      expect(cells(section.match(/<thead>[\s\S]*?<\/thead>/)![0], "th")).toHaveLength(4);
    });

    it("WQ-R06 the empty-state colspan covers the new position column", async () => {
      const section = rosterHtml(
        await renderWaitlist(renderer, kit, {
          rows: [],
          total: 107,
          raw: { roster_page: "3", roster_status: "waitlisted", roster_q: middleName },
        }),
      );
      const count = cells(section.match(/<thead>[\s\S]*?<\/thead>/)![0], "th").length;
      expect(count).toBe(4);
      expect(section.match(/<td\b[^>]*colspan="?(\d+)/)?.[1]).toBe(String(count));
      expect(text(section)).toContain("No RSVPs on this page.");
      const href = section
        .match(/href="([^"]+)"[^>]*>First page of these responses/)?.[1]
        ?.replaceAll("&amp;", "&");
      expect(href).toBeTruthy();
      const url = new URL(href!, "https://fixture.example");
      expect(url.searchParams.get("roster_sort")).toBe("waitlist");
      expect(url.searchParams.get("roster_status")).toBe("waitlisted");
      expect(url.searchParams.get("roster_q")).toBe(middleName);
      expect(url.searchParams.has("roster_page")).toBe(false);
    });

    it("WQ-R07 queue search and next page preserve the committed native GET context", async () => {
      const section = rosterHtml(
        await renderWaitlist(renderer, kit, {
          total: 207,
          raw: { roster_page: "2", roster_status: "waitlisted", roster_q: middleName },
        }),
      );
      expect(section).toMatch(/<form\b[^>]*method="get"/);
      expect(section).toMatch(/name="roster_sort"[^>]*value="waitlist"/);
      expect(section).toMatch(/name="roster_order"[^>]*value="asc"/);
      const href = section
        .match(/<a\b(?=[^>]*rel="next")(?=[^>]*href="([^"]+)")[^>]*>/)?.[1]
        ?.replaceAll("&amp;", "&");
      expect(href).toBeTruthy();
      const url = new URL(href!, "https://fixture.example");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        roster_sort: "waitlist",
        roster_order: "asc",
        roster_status: "waitlisted",
        roster_q: middleName,
        roster_page: "3",
      });
    });
  });
}

it("WQ-R08 the serialized Kit load model carries positions but strips member/internal FIFO keys", async () => {
  const outcome = await resolveKitEventEdit(
    key,
    { roster_sort: "waitlist", roster_order: "asc" },
    { db: {} as Db, get: async () => row, list: async () => ({ rows: renderRows, total: 3 }) },
  );
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error("missing fixture view");
  expect(outcome.view.roster.entries).toEqual([
    {
      member: middleName,
      status: "waitlisted",
      answeredAt: "2026-03-01T00:00:54.000Z",
      waitlistPosition: 57,
    },
    {
      member: "Not queued",
      status: "going",
      answeredAt: "2026-03-01T00:00:03.000Z",
      waitlistPosition: null,
    },
    {
      member: "Unknown member",
      status: "waitlisted",
      answeredAt: "2026-03-01T00:00:09.000Z",
      waitlistPosition: 102,
    },
  ]);
  const wire = JSON.stringify(outcome.view);
  for (const value of [memberId(57), memberId(102), "legacyId", "createdAt", "userId"])
    expect(wire).not.toContain(value);
});
