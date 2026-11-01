// Admin RSVP roster chronology: UTC labels with exact machine instants, and
// one unusable timestamp keeps its row visible instead of throwing.
import { describe, expect, it } from "vitest";
import { EventRosterSection } from "../src/admin/pages/event-form-roster";
import { parseRosterQuery } from "../src/admin/table-list";
import type { RosterEntry } from "../src/admin/reads";

const row = (userId: string, answeredAt: Date): RosterEntry => ({
  userId,
  username: `Member ${userId}`,
  status: "going",
  answeredAt,
});

const html = (roster: RosterEntry[]) =>
  String(
    EventRosterSection({
      eventKey: "01J0000000000000000000CHRN",
      action: "/admin/events/01J0000000000000000000CHRN/edit",
      roster,
      rosterTotal: roster.length,
      rosterQuery: parseRosterQuery({}),
    }),
  );

describe("EventRosterSection chronology", () => {
  it("labels a valid instant in UTC while keeping the exact machine instant", () => {
    const out = html([row("u1", new Date("2026-03-08T07:00:00.000Z"))]);
    expect(out).toContain(
      '<time datetime="2026-03-08T07:00:00.000Z">2026-03-08 07:00:00 UTC</time>',
    );
    expect(out).toContain('class="admin-chronology"');
  });

  it("keeps exact UTC labels on both sides of the DST boundary", () => {
    const out = html([
      row("u1", new Date("2026-03-08T06:59:59.000Z")),
      row("u2", new Date("2026-11-01T06:00:00.000Z")),
    ]);
    expect(out).toContain(
      '<time datetime="2026-03-08T06:59:59.000Z">2026-03-08 06:59:59 UTC</time>',
    );
    expect(out).toContain(
      '<time datetime="2026-11-01T06:00:00.000Z">2026-11-01 06:00:00 UTC</time>',
    );
  });

  it("keeps an unusable timestamp visible without dropping the sibling row", () => {
    const out = html([
      row("u1", new Date("2026-10-01T12:00:00.000Z")),
      row("u2", new Date(Number.NaN)),
    ]);
    expect(out).toContain("Unrenderable time");
    expect(out).toContain(
      '<time datetime="2026-10-01T12:00:00.000Z">2026-10-01 12:00:00 UTC</time>',
    );
    expect(out).toContain("Member u2");
  });

  it("explains that Answered is the latest response update in UTC", () => {
    expect(html([row("u1", new Date("2026-10-01T12:00:00.000Z"))])).toContain(
      "latest response update in UTC",
    );
  });
});
