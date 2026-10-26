// Independent acceptance: raw ISO labels, local-zone formatting, unguarded
// toISOString and dropping an unusable row must all fail this suite.
import { beforeAll, describe, expect, it } from "vitest";
import {
  activityRow,
  attr,
  cellsOf,
  chronologyDb,
  compileChronologyKit,
  documentOf,
  elements,
  eventKey,
  instants,
  readChronology,
  rosterRow,
  tableOf,
  text,
  unusable,
  type ChronologyKit,
  type HtmlElement,
  type Renderer,
  type Surface,
} from "./helpers/admin-chronology";

let kit: ChronologyKit;
beforeAll(async () => {
  kit = await compileChronologyKit();
});

const paths = [
  { renderer: "Hono", surface: "roster" },
  { renderer: "Kit", surface: "roster" },
  { renderer: "Hono", surface: "activity" },
  { renderer: "Kit", surface: "activity" },
] as const;

function fixtureFor(surface: Surface, timestamps: unknown[], total?: number) {
  return surface === "roster"
    ? chronologyDb({ roster: timestamps.map(rosterRow), total })
    : chronologyDb({ activity: timestamps.map(activityRow) });
}
function assertReadable(cell: HtmlElement, instant: (typeof instants)[number]) {
  const times = elements(cell, "time");
  expect(times, "valid instants need semantic time, not a plain ISO table cell").toHaveLength(1);
  expect(attr(times[0]!, "datetime")).toBe(instant.iso);
  const label = text(times[0]!);
  expect(label).toMatch(/\bUTC\b/);
  expect(label).toMatch(instant.date);
  expect(label).toContain(instant.clock);
  expect(label, "machine ISO belongs in datetime, not the visible label").not.toContain(
    instant.iso.slice(0, 19),
  );
}
function assertReadBudget(fixture: ReturnType<typeof chronologyDb>, surface: Surface) {
  const reads = fixture.statements.filter(
    (s) => s.sql.startsWith("select ") && !s.sql.startsWith("select set_config("),
  );
  expect(reads).toHaveLength(surface === "roster" ? 3 : 1);
  expect(fixture.statements).toHaveLength(surface === "roster" ? 5 : 4);
  expect(fixture.audits).toHaveLength(1);
  expect(fixture.mutations).toBe(0);
}

for (const { renderer, surface } of paths) {
  describe(`${renderer} ${surface} UTC chronology`, () => {
    for (const instant of instants) {
      it(`renders ${instant.iso} readably while retaining the exact machine instant`, async () => {
        const fixture = fixtureFor(surface, [new Date(instant.iso)]);
        const { response, data } = await readChronology(renderer, surface, fixture, kit);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const html = await response.text();
        const cells = cellsOf(html, surface);
        expect(cells).toHaveLength(1);
        assertReadable(cells[0]![2]!, instant);
        assertReadBudget(fixture, surface);
        if (renderer === "Kit") {
          const wireInstant =
            surface === "roster" ? data.view.roster.entries[0].answeredAt : data.rows[0].createdAt;
          expect(wireInstant).toBe(instant.iso);
          expect(JSON.parse(JSON.stringify(wireInstant))).toBe(instant.iso);
          if (surface === "roster")
            expect(JSON.stringify(data)).not.toContain("100000000000080001");
        }
      });
    }

    for (const bad of unusable) {
      it(`keeps valid sibling rows when one timestamp is ${bad.name}`, async () => {
        // Deliberately not chronological/alphabetical order: presentation may
        // not re-sort rows or reinterpret an updated response as a join time.
        const fixture = fixtureFor(surface, [
          new Date(instants[0].iso),
          bad.value,
          new Date(instants[2].iso),
        ]);
        const { response, data } = await readChronology(renderer, surface, fixture, kit);
        expect(response.status, "one bad timestamp must not discard the investigation page").toBe(
          200,
        );
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const html = await response.text();
        const cells = cellsOf(html, surface);
        expect(cells).toHaveLength(3);
        expect(cells.map((c) => text(c[surface === "roster" ? 0 : 1]!))).toEqual(
          surface === "roster"
            ? ["Zed response", "Middle response", "Ada response"]
            : ["Chronology action 0", "Chronology action 1", "Chronology action 2"],
        );
        assertReadable(cells[0]![2]!, instants[0]);
        assertReadable(cells[2]![2]!, instants[2]);
        const missing = cells[1]![2]!;
        expect(text(missing)).toMatch(/time unavailable/i);
        expect(elements(missing).filter((e) => attr(e, "datetime") !== undefined)).toEqual([]);
        expect(text(missing)).not.toMatch(/Invalid Date|NaN|Infinity|1970/);
        assertReadBudget(fixture, surface);
        if (surface === "roster") {
          expect(text(cells[1]![1]!)).toBe("waitlisted");
          for (const id of ["100000000000080001", "100000000000080002", "100000000000080003"])
            expect(html).not.toContain(id);
          // Audit identity survives even when display time cannot be used.
          expect(String(fixture.audits[0]!.subject_user_ids)).toContain("100000000000080002");
        } else {
          expect(text(cells[1]![0]!)).toBe("42 (legacy ID)");
          expect(text(cells[1]![3]!)).toBe(`Event ${eventKey} (updated)`);
        }
        if (renderer === "Kit") {
          const wire = surface === "roster" ? data.view.roster.entries : data.rows;
          expect(wire).toHaveLength(3);
          expect(surface === "roster" ? wire[0].answeredAt : wire[0].createdAt).toBe(
            instants[0].iso,
          );
          expect(surface === "roster" ? wire[2].answeredAt : wire[2].createdAt).toBe(
            instants[2].iso,
          );
          expect(() => JSON.stringify(data)).not.toThrow();
        }
      });
    }

    it("explains response chronology without implying attendance or original queue entry", async () => {
      const fixture = fixtureFor(surface, [new Date(instants[0].iso)]);
      const { response } = await readChronology(renderer, surface, fixture, kit);
      expect(response.status).toBe(200);
      const doc = documentOf(await response.text());
      const scope =
        surface === "roster"
          ? elements(doc, "section").find((e) => attr(e, "data-testid") === "rsvp-roster")!
          : doc;
      const copy = elements(scope, "p").map(text).join(" ");
      expect(copy).toMatch(/\bUTC\b/);
      if (surface === "roster") {
        expect(copy).toMatch(/answer|response/i);
        expect(copy).toMatch(/changed|updated|latest|last/i);
        expect(copy).toMatch(/(?:not|never|isn't)[^.]*attendance/i);
        expect(copy).toMatch(/waitlist[^.]*(?:join|entry)|(?:join|entry)[^.]*waitlist/i);
      }
    });

    it("retains semantic column labels and the keyboard-focusable labelled table region", async () => {
      const fixture = fixtureFor(surface, [new Date(instants[0].iso)]);
      const { response } = await readChronology(renderer, surface, fixture, kit);
      expect(response.status).toBe(200);
      const html = await response.text();
      const table = tableOf(html, surface);
      const headers = elements(table, "th");
      const labels =
        surface === "roster"
          ? [/^Member\b/, /^Status\b/, /^Answered\b/]
          : [/^Who\b/, /^What\b/, /^When\b/, /^Subject\b/];
      expect(headers).toHaveLength(labels.length);
      headers.forEach((header, i) => expect(text(header)).toMatch(labels[i]!));
      for (const header of headers) expect(attr(header, "scope")).toBe("col");
      const doc = documentOf(html);
      const region = elements(doc).find(
        (e) =>
          attr(e, "data-testid") ===
          `${surface === "roster" ? "roster" : "activity-log"}-table-scroll`,
      )!;
      expect(attr(region, "role")).toBe("region");
      expect(attr(region, "aria-label")).toBe(
        surface === "roster" ? "RSVP roster list" : "Activity log list",
      );
      expect(attr(region, "tabindex")).toBe("0");
      const describedBy = attr(region, "aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(
        elements(doc).some(
          (e) => attr(e, "id") === describedBy && /scroll horizontally/i.test(text(e)),
        ),
      ).toBe(true);
    });
  });
}

for (const { renderer, surface } of paths) {
  for (const admission of ["guest", "member"] as const) {
    it(`${renderer} ${surface} refuses ${admission} before any read or audit`, async () => {
      const fixture = fixtureFor(surface, [new Date(instants[0].iso)]);
      const { response } = await readChronology(renderer, surface, fixture, kit, "", admission);
      expect(response.status).toBe(admission === "guest" ? 302 : 403);
      expect(fixture.statements).toEqual([]);
      expect(fixture.audits).toEqual([]);
      expect(await response.text()).not.toContain("Chronology action");
    });
  }

  it(`${renderer} ${surface} refuses valid rows when the member-access audit fails`, async () => {
    const fixture = chronologyDb({
      roster: [rosterRow(new Date(instants[0].iso))],
      activity: [activityRow(new Date(instants[0].iso))],
      auditFails: true,
    });
    const { response } = await readChronology(renderer, surface, fixture, kit);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).not.toContain("Zed response");
    expect(html).not.toContain("Chronology action");
    expect(
      fixture.statements.filter((s) => s.sql.startsWith('insert into "member_data_access_logs"')),
    ).toHaveLength(1);
    expect(fixture.audits).toEqual([]);
  });

  it(`${renderer} ${surface} does not turn a query programming error into empty success`, async () => {
    const fixture = chronologyDb({
      queryError: new TypeError("synthetic query programming failure"),
    });
    const { response } = await readChronology(renderer, surface, fixture, kit);
    expect(response.status).toBeGreaterThanOrEqual(500);
    const html = await response.text();
    expect(html).not.toMatch(/Time unavailable|No activity|No RSVPs/i);
    expect(html).not.toContain("synthetic query programming failure");
    expect(fixture.audits).toEqual([]);
  });
}

for (const renderer of ["Hono", "Kit"] as Renderer[]) {
  it(`${renderer} roster keeps filters, paging, tie-break and bounded reads unchanged`, async () => {
    const fixture = chronologyDb({
      roster: [
        { ...rosterRow(new Date(instants[0].iso)), username: "Team member", status: "waitlisted" },
      ],
      total: 205,
    });
    const query =
      "roster_status=waitlisted&roster_q=Team&roster_sort=status&roster_order=asc&roster_page=2";
    const { response } = await readChronology(renderer, "roster", fixture, kit, query);
    expect(response.status).toBe(200);
    const html = await response.text();
    const doc = documentOf(html);
    const form = elements(doc, "form").find(
      (e) => attr(e, "action") === `/admin/events/${eventKey}#rsvp-roster`,
    )!;
    expect(attr(form, "method")).toBe("get");
    expect(
      elements(form, "input").some(
        (e) => attr(e, "name") === "roster_q" && attr(e, "value") === "Team",
      ),
    ).toBe(true);
    const select = elements(form, "select")[0]!;
    expect(
      elements(select, "option")
        .find((e) => attr(e, "value") === "waitlisted")
        ?.attrs.some((a) => a.name === "selected"),
    ).toBe(true);
    for (const [rel, page] of [
      ["prev", "1"],
      ["next", "3"],
    ]) {
      const link = elements(doc, "a").find((e) => attr(e, "rel") === rel)!;
      const url = new URL(attr(link, "href")!, "https://example.test");
      expect(url.searchParams.get("roster_page") ?? "1").toBe(page);
      expect(url.searchParams.get("roster_status")).toBe("waitlisted");
      expect(url.searchParams.get("roster_q")).toBe("Team");
      expect(url.searchParams.get("roster_sort")).toBe("status");
      expect(url.searchParams.get("roster_order")).toBe("asc");
    }
    const reads = fixture.statements.filter((s) => s.sql.includes('from "rsvps"'));
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.sql).toContain('"rsvps"."status" =');
      expect(read.params).toContain("waitlisted");
      expect(read.params).toContain("%Team%");
      expect(read.params).toContain(eventKey);
    }
    const page = reads.find((r) => !r.sql.startsWith("select count(*)"))!;
    expect(page.sql).toMatch(/order by "rsvps"\."status" asc, "rsvps"\."user_id"/);
    expect(page.sql).toContain('"rsvps"."updated_at"');
    expect(page.sql).not.toContain('"rsvps"."created_at"');
    expect(page.fields).toEqual(["userId", "memberId", "username", "status", "answeredAt"]);
    expect(page.params.slice(-2)).toEqual([100, 100]);
    assertReadBudget(fixture, "roster");
  });

  it(`${renderer} activity keeps its lookahead, filters, projection and attribution`, async () => {
    const activity = Array.from({ length: 51 }, (_, i) => ({
      ...activityRow(new Date(instants[0].iso), i),
      causerId: "100000000000080011",
    }));
    const fixture = chronologyDb({ activity });
    const { response } = await readChronology(
      renderer,
      "activity",
      fixture,
      kit,
      "subject=Event&causer=100000000000080011&page=2",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(cellsOf(html, "activity")).toHaveLength(50);
    expect(html).not.toContain("Chronology action 50");
    const doc = documentOf(html);
    for (const [rel, page] of [
      ["prev", "1"],
      ["next", "3"],
    ]) {
      const link = elements(doc, "a").find((e) => attr(e, "rel") === rel)!;
      const url = new URL(attr(link, "href")!, "https://example.test");
      expect(url.searchParams.get("subject")).toBe("Event");
      expect(url.searchParams.get("causer")).toBe("100000000000080011");
      expect(url.searchParams.get("page")).toBe(page);
    }
    const read = fixture.statements.find((s) => s.sql.includes('from "activity_log"'))!;
    expect(read.sql).toMatch(
      /order by "activity_log"\."created_at" desc, "activity_log"\."id" desc/,
    );
    expect(read.sql).not.toContain('"properties"');
    expect(read.fields).toEqual([
      "id",
      "description",
      "subjectType",
      "subjectId",
      "causerId",
      "event",
      "createdAt",
    ]);
    expect(read.params).toContain("%Event%");
    expect(read.params).toContain("%100000000000080011%");
    expect(read.params.slice(-2)).toEqual([51, 50]);
    expect(String(fixture.audits[0]!.subject_user_ids)).toContain("100000000000080011");
    expect(String(fixture.audits[0]!.subject_user_ids)).not.toContain('"42"');
    assertReadBudget(fixture, "activity");
  });
}
