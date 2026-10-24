// Independent acceptance ownership: this file and helpers/admin-roster-status.ts.
// Run: npx vitest run test/admin-roster-status-acceptance.test.ts
// Intended RED on the pre-facet base: status is ignored, no native select or
// scoped recovery exists. CONTROL cases remain executable without the feature.
// Mutation targets: dropped/row-only/count-only status predicate; post-page
// filtering; raw/expanded classified SQL; lost filter links; leaked audit subjects.
import { beforeAll, describe, expect, it } from "vitest";
import { validateNonSensitiveRead } from "../src/db/read-classification";
import { MemberReadRefused } from "../src/member-reads";
import {
  compileRosterKit,
  idFor,
  key,
  links,
  needle,
  path,
  readRoster,
  rosterDb,
  rosterHtml,
  statuses,
  subjects,
  text,
  type Renderer,
  type RosterKit,
} from "./helpers/admin-roster-status";

let kit: RosterKit;
beforeAll(async () => {
  kit = await compileRosterKit();
});
const qs = (values: Record<string, string>) => new URLSearchParams(values).toString();
const rosterReads = (fixture: ReturnType<typeof rosterDb>) =>
  fixture.statements.filter((s) => s.sql.includes('from "rsvps"'));
const where = (sql: string) => sql.split(" where ")[1]!.split(/ order by | limit /)[0]!;
const predicate = (sql: string, params: unknown[]) =>
  where(sql).replace(/\$(\d+)/g, (_, n) => JSON.stringify(params[Number(n) - 1]));
function displayedRows(html: string) {
  const body = rosterHtml(html).match(/<tbody>([\s\S]*?)<\/tbody>/)![1]!;
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((r) => [...r[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]!)))
    .filter((r) => r.length === 3);
}
function normalizedLink(href: string) {
  const url = new URL(href, "https://next.example.test");
  expect(url.pathname).toBe(path);
  expect(url.hash).toBe("#rsvp-roster");
  return url.searchParams;
}
function assertBounded(fixture: ReturnType<typeof rosterDb>) {
  const reads = rosterReads(fixture);
  expect(reads).toHaveLength(2);
  expect(reads[0]!.sql).toMatch(/^select count\(\*\) /);
  expect(reads[0]!.fields).toEqual(["n"]);
  expect(reads[0]!.sql).not.toMatch(/limit|offset|group by|union/i);
  expect(reads[1]!.fields.sort()).toEqual([
    "answeredAt",
    "memberId",
    "status",
    "userId",
    "username",
  ]);
  const slot = reads[1]!.sql.match(/ limit \$(\d+)/)![1]!;
  expect(reads[1]!.params[Number(slot) - 1]).toBe(100);
  expect(reads[1]!.sql).toMatch(
    /order by "rsvps"\."(?:updated_at|status)" (?:asc|desc), "rsvps"\."user_id"/,
  );
  expect(
    fixture.statements.filter(
      (s) => s.sql.includes('from "events"') && !s.sql.includes('from "rsvps"'),
    ),
  ).toHaveLength(1);
  expect(fixture.mutations).toBe(0);
}

for (const renderer of ["Hono", "Kit"] as const) {
  describe(`RAF paired ${renderer}: answer facet before paging`, () => {
    it.each(statuses)(
      "RAF-01 %s yields exactly the first 100 of 105 matching answers, not seats",
      async (status) => {
        const fixture = rosterDb();
        const response = await readRoster(renderer, fixture, qs({ roster_status: status }), kit);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const html = await response.text();
        const rows = displayedRows(html);
        expect(rows).toHaveLength(100);
        expect([...new Set(rows.map((r) => r[1]))]).toEqual([status]);
        const section = rosterHtml(html);
        const range = text(section.match(/data-testid="roster-range"[^>]*>([\s\S]*?)<\/p>/)![1]!);
        expect(range).toMatch(/1\s*[-–]\s*100 of 105\b/);
        expect(range).toMatch(/responses/i);
        expect(text(section)).not.toMatch(/\b(?:seats|attendance|attended|occupancy)\b/i);
        const next = links(section).find((l) => l.rel === "next");
        expect(next).toBeDefined();
        expect(normalizedLink(next!.href).get("roster_status")).toBe(status);
        assertBounded(fixture);
        const reads = rosterReads(fixture);
        expect(predicate(reads[0]!.sql, reads[0]!.params)).toBe(
          predicate(reads[1]!.sql, reads[1]!.params),
        );
        expect(where(reads[0]!.sql)).toMatch(/"rsvps"\."status" = \$\d+/);
        expect(subjects(fixture)).toEqual(
          Array.from({ length: 100 }, (_, i) => idFor(i, statuses.indexOf(status))),
        );
        expect(fixture.audits).toHaveLength(1);
        expect(fixture.audits[0]).toMatchObject({
          viewer_discord_id: "100000000000000103",
          resource: "events",
          action: "view",
          route: "admin.events.edit",
          subject_count: 100,
        });
      },
    );

    it.each(statuses)(
      "RAF-02 %s second page contains only its last five answers with exact audit subjects",
      async (status) => {
        const fixture = rosterDb();
        const response = await readRoster(
          renderer,
          fixture,
          qs({
            roster_status: status,
            roster_page: "2",
            roster_sort: "status",
            roster_order: "asc",
          }),
          kit,
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        const rows = displayedRows(html);
        expect(rows).toHaveLength(5);
        expect([...new Set(rows.map((r) => r[1]))]).toEqual([status]);
        expect(text(rosterHtml(html))).toMatch(/101\s*[-–]\s*105 of 105\b/);
        expect(links(rosterHtml(html)).find((l) => l.rel === "next")).toBeUndefined();
        expect(subjects(fixture)).toEqual(
          Array.from({ length: 5 }, (_, i) => idFor(i + 100, statuses.indexOf(status))),
        );
        const prev = links(rosterHtml(html)).find((l) => l.rel === "prev")!;
        const state = normalizedLink(prev.href);
        expect(state.get("roster_status")).toBe(status);
        expect(state.get("roster_page") ?? "1").toBe("1");
        assertBounded(fixture);
      },
    );

    it.each(["asc", "desc"])(
      "RAF-03 combines literal Unicode/LIKE-escaped member search with the facet (%s)",
      async (order) => {
        const fixture = rosterDb();
        const response = await readRoster(
          renderer,
          fixture,
          qs({
            roster_status: "waitlisted",
            roster_q: ` \0${needle}\0 `,
            roster_sort: "answered",
            roster_order: order,
            roster_page: "2",
          }),
          kit,
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(displayedRows(html)).toHaveLength(5);
        expect(displayedRows(html).map((r) => r[1])).toEqual(Array(5).fill("waitlisted"));
        const reads = rosterReads(fixture);
        expect(reads[0]!.params).toContain("%Café \\%\\_\\\\ Team%");
        expect(predicate(reads[0]!.sql, reads[0]!.params)).toBe(
          predicate(reads[1]!.sql, reads[1]!.params),
        );
        expect(subjects(fixture)).toEqual([
          idFor(100, 1),
          idFor(101, 1),
          idFor(102, 1),
          idFor(103, 1),
          idFor(104, 1),
        ]);
        for (const link of links(rosterHtml(html)).filter(
          (l) =>
            l.rel === "prev" ||
            /Sort by/i.test(l.label) ||
            l.label.startsWith("Status") ||
            l.label.startsWith("Answered"),
        )) {
          const state = normalizedLink(link.href);
          expect(state.get("roster_status")).toBe("waitlisted");
          expect(state.get("roster_q")).toBe(needle);
          expect(state.get("roster_page") ?? "1").toBe("1");
        }
        assertBounded(fixture);
      },
    );

    it("RAF-04 supplies the native allowlist in a separate GET-only form resetting page one", async () => {
      const fixture = rosterDb();
      const response = await readRoster(
        renderer,
        fixture,
        "roster_status=maybe&roster_q=Caf%C3%A9&roster_page=3&roster_sort=status&roster_order=asc",
        kit,
      );
      expect(response.status).toBe(200);
      const section = rosterHtml(await response.text());
      const form = section.match(/<form\b[\s\S]*?<\/form>/)![0];
      expect(form).toMatch(/method="get"/i);
      expect(form).toContain(`action="${path}#rsvp-roster"`);
      const select = form.match(/<select\b[^>]*name="roster_status"[^>]*>([\s\S]*?)<\/select>/);
      expect(select, "native answer-status control is missing").not.toBeNull();
      const options = [...select![1]!.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)];
      expect(options.map((o) => [o[1]!.match(/value="([^"]*)"/)?.[1], text(o[2]!)])).toEqual([
        ["", "All"],
        ["going", "Going"],
        ["waitlisted", "Waitlisted"],
        ["maybe", "Maybe"],
        ["not_going", "Not going"],
      ]);
      expect(options.find((o) => o[1]!.includes('value="maybe"'))![1]).toMatch(
        /\bselected(?:="(?:true|selected|)")?/,
      );
      expect(form).not.toMatch(
        /name="(?:roster_page|title|game|description|starts_at|status|capacity)"|formaction=|formmethod=/,
      );
      expect(form).toContain('name="roster_q"');
      expect(form).toContain('name="roster_sort" value="status"');
      expect(form).toContain('name="roster_order" value="asc"');
    });

    it("RAF-05 recovers a filtered zero result by clearing only roster filters", async () => {
      const fixture = rosterDb();
      const response = await readRoster(
        renderer,
        fixture,
        qs({
          roster_status: "going",
          roster_q: "Nobody <&>",
          roster_sort: "status",
          roster_order: "asc",
        }),
        kit,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(displayedRows(html)).toEqual([]);
      const section = rosterHtml(html);
      expect(text(section)).toMatch(/no .*?(?:match|responses)/i);
      expect(text(section)).not.toContain("No RSVPs yet.");
      const clear = links(section).find((l) => l.label === "Clear roster filters");
      expect(clear).toBeDefined();
      const state = normalizedLink(clear!.href);
      expect(state.has("roster_status")).toBe(false);
      expect(state.has("roster_q")).toBe(false);
      expect(state.has("roster_page")).toBe(false);
      expect(state.get("roster_sort")).toBe("status");
      expect(state.get("roster_order")).toBe("asc");
      expect(fixture.audits).toEqual([]);
      expect(fixture.mutations).toBe(0);
    });

    it("RAF-06 recovers a past-end read to the same filtered response set's first page", async () => {
      const fixture = rosterDb();
      const response = await readRoster(
        renderer,
        fixture,
        qs({
          roster_status: "waitlisted",
          roster_q: needle,
          roster_page: "999",
          roster_sort: "answered",
          roster_order: "desc",
        }),
        kit,
      );
      expect(response.status).toBe(200);
      const section = rosterHtml(await response.text());
      expect(text(section)).toMatch(/0\s*[-–]\s*0 of 105\b/);
      const first = links(section).find((l) => l.label === "First page of these responses");
      expect(first).toBeDefined();
      const state = normalizedLink(first!.href);
      expect(Object.fromEntries(state)).toEqual({
        roster_status: "waitlisted",
        roster_q: needle,
        roster_sort: "answered",
        roster_order: "desc",
      });
      expect(links(section).find((l) => l.label === "Clear roster filters")).toBeDefined();
      expect(fixture.audits).toEqual([]);
    });

    it.each([
      "",
      "all",
      "Going",
      "attended",
      "not-going",
      " going ",
      "going\0",
      "x".repeat(129),
      "going' OR 1=1--",
    ])(
      "RAF-C01 CONTROL invalid/absent facet %j normalizes to All without SQL interpolation",
      async (status) => {
        const fixture = rosterDb();
        const response = await readRoster(
          renderer,
          fixture,
          qs({ roster_status: status, roster_page: "5" }),
          kit,
        );
        expect(response.status).toBe(200);
        const section = rosterHtml(await response.text());
        expect(displayedRows(section)).toHaveLength(20);
        expect(text(section)).toMatch(/401\s*[-–]\s*420 of 420\b/);
        const reads = rosterReads(fixture);
        expect(where(reads[0]!.sql)).not.toContain('"rsvps"."status"');
        for (const link of links(section))
          expect(normalizedLink(link.href).has("roster_status")).toBe(false);
        assertBounded(fixture);
      },
    );

    it.each([
      ["roster_status=waitlisted&roster_status=going", "waitlisted"],
      ["roster_status=going&roster_status=waitlisted", "going"],
      ["roster_status=invalid&roster_status=going", ""],
    ])(
      "RAF-07 duplicate status retains existing first-value-wins extraction: %s",
      async (query, wanted) => {
        const fixture = rosterDb();
        const response = await readRoster(renderer, fixture, query + "&roster_page=2", kit);
        expect(response.status).toBe(200);
        const html = await response.text();
        const rows = displayedRows(html);
        if (wanted) {
          expect(rows).toHaveLength(5);
          expect([...new Set(rows.map((r) => r[1]))]).toEqual([wanted]);
        } else expect(rows).toHaveLength(100);
        for (const link of links(rosterHtml(html))) {
          const state = normalizedLink(link.href);
          expect(state.getAll("roster_status")).toEqual(wanted ? [wanted] : []);
        }
      },
    );

    it("RAF-08 drops an overlong member search without dropping a valid facet", async () => {
      const fixture = rosterDb();
      const response = await readRoster(
        renderer,
        fixture,
        qs({ roster_status: "not_going", roster_q: "界".repeat(129) }),
        kit,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect([...new Set(displayedRows(html).map((r) => r[1]))]).toEqual(["not_going"]);
      expect(rosterReads(fixture)[0]!.params).not.toContain("界".repeat(129));
      expect(text(rosterHtml(html))).toMatch(/of 105\b/);
    });

    it("RAF-10 normalizes hostile sort/order/unsafe page without dropping a valid facet or a 128-character search", async () => {
      const fixture = rosterDb();
      const response = await readRoster(
        renderer,
        fixture,
        qs({
          roster_status: "going",
          roster_q: "界".repeat(128),
          roster_sort: "status;drop table users",
          roster_order: "asc;drop table rsvps",
          roster_page: "9007199254740991",
        }),
        kit,
      );
      expect(response.status).toBe(200);
      const section = rosterHtml(await response.text());
      const reads = rosterReads(fixture);
      expect(reads[0]!.params).toContain(`%${"界".repeat(128)}%`);
      expect(where(reads[0]!.sql)).toMatch(/"rsvps"\."status" = \$\d+/);
      expect(reads[1]!.sql).toContain('order by "rsvps"."updated_at" desc, "rsvps"."user_id"');
      expect(reads[1]!.sql).not.toMatch(/drop table|9007199254740991/i);
      const offsetSlot = reads[1]!.sql.match(/ offset \$(\d+)/)?.[1];
      expect(offsetSlot ? reads[1]!.params[Number(offsetSlot) - 1] : 0).toBe(0);
      const clear = links(section).find((l) => l.label === "Clear roster filters")!;
      expect(Object.fromEntries(normalizedLink(clear.href))).toEqual({
        roster_sort: "answered",
        roster_order: "desc",
      });
      assertBounded(fixture);
    });

    it("RAF-11 status-only empty results offer scoped recovery rather than pretending the facet is absent", async () => {
      const fixture = rosterDb({ noAnswers: true });
      const response = await readRoster(renderer, fixture, "roster_status=going", kit);
      expect(response.status).toBe(200);
      const section = rosterHtml(await response.text());
      expect(text(section)).not.toMatch(/No (?:RSVPs|responses) yet\./);
      const clear = links(section).find((l) => l.label === "Clear roster filters");
      expect(clear).toBeDefined();
      expect(normalizedLink(clear!.href).has("roster_status")).toBe(false);
      expect(fixture.audits).toEqual([]);
      assertBounded(fixture);
    });

    it("RAF-C02 CONTROL all answers and bounded literal member search still work", async () => {
      const fixture = rosterDb();
      const response = await readRoster(
        renderer,
        fixture,
        qs({ roster_q: needle, roster_sort: "answered", roster_order: "asc", roster_page: "5" }),
        kit,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(displayedRows(html)).toHaveLength(19);
      expect(text(rosterHtml(html))).toMatch(/401\s*[-–]\s*419 of 419\b/);
      expect(subjects(fixture)).not.toContain(idFor(104, 2));
      assertBounded(fixture);
    });

    it.each(["guest", "member"] as const)(
      "RAF-C03 CONTROL %s is refused before any protected SQL",
      async (admission) => {
        const fixture = rosterDb();
        const response = await readRoster(renderer, fixture, "roster_status=going", kit, admission);
        expect(response.status).toBe(admission === "guest" ? 302 : 403);
        expect(await response.text()).not.toContain(needle);
        expect(fixture.statements).toEqual([]);
      },
    );

    it("RAF-C04 CONTROL failed audit refuses the whole buffered member render without mutations", async () => {
      const fixture = rosterDb({ auditFails: true });
      const response = await readRoster(renderer, fixture, "roster_status=going", kit);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const html = await response.text();
      expect(html).not.toMatch(/Café|Unknown member|data-testid="rsvp-roster"/);
      expect(
        fixture.statements.filter((s) => s.sql.startsWith('insert into "member_data_access_logs"')),
      ).toHaveLength(1);
      expect(rosterReads(fixture)).toHaveLength(2);
      expect(fixture.mutations).toBe(0);
    });

    it("RAF-C05 CONTROL genuinely empty event is distinct from a filtered zero and performs no audit insert", async () => {
      const fixture = rosterDb({ noAnswers: true });
      const response = await readRoster(renderer, fixture, "", kit);
      expect(response.status).toBe(200);
      expect(text(rosterHtml(await response.text()))).toMatch(/No (?:RSVPs|responses) yet\./);
      expect(fixture.audits).toEqual([]);
      assertBounded(fixture);
    });
  });
}

const countBase =
  'select count(*) from "rsvps" inner join "events" on "events"."id" = "rsvps"."event_id"';
const countStatus = `${countBase} where ("events"."event_key" = $1 and "rsvps"."status" = $2)`;
const countCombined = `${countBase} left join "users" on "users"."id" = "rsvps"."user_id" where ("events"."event_key" = $1 and "rsvps"."status" = $2 and "users"."username" ilike $3)`;
describe("RAF-09 classified counts remain a narrow cardinality exception", () => {
  it.each([countStatus, countCombined])("accepts a fixed bound facet cardinality: %s", (sql) => {
    expect(() => validateNonSensitiveRead("roster-count", sql)).not.toThrow();
  });
  it.each([
    countStatus.replace("count(*)", '"rsvps"."user_id"'),
    countCombined.replace("count(*)", 'count(*), "users"."username"'),
    countStatus.replace('"events"."event_key" = $1 and ', ""),
    countStatus.replace('"rsvps"."status" = $2', '"rsvps"."status" = $2 or true'),
    countStatus + ' union select count(*) from "users"',
    countCombined + ' group by "users"."id"',
    countCombined.replace('"users"."username" ilike $3', '"users"."id" = $3'),
    countCombined + '; delete from "rsvps"',
    `with removed as (delete from "rsvps" returning *) ${countStatus}`,
  ])("CONTROL refuses expanded authority/projection: %s", (sql) => {
    expect(() => validateNonSensitiveRead("roster-count", sql)).toThrow(MemberReadRefused);
  });
});
