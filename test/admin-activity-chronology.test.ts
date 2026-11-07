// Admin activity-log chronology: UTC labels with exact machine instants, and
// one unusable timestamp keeps its row visible instead of throwing.
import { describe, expect, it } from "vitest";
import { ActivityLogPage } from "../src/admin/pages/activity-log";
import { parseActivityLogQuery } from "../src/admin/table-list";
import type { ActivityLogViewerRow } from "../src/admin/reads";

const row = (id: number, createdAt: Date): ActivityLogViewerRow => ({
  id,
  description: `Chronology action ${id}`,
  subjectType: "Event",
  subjectId: "01J0000000000000000000CHRN",
  causerId: "100000000000000111",
  event: "updated",
  createdAt,
});

const html = (rows: ActivityLogViewerRow[]) =>
  String(
    ActivityLogPage({
      rows,
      query: parseActivityLogQuery({}),
      hasNext: false,
    }),
  );

describe("ActivityLogPage chronology", () => {
  it("labels a valid instant in UTC while keeping the exact machine instant", () => {
    const out = html([row(1, new Date("2026-11-01T06:00:00.000Z"))]);
    expect(out).toContain(
      '<time datetime="2026-11-01T06:00:00.000Z">2026-11-01 06:00:00 UTC</time>',
    );
    expect(out).toContain('class="admin-chronology"');
  });

  it("keeps exact UTC labels on both sides of the DST boundary", () => {
    const out = html([
      row(1, new Date("2026-03-08T06:59:59.000Z")),
      row(2, new Date("2026-03-08T07:00:00.000Z")),
    ]);
    expect(out).toContain(
      '<time datetime="2026-03-08T06:59:59.000Z">2026-03-08 06:59:59 UTC</time>',
    );
    expect(out).toContain(
      '<time datetime="2026-03-08T07:00:00.000Z">2026-03-08 07:00:00 UTC</time>',
    );
  });

  it("keeps an unusable timestamp visible without dropping the sibling row", () => {
    const out = html([row(1, new Date("2026-10-01T12:00:00.000Z")), row(2, new Date(Number.NaN))]);
    expect(out).toContain("Unrenderable time");
    expect(out).toContain(
      '<time datetime="2026-10-01T12:00:00.000Z">2026-10-01 12:00:00 UTC</time>',
    );
    expect(out).toContain("Chronology action 2");
  });

  it("marks the When column as UTC", () => {
    expect(html([row(1, new Date("2026-10-01T12:00:00.000Z"))])).toContain("when (UTC)");
  });
});
