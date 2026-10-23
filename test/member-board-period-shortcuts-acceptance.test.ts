// route-inventory: GET /leaderboards/members
// Acceptance-owned RED handoff. Builder consumes this file unchanged.
// Catch missing/stale/local-time shortcuts, lost game/scope, false current-period
// marks, grammar widening, extra ranking reads, and leaked member identities.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  boardPeriodHarness,
  compileBoardPeriodKit,
  currentMark,
  namedLink,
  periodLinks,
  seasonInput,
  type BoardPeriodKit,
  type Twin,
} from "./helpers/member-board-period-shortcuts";

const NOW = "2032-04-01T00:00:00.000Z";
const BOUNDARIES = [
  ["2031-12-31T23:59:59.999Z", "2031-12", "2031-Q4"],
  ["2032-01-01T00:00:00.000Z", "2032-01", "2032-Q1"],
  ["2032-02-29T23:59:59.999Z", "2032-02", "2032-Q1"],
  ["2032-03-01T00:00:00.000Z", "2032-03", "2032-Q1"],
  ["2032-03-31T23:59:59.999Z", "2032-03", "2032-Q1"],
  [NOW, "2032-04", "2032-Q2"],
  ["2032-10-01T00:00:00.000Z", "2032-10", "2032-Q4"],
] as const;
const PATH = "/leaderboards/members";
let kit: BoardPeriodKit;
beforeAll(async () => {
  kit = await compileBoardPeriodKit();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function freeze(instant = NOW) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

function expectDestination(href: string, season: string, scope: string, activity: string | null) {
  const url = new URL(href, "https://period.example.test");
  expect(url.origin).toBe("https://period.example.test");
  expect(url.pathname).toBe(PATH);
  expect(url.hash).toBe("");
  expect(url.searchParams.get("season") ?? "all").toBe(season);
  expect(url.searchParams.get("scope") ?? "overall").toBe(scope);
  expect(url.searchParams.get("activity")).toBe(activity);
  expect(
    [...url.searchParams.keys()].every((key) => ["season", "scope", "activity"].includes(key)),
  ).toBe(true);
  expect(new Set(url.searchParams.keys()).size).toBe([...url.searchParams.keys()].length);
}

for (const twin of ["Hono", "Kit"] as const satisfies readonly Twin[]) {
  describe(`${twin} member-board native UTC periods`, () => {
    it.each(BOUNDARIES)(
      "request at %s offers month %s and quarter %s",
      async (instant, month, quarter) => {
        freeze(instant);
        const h = boardPeriodHarness(kit);
        const res = await h.request(twin, `${PATH}?season=2024`);
        expect(res.status).toBe(200);
        const links = periodLinks(res.html);
        expectDestination(links[0].href, month, "overall", null);
        expectDestination(links[1].href, quarter, "overall", null);
        expectDestination(links[2].href, "all", "overall", null);
      },
    );

    it("recomputes shortcuts on a later request instead of retaining the first render's clock", async () => {
      freeze("2031-12-31T23:59:59.999Z");
      const h = boardPeriodHarness(kit);
      const before = await h.request(twin, PATH);
      vi.setSystemTime(new Date("2032-01-01T00:00:00.000Z"));
      const after = await h.request(twin, PATH);
      expectDestination(namedLink(before.html, "This month").href, "2031-12", "overall", null);
      expectDestination(namedLink(after.html, "This month").href, "2032-01", "overall", null);
      expectDestination(namedLink(after.html, "This quarter").href, "2032-Q1", "overall", null);
    });

    it("samples a coherent month/quarter pair even if the clock crosses a year boundary during rendering", async () => {
      freeze("2031-12-31T23:59:59.999Z");
      const Clock = Date;
      let tick = 0;
      // Only zero-argument clock samples advance; constructing known dates is
      // unchanged. Either side of midnight is valid, a mixed pair is not.
      class CrossingDate extends Clock {
        constructor(value?: string | number) {
          if (arguments.length === 0)
            super(tick++ % 2 === 0 ? "2031-12-31T23:59:59.999Z" : "2032-01-01T00:00:00.000Z");
          else super(value!);
        }
      }
      vi.stubGlobal("Date", CrossingDate);
      const res = await boardPeriodHarness(kit).request(twin, PATH);
      const links = periodLinks(res.html);
      const month = new URL(links[0].href, "https://period.example.test").searchParams.get(
        "season",
      );
      const quarter = new URL(links[1].href, "https://period.example.test").searchParams.get(
        "season",
      );
      expect(["2031-12/2031-Q4", "2032-01/2032-Q1"]).toContain(`${month}/${quarter}`);
    });

    for (const scope of ["overall", "relative"] as const) {
      it.each([null, "d&d", "mick's game / co-op", "all"])(
        `every shortcut preserves ${scope} and game %j`,
        async (activity) => {
          freeze();
          const h = boardPeriodHarness(kit);
          const query = new URLSearchParams({
            season: "2024-Q3",
            scope,
            redirect: "https://untrusted.example",
          });
          if (activity !== null) query.set("activity", activity);
          const res = await h.request(twin, `${PATH}?${query}`);
          expect(res.status).toBe(200);
          const links = periodLinks(res.html);
          for (const [index, season] of ["2032-04", "2032-Q2", "all"].entries()) {
            expectDestination(links[index]!.href, season, scope, activity);
            // Follow the emitted link through the real route/load, not a URL builder.
            const next = await h.request(twin, links[index]!.href);
            expect(next.status).toBe(200);
            expect(seasonInput(next.html).value).toBe(season);
            const scopeLink = namedLink(next.html, scope === "relative" ? "Around you" : "Overall");
            expect(currentMark(scopeLink.attrs)).toBe(true);
            expect(
              next.headers
                .get("cache-control")
                ?.split(/\s*,\s*/)
                .sort(),
            ).toEqual(["no-store", "private"]);
          }
        },
      );
    }

    it.each([
      ["", "All time"],
      ["?season=all", "All time"],
      ["?season=2032-04", "This month"],
      ["?season=2032-Q2", "This quarter"],
      ["?season=2032", null],
      ["?season=2032-03", null],
      ["?season=2024-Q3", null],
    ])(
      "%s marks only the exact selected period (%s), never an ancestor",
      async (query, selected) => {
        freeze();
        const res = await boardPeriodHarness(kit).request(twin, `${PATH}${query}`);
        const links = periodLinks(res.html);
        const active = links.filter((link) => currentMark(link.attrs));
        expect(active.map((link) => link.name)).toEqual(selected === null ? [] : [selected]);
        // aria-current belongs to the matching link, not the entire picker.
        for (const link of links) expect(link.attrs).not.toMatch(/aria-selected|aria-pressed/);
      },
    );

    it.each(["2024", "2024-02", "2024-Q3", "0000", "0099-Q4", "9999-12"])(
      "keeps historical season %s editable and accepted",
      async (season) => {
        freeze();
        const h = boardPeriodHarness(kit);
        const res = await h.request(twin, `${PATH}?season=${season}&scope=relative&activity=d%26d`);
        expect(res.status).toBe(200);
        const input = seasonInput(res.html);
        expect(input.value).toBe(season); // Quarter syntax is uppercase Q, not a case-folded comparison.
        expect(input.attrs).not.toMatch(/\bdisabled\b|\breadonly\b/);
        expect(res.html).toMatch(/<form\b[^>]*method="get"[^>]*action="\/leaderboards\/members"/);
        expect(res.html).toMatch(/<label\b[^>]*for="board-season"/);
        expect(res.html).toContain('name="scope" value="relative"');
      },
    );

    it.each([
      "",
      "this-month",
      "2032-00",
      "2032-13",
      "2032-Q0",
      "2032-Q5",
      "2032-q2",
      "2032-4",
      "<script>alert(1)</script>",
    ])("still refuses season=%j before reads or logs", async (season) => {
      freeze();
      const h = boardPeriodHarness(kit);
      const res = await h.request(twin, `${PATH}?season=${encodeURIComponent(season)}`);
      expect(res.status).toBe(400);
      expect(h.statements).toEqual([]);
      expect(h.audits).toEqual([]);
      expect(
        res.headers
          .get("cache-control")
          ?.split(/\s*,\s*/)
          .sort(),
      ).toEqual(["no-store", "private"]);
      expect(res.html).not.toContain("Fixture other member");
      expect(res.html).not.toContain("<script>alert(1)</script>");
    });

    it.each(["overall", "relative"] as const)(
      "keeps %s ranking reads, audited release, viewer mark and row privacy unchanged",
      async (scope) => {
        freeze();
        const h = boardPeriodHarness(kit);
        const res = await h.request(twin, `${PATH}?season=2024-Q3&scope=${scope}&activity=d%26d`);
        expect(res.status).toBe(200);
        const reads = h.statements.filter((s) => /from rsvps/i.test(s.sql));
        expect(reads).toHaveLength(scope === "relative" ? 2 : 1);
        for (const read of reads) {
          expect(read.params).toContain("2024-07-01T00:00:00.000Z");
          expect(read.params).toContain("2024-10-01T00:00:00.000Z");
          expect(read.params).toContain("d&d");
        }
        const body = res.html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
        expect(body).toBeDefined();
        expect(body).toMatch(/<tr\b[^>]*aria-current="true"[^>]*>[\s\S]*?Fixture viewer/);
        expect(body).toContain("Fixture other member");
        expect(body).not.toMatch(/<a\b|10000000000000020[12]|userId|user_id|\/members\//);
        if (twin === "Hono") {
          expect(
            h.statements.filter((s) => s.sql.includes('insert into "member_data_access_logs"')),
          ).toHaveLength(1);
        } else {
          expect(h.audits).toHaveLength(1);
          expect(JSON.stringify(res.data)).not.toMatch(/10000000000000020[12]|userId|user_id/);
        }
        expect(
          h.statements.filter((s) => s.sql.includes('insert into "board_view_logs"')),
        ).toHaveLength(1);
      },
    );

    it("does not release rows or write a board view when the access audit refuses", async () => {
      freeze();
      const h = boardPeriodHarness(kit, { failAudit: true });
      const res = await h.request(twin, `${PATH}?season=2032-04`);
      expect(res.status).toBe(503);
      expect(res.html).not.toContain("Fixture other member");
      expect(h.statements.some((s) => s.sql.includes('insert into "board_view_logs"'))).toBe(false);
    });

    it.each(["guest", "outsider"] as const)(
      "keeps the %s gate ahead of invalid-season parsing",
      async (actor) => {
        freeze();
        const h = boardPeriodHarness(kit);
        const res = await h.request(twin, `${PATH}?season=bogus`, actor);
        expect(res.status).toBe(actor === "guest" ? 302 : 403);
        expect(h.statements).toEqual([]);
        expect(h.audits).toEqual([]);
      },
    );

    it.each(["empty", "unavailable"] as const)(
      "still offers period recovery links on the %s board",
      async (state) => {
        freeze();
        const res = await boardPeriodHarness(kit, { state }).request(
          twin,
          `${PATH}?scope=relative&activity=d%26d`,
        );
        expect(res.status).toBe(200);
        expect(res.html).toMatch(/role="status"/);
        const links = periodLinks(res.html);
        expectDestination(links[0].href, "2032-04", "relative", "d&d");
        expectDestination(links[1].href, "2032-Q2", "relative", "d&d");
        expectDestination(links[2].href, "all", "relative", "d&d");
      },
    );
  });
}
