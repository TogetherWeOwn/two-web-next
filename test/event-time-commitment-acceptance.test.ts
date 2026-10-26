// Test-author-owned, fixture-only acceptance. No implementation or output mocks.
import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { beforeAll, describe, expect, it } from "vitest";
import * as dateFormat from "../src/events/date-format";
import { eventIcs, googleCalendarUrl } from "../src/events/feeds";
import {
  clockCases,
  clockRows,
  durationCases,
  durationEvent,
} from "./fixtures/event-time-commitment";
import { calendarLinks, renderCalendar } from "./helpers/calendar-multiday-acceptance";
import {
  compileScheduleKit,
  renderScheduledPage,
  scheduleOrigin,
  type KitRenderer,
} from "./helpers/event-scheduled-range";

type Node = DefaultTreeAdapterMap["node"];
function descendants(node: Node): Node[] {
  return [node, ...("childNodes" in node ? node.childNodes.flatMap(descendants) : [])];
}
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (["script", "style"].includes(node.nodeName)) return "";
  return ("childNodes" in node ? node.childNodes.map(text).join(" ") : "")
    .replace(/\s+/g, " ")
    .trim();
}
function metadata(html: string) {
  const document = parse(html);
  return descendants(document)
    .filter((node) => node.nodeName === "dt")
    .map((term) => {
      const siblings = "parentNode" in term && term.parentNode ? term.parentNode.childNodes : [];
      const definition = siblings
        .slice(siblings.findIndex((node) => node === term) + 1)
        .find((node) => node.nodeName !== "#text" && node.nodeName !== "#comment");
      return { label: text(term), value: definition?.nodeName === "dd" ? text(definition) : "" };
    });
}

let kit: KitRenderer;
beforeAll(async () => {
  kit = await compileScheduleKit();
});

describe("shared elapsed-millisecond formatting boundary", () => {
  // A missing export fails an assertion, not module loading: the consumer tests
  // below independently demonstrate why the shared behavior is needed.
  function format(milliseconds: number): unknown {
    const candidate = (dateFormat as Record<string, unknown>).formatElapsedDuration;
    expect(candidate, "shared formatElapsedDuration(milliseconds) formatter").toBeTypeOf(
      "function",
    );
    return (candidate as (value: number) => unknown)(milliseconds);
  }
  it.each(durationCases)("formats $name without a host clock", ({ milliseconds, want }) => {
    expect(format(milliseconds)).toBe(want);
  });
  it.each([0, -1, -60_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "omits unusable elapsed milliseconds: %s",
    (milliseconds) => {
      expect(format(milliseconds)).toBeNull();
    },
  );
  it("treats a positive millisecond as less than a minute", () => {
    expect(format(1)).toBe("Less than a minute");
  });
});

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin}: elapsed commitment in actual detail SSR`, () => {
    for (const viewer of ["guest", "member"] as const) {
      it.each(durationCases)(`${viewer}: metadata reveals $name`, async (fixture) => {
        const { status, html } = await renderScheduledPage(
          twin,
          durationEvent(fixture),
          viewer,
          kit,
        );
        expect(status).toBe(200);
        expect(metadata(html).filter((entry) => entry.label === "Duration")).toEqual([
          { label: "Duration", value: fixture.want },
        ]);
      });
    }
    it.each([0, -60_000])(
      "positive control: omits Duration for a %s ms range",
      async (milliseconds) => {
        const row = durationEvent(durationCases[0]!);
        row.endsAt = new Date(row.startsAt.getTime() + milliseconds);
        const { status, html } = await renderScheduledPage(twin, row, "guest", kit);
        expect(status).toBe(200);
        expect(metadata(html).some((entry) => entry.label === "Duration")).toBe(false);
      },
    );
    it("positive control: retains exact endpoints, labels, RSVP and UTC exports", async () => {
      const fixture = durationCases[6]!;
      const row = durationEvent(fixture);
      const { status, html } = await renderScheduledPage(twin, row, "member", kit);
      expect(status).toBe(200);
      const nodes = descendants(parse(html));
      const instants = nodes
        .filter((node) => node.nodeName === "time" && "attrs" in node)
        .flatMap((node) =>
          "attrs" in node
            ? node.attrs.filter((attr) => attr.name === "datetime").map((attr) => attr.value)
            : [],
        );
      expect(instants).toContain("2030-11-03T05:30:00.000Z");
      expect(instants).toContain("2030-11-03T06:30:00.000Z");
      expect(metadata(html).map((entry) => entry.label)).toEqual(
        expect.arrayContaining(["Starts", "Ends"]),
      );
      expect(html).toContain('data-testid="rsvp-going"');
      const ics = eventIcs(row, scheduleOrigin);
      // Freeze the existing export bytes, not just a reconstructed endpoint.
      expect(createHash("sha256").update(ics).digest("hex")).toBe(
        "71efca07ddea119bfda5b7a2b528d18648b6fe91179985f315b5f6a8e0aacce6",
      );
      expect(createHash("sha256").update(googleCalendarUrl(row)).digest("hex")).toBe(
        "5697f2a377b1c92d00a4697e17729746f3a0a7078554058761e8b5d00103c940",
      );
      expect(ics).toContain("DTSTART:20301103T053000Z\r\nDTEND:20301103T063000Z\r\n");
      expect(new URL(googleCalendarUrl(row)).searchParams.get("dates")).toBe(
        "20301103T053000Z/20301103T063000Z",
      );
      expect(row.startsAt.toISOString()).toBe("2030-11-03T05:30:00.000Z");
      expect(row.endsAt.toISOString()).toBe("2030-11-03T06:30:00.000Z");
    });
  });

  describe(`${twin}: host-zone clocks in month-grid links`, () => {
    for (const fixture of clockCases) {
      it(`names ${fixture.name} visibly and accessibly without losing a truncated title`, async () => {
        const html = await renderCalendar(twin, clockRows(), {
          month: "2030-06",
          zone: "Asia/Tokyo",
        });
        const link = calendarLinks(html).find(
          (entry) => entry.day === "2030-06-01" && entry.href.includes(fixture.eventKey),
        );
        expect(link).toBeDefined();
        expect(link!.text).toContain(`${fixture.clock} ${fixture.effective}`);
        expect(link!.name).toContain(`${fixture.clock} ${fixture.effective}`);
        // The ellipsis can be visual-only; all actual visible words must be in
        // order in the name, and the full title remains available to AT.
        expect(link!.name).toContain(link!.text.replace(/…$/, ""));
        expect(link!.name).toContain(fixture.title);
        // Timed entries retain their short host-day wording; continuations below
        // retain the long displayed day instead.
        expect(link!.name).toContain("Sat 1 Jun");
        expect(link!.name).not.toContain("Invalid/Timezone");
        if (fixture.status === "cancelled") {
          expect(link!.text).toContain("Cancelled");
          expect(link!.name).toContain("Cancelled");
        }
      });
    }
    it("uses the page fallback zone for a Discord-only row without inventing an end", async () => {
      const html = await renderCalendar(twin, clockRows(), {
        month: "2030-06",
        zone: "Asia/Tokyo",
      });
      const link = calendarLinks(html).find((entry) => entry.text.includes("Discord transient"));
      expect(link).toBeDefined();
      expect(link!.day).toBe("2030-06-02");
      expect(link!.text).toContain("03:00 Asia/Tokyo");
      expect(link!.name).toContain("03:00 Asia/Tokyo");
      expect(link!.name).toContain("Sun 2 Jun");
    });
    it("positive control: retains host-day bucketing, continuation wording and destinations", async () => {
      const html = await renderCalendar(twin, clockRows(), {
        month: "2030-06",
        zone: "Asia/Tokyo",
      });
      const links = calendarLinks(html);
      for (const fixture of clockCases) {
        const entries = links.filter((entry) => entry.href.includes(fixture.eventKey));
        expect(entries.map((entry) => entry.day)).toEqual(["2030-06-01", "2030-06-02"]);
        const continuation = entries[1]!;
        expect(continuation.text).toContain("Continues");
        expect(continuation.name).toContain("Continues");
        expect(continuation.name).toContain(fixture.title);
        expect(continuation.name).toContain("2 June 2030");
        expect(continuation.text).not.toMatch(/\d{2}:\d{2}/);
        expect(continuation.name).not.toMatch(/\d{2}:\d{2}/);
        expect(continuation.text).not.toContain(fixture.effective);
        expect(
          entries.every(
            (entry) => entry.href === `/events?event=${fixture.eventKey}#event-${fixture.eventKey}`,
          ),
        ).toBe(true);
      }
    });
  });
}

it("Hono and Kit expose identical metadata for the same elapsed interval", async () => {
  const row = durationEvent(durationCases[0]!);
  const hono = await renderScheduledPage("Hono", row, "guest", kit);
  const svelte = await renderScheduledPage("Kit", row, "guest", kit);
  expect(metadata(hono.html)).toEqual(metadata(svelte.html));
});
