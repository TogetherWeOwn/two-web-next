import { describe, expect, it } from "vitest";
import {
  classifyActivityRow,
  computeReeditShare,
  failureLine,
  parseArgs,
  renderReport,
} from "../bin/event-reedit-baseline.mjs";

// Fixture rows mirror the shapes src/admin/store-event-writes.ts writes
// today ({field: {before, after}}) and the imported legacy spatie shape
// ({attributes, old}) documented in docs/data-import.md.
const at = (iso) => iso;
const publish = (subjectId, createdAt) => ({
  subjectType: "Event",
  subjectId,
  description: "published event Fixture",
  event: null,
  properties: { status: { before: "draft", after: "published" } },
  createdAt,
});
const edit = (subjectId, createdAt) => ({
  subjectType: "Event",
  subjectId,
  description: "updated event Fixture",
  event: null,
  properties: { title: { before: "Old", after: "New" } },
  createdAt,
});
const window = {
  windowStart: at("2026-10-01T00:00:00Z"),
  windowEnd: at("2026-10-29T00:00:00Z"),
  observedUntil: at("2026-10-29T01:00:00Z"),
};

describe("classifyActivityRow", () => {
  it("recognises a current-app publish transition", () => {
    expect(classifyActivityRow(publish("k1", at("2026-10-02T00:00:00Z")))).toBe("publish");
  });

  it("recognises a legacy spatie publish transition", () => {
    expect(
      classifyActivityRow({
        subjectType: "App\\Models\\Event",
        subjectId: "42",
        description: "updated",
        event: "updated",
        properties: { attributes: { status: "published" }, old: { status: "draft" } },
        createdAt: at("2026-10-02T00:00:00Z"),
      }),
    ).toBe("publish");
  });

  it("counts content edits but not cancel or RSVP toggles", () => {
    expect(classifyActivityRow(edit("k1", at("2026-10-02T00:30:00Z")))).toBe("edit");
    expect(
      classifyActivityRow({
        ...publish("k1", at("2026-10-02T00:30:00Z")),
        description: "cancelled event Fixture",
        properties: { status: { before: "published", after: "cancelled" } },
      }),
    ).toBe("other");
    expect(
      classifyActivityRow({
        subjectType: "Event",
        subjectId: "k1",
        description: "paused RSVPs for event Fixture",
        event: null,
        properties: { rsvpOpen: { before: true, after: false } },
        createdAt: at("2026-10-02T00:30:00Z"),
      }),
    ).toBe("other");
    expect(
      classifyActivityRow({
        subjectType: "App\\Models\\Event",
        subjectId: "42",
        description: "updated",
        event: "updated",
        properties: { attributes: { status: "cancelled" }, old: { status: "published" } },
        createdAt: at("2026-10-02T00:30:00Z"),
      }),
    ).toBe("other");
  });

  it("ignores non-event subjects", () => {
    expect(classifyActivityRow({ ...publish("k1", "x"), subjectType: "FeaturedContent" })).toBe(
      "other",
    );
  });
});

describe("computeReeditShare", () => {
  it("counts an edit 30 minutes after publish, not one 61 minutes after", () => {
    const report = computeReeditShare(
      [
        publish("fast", at("2026-10-02T10:00:00Z")),
        edit("fast", at("2026-10-02T10:30:00Z")),
        publish("slow", at("2026-10-03T10:00:00Z")),
        edit("slow", at("2026-10-03T11:01:00Z")),
        publish("clean", at("2026-10-04T10:00:00Z")),
      ],
      window,
    );
    expect(report).toMatchObject({ published: 3, reedited: 1, underObserved: 0 });
    expect(report.sharePercent).toBe(33.3);
  });

  it("includes the exact 60-minute boundary and excludes edits at publish time", () => {
    const report = computeReeditShare(
      [
        publish("edge", at("2026-10-02T10:00:00Z")),
        edit("edge", at("2026-10-02T11:00:00Z")),
        publish("same", at("2026-10-02T12:00:00Z")),
        edit("same", at("2026-10-02T12:00:00Z")),
      ],
      window,
    );
    expect(report).toMatchObject({ published: 2, reedited: 1 });
  });

  it("counts only first publishes inside the window", () => {
    const report = computeReeditShare(
      [
        publish("before", at("2026-09-30T23:00:00Z")),
        edit("before", at("2026-10-01T00:30:00Z")),
        publish("twice", at("2026-10-05T10:00:00Z")),
        publish("twice", at("2026-10-06T10:00:00Z")),
        edit("twice", at("2026-10-06T10:30:00Z")),
      ],
      window,
    );
    // "before" published outside the window; "twice" counts once, and the
    // edit follows its second publish but not its first, so it is clean.
    expect(report).toMatchObject({ published: 1, reedited: 0 });
  });

  it("excludes publishes still inside their observation hour", () => {
    const report = computeReeditShare([publish("fresh", at("2026-10-28T23:45:00Z"))], {
      ...window,
      observedUntil: at("2026-10-29T00:30:00Z"),
    });
    expect(report).toMatchObject({ published: 0, reedited: 0, underObserved: 1 });
    expect(report.sharePercent).toBeNull();
  });

  it("reports a null share, never 0, when nothing was published", () => {
    const report = computeReeditShare([], window);
    expect(report.published).toBe(0);
    expect(report.sharePercent).toBeNull();
    expect(renderReport(report, false)).toContain("n/a (nothing published)");
    expect(JSON.parse(renderReport(report, true)).sharePercent).toBeNull();
  });
});

describe("failureLine", () => {
  it("prints the SQLSTATE code and nothing else", () => {
    expect(
      failureLine(Object.assign(new Error("relation does not exist"), { code: "42P01" })),
    ).toBe("REEDIT_BASELINE_FAILED sqlstate=42P01");
    expect(failureLine(new Error("boom"))).toBe("REEDIT_BASELINE_FAILED sqlstate=UNKNOWN");
    // A crafted code never leaks into stderr verbatim.
    expect(failureLine({ code: "42P01\nhost=db.internal" })).toBe(
      "REEDIT_BASELINE_FAILED sqlstate=UNKNOWN",
    );
  });
});

describe("parseArgs", () => {
  it("requires an explicit target and refuses unknown arguments", () => {
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(["--target=prod"])).toThrow();
    expect(() => parseArgs(["--target=production", "--window-days=0"])).toThrow();
    expect(() => parseArgs(["--target=production", "--surprise"])).toThrow();
    expect(parseArgs(["--target=local", "--json"])).toMatchObject({
      target: "local",
      windowDays: 28,
      json: true,
    });
  });
});
