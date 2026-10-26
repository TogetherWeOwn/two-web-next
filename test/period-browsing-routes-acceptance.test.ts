// route-inventory: GET /leaderboards/members
// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compilePeriodKit,
  periodControl,
  renderPeriodRequest,
  type PeriodKit,
} from "./helpers/hotzone-period-picker";
import {
  boardPeriodHarness,
  compileBoardPeriodKit,
  namedLink,
  periodLinks,
  seasonInput,
  type BoardPeriodKit,
} from "./helpers/member-board-period-shortcuts";
import {
  attr,
  elements,
  hotzoneBrowsingHarness,
  nativeNeighbors,
  neighbor,
  text,
} from "./helpers/period-browsing";

const ORIGIN = "https://period.example.test";
const BOARD = "/leaderboards/members";
const PATHS = ["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"] as const;
const MATRIX = [
  ["2026", "2025", "2027"],
  ["2026-01", "2025-12", "2026-02"],
  ["2025-12", "2025-11", "2026-01"],
  ["2026-Q1", "2025-Q4", "2026-Q2"],
  ["2025-Q4", "2025-Q3", "2026-Q1"],
  ["0000", null, "0001"],
  ["9999", "9998", null],
  ["0000-01", null, "0000-02"],
  ["9999-12", "9999-11", null],
  ["0000-Q1", null, "0000-Q2"],
  ["9999-Q4", "9999-Q3", null],
  ["all", null, null],
] as const;
let boardKit: BoardPeriodKit;
let hotzoneKit: PeriodKit;
beforeAll(async () => {
  boardKit = await compileBoardPeriodKit();
  hotzoneKit = await compilePeriodKit();
});
afterAll(() => hotzoneKit?.dispose());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2032-01-01T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

function destination(
  href: string,
  path: string,
  season: string,
  scope?: string,
  activity?: string | null,
) {
  const url = new URL(href, ORIGIN);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe(path);
  expect(url.hash).toBe("");
  expect(url.searchParams.get("season") ?? "all").toBe(season);
  const keys = [...url.searchParams.keys()];
  expect(new Set(keys).size).toBe(keys.length);
  if (scope !== undefined) {
    expect(url.searchParams.get("scope") ?? "overall").toBe(scope);
    expect(url.searchParams.get("activity")).toBe(activity);
    expect(keys.every((key) => ["season", "scope", "activity"].includes(key))).toBe(true);
  } else expect(keys.every((key) => key === "season")).toBe(true);
}
function assertNeighbors(
  html: string,
  path: string,
  previous: string | null,
  next: string | null,
  scope?: string,
  activity?: string | null,
) {
  expect(
    nativeNeighbors(html),
    "PB_NAV_MISSING_OR_OUT_OF_GRAMMAR: render exactly the valid neighbors",
  ).toHaveLength(Number(previous !== null) + Number(next !== null));
  if (previous !== null)
    destination(neighbor(html, "Previous", previous).href, path, previous, scope, activity);
  if (next !== null) destination(neighbor(html, "Next", next).href, path, next, scope, activity);
}
function noStore(headers: Headers) {
  expect(
    headers
      .get("cache-control")
      ?.split(/\s*,\s*/)
      .sort(),
  ).toEqual(["no-store", "private"]);
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} period browsing`, () => {
    it.each(MATRIX)(
      "PB-B01 board %s emits only grammar-valid, named neighbors",
      async (season, previous, next) => {
        const h = boardPeriodHarness(boardKit);
        const result = await h.request(
          twin,
          `${BOARD}?${new URLSearchParams({ season, scope: "relative", activity: "d&d / co-op", redirect: "https://untrusted.example" })}`,
        );
        expect(result.status).toBe(200);
        expect(seasonInput(result.html).value).toBe(season);
        assertNeighbors(result.html, BOARD, previous, next, "relative", "d&d / co-op");
      },
    );

    for (const scope of ["overall", "relative"] as const) {
      it.each([null, "d&d / co-op"])(
        `PB-B02 follows adjacent ${scope} board links with game %j and unchanged read budget`,
        async (activity) => {
          const query = new URLSearchParams({ season: "2026-Q1", scope });
          if (activity !== null) query.set("activity", activity);
          const first = await boardPeriodHarness(boardKit).request(twin, `${BOARD}?${query}`);
          for (const [direction, selected, start, end] of [
            ["Previous", "2025-Q4", "2025-10-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
            ["Next", "2026-Q2", "2026-04-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
          ] as const) {
            const link = neighbor(first.html, direction, selected);
            destination(link.href, BOARD, selected, scope, activity);
            const h = boardPeriodHarness(boardKit);
            const result = await h.request(twin, link.href);
            expect(result.status).toBe(200);
            expect(seasonInput(result.html).value).toBe(selected);
            noStore(result.headers);
            const reads = h.statements.filter((s) => /from rsvps/i.test(s.sql));
            expect(reads).toHaveLength(scope === "relative" ? 2 : 1);
            for (const read of reads) {
              expect(read.params).toContain(start);
              expect(read.params).toContain(end);
              if (activity !== null) expect(read.params).toContain(activity);
              expect(read.sql).toMatch(/leaderboard_opt_out/);
            }
            expect(
              h.statements.filter((s) => /^\s*select\b/i.test(s.sql) && /\bfrom\b/i.test(s.sql)),
            ).toHaveLength(reads.length);
            expect(
              h.statements.filter((s) => s.sql.includes('insert into "board_view_logs"')),
            ).toHaveLength(1);
            if (twin === "Hono")
              expect(
                h.statements.filter((s) => s.sql.includes('insert into "member_data_access_logs"')),
              ).toHaveLength(1);
            else expect(h.audits).toHaveLength(1);
            expect(elements(result.html, "tbody").map(text).join(" ")).toContain(
              "Fixture other member",
            );
            expect(elements(result.html, "tbody").map(text).join(" ")).not.toMatch(
              /10000000000000020[12]/,
            );
            expect(
              elements(result.html, "a").some((node) =>
                (attr(node, "href") ?? "").startsWith("/members/"),
              ),
            ).toBe(false);
            expect(
              namedLink(result.html, scope === "relative" ? "Around you" : "Overall").attrs,
            ).toContain("aria-current");
          }
        },
      );
    }

    it("PB-C10 retains UTC shortcuts and free-text editing without adjacent all-time fiction", async () => {
      const result = await boardPeriodHarness(boardKit).request(
        twin,
        `${BOARD}?scope=relative&activity=d%26d`,
      );
      const links = periodLinks(result.html);
      for (const [index, season] of ["2032-01", "2032-Q1", "all"].entries())
        destination(links[index]!.href, BOARD, season, "relative", "d&d");
      expect(nativeNeighbors(result.html)).toEqual([]);
      expect(seasonInput(result.html).attrs).not.toMatch(/\b(?:disabled|readonly)\b/);
      expect(
        elements(result.html, "form").some(
          (form) => attr(form, "method") === "get" && attr(form, "action") === BOARD,
        ),
      ).toBe(true);
    });

    it.each(["10000", "-001", "2026-Q0", "2026-13", "", "2026-q1"])(
      "PB-C11 refuses board season=%j before reads/writes",
      async (season) => {
        const h = boardPeriodHarness(boardKit);
        const result = await h.request(twin, `${BOARD}?${new URLSearchParams({ season })}`);
        expect(result.status).toBe(400);
        expect(h.statements).toEqual([]);
        expect(h.audits).toEqual([]);
        noStore(result.headers);
      },
    );

    it("PB-C12 audit failure still withholds rows and board-view telemetry", async () => {
      const h = boardPeriodHarness(boardKit, { failAudit: true });
      const result = await h.request(twin, `${BOARD}?season=2026-01&scope=relative`);
      expect(result.status).toBe(503);
      expect(result.html).not.toContain("Fixture other member");
      expect(h.statements.some((s) => s.sql.includes('insert into "board_view_logs"'))).toBe(false);
    });

    for (const path of PATHS) {
      it.each(MATRIX)(
        `PB-H01 ${path} %s keeps route/signal and names valid destinations`,
        async (season, previous, next) => {
          const result = await hotzoneBrowsingHarness(hotzoneKit).request(
            twin,
            `${path}?${new URLSearchParams({ season, redirect: "https://untrusted.example" })}`,
          );
          expect(result.status).toBe(200);
          expect(periodControl(result.html).control.value).toBe(season);
          assertNeighbors(result.html, path, previous, next);
        },
      );

      it(`PB-H02 follows ${path} neighbors without comparison/member reads or new writes`, async () => {
        const first = await hotzoneBrowsingHarness(hotzoneKit).request(
          twin,
          `${path}?season=2026-01`,
        );
        for (const [direction, selected, start, end] of [
          ["Previous", "2025-12", "2025-12-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
          ["Next", "2026-02", "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
        ] as const) {
          const link = neighbor(first.html, direction, selected);
          const h = hotzoneBrowsingHarness(hotzoneKit);
          const result = await h.request(twin, link.href);
          expect(result.status).toBe(200);
          expect(periodControl(result.html).control.value).toBe(selected);
          const aggregates = h.statements.filter(
            (s) => /^select\b/i.test(s.sql) && /\bfrom\b/i.test(s.sql),
          );
          expect(aggregates).toHaveLength(path === "/hotzones" || path.endsWith("/joins") ? 2 : 0);
          for (const statement of aggregates) {
            expect(statement.params).toContain(start);
            expect(statement.params).toContain(end);
          }
          expect(h.statements.filter((s) => /^insert\b/i.test(s.sql))).toHaveLength(1);
          expect(h.statements.filter((s) => /^insert\b/i.test(s.sql))[0]!.sql).toContain(
            '"board_view_logs"',
          );
          expect(result.headers.get("cache-control")).toBe("public, max-age=300");
          expect(result.headers.get("vary")).toBe("Cookie");
          const captions = elements(result.html, "caption").map(text);
          if (path.endsWith("/voice") || path.endsWith("/games")) {
            expect(captions[0]).toMatch(/season-independent.*seeded.*estimat/i);
            expect(captions[0]).not.toContain(selected);
          } else {
            expect(captions[0]).toContain(selected);
            expect(elements(result.html, "p").map(text).join(" ")).toMatch(/kept \d+ days/);
          }
          expect(elements(result.html, "table").map(text).join(" ")).not.toMatch(
            /discord_id|created_at|10000000000000020[12]|\d{4}-\d\d-\d\dT/,
          );
        }
      });

      it.each(["10000", "2026-00", "2026-Q5", ""])(
        `PB-C13 ${path} refuses malformed season %j with zero reads/logs`,
        async (season) => {
          const h = hotzoneBrowsingHarness(hotzoneKit);
          const result = await h.request(twin, `${path}?${new URLSearchParams({ season })}`);
          expect(result.status).toBe(400);
          expect(h.statements).toEqual([]);
          noStore(result.headers);
          const poison = await renderPeriodRequest(
            twin,
            `${path}?${new URLSearchParams({ season })}`,
            hotzoneKit,
            new Date("2032-01-01T00:00:00Z"),
          );
          expect(poison.status).toBe(400);
          expect(poison.dbTouches).toBe(0);
        },
      );

      it(`PB-C14 ${path} retains current shortcuts, editable all and signal-independent estimates`, async () => {
        const h = hotzoneBrowsingHarness(hotzoneKit);
        const result = await h.request(twin, path);
        const control = periodControl(result.html);
        expect(control.control).toMatchObject({ value: "all", disabled: false });
        expect(control.form).toMatchObject({ method: "get", action: path });
        for (const label of ["This month", "This quarter", "All available data"]) {
          const node = elements(result.html, "a").find((node) => text(node) === label);
          expect(node).toBeDefined();
          destination(
            attr(node!, "href")!,
            path,
            label === "This month" ? "2032-01" : label === "This quarter" ? "2032-Q1" : "all",
          );
        }
        expect(nativeNeighbors(result.html)).toEqual([]);
        const reads = h.statements.filter(
          (s) => /^select\b/i.test(s.sql) && /\bfrom\b/i.test(s.sql),
        );
        expect(reads).toHaveLength(path === "/hotzones" || path.endsWith("/joins") ? 2 : 0);
        const joins = reads.find((s) => s.sql.includes('from "join_attempts"'));
        if (joins) {
          expect(joins.sql).toMatch(/leaderboard_opt_out/);
          expect(joins.params).toContain("added");
          expect(joins.params).toContain("already_member");
          expect(
            joins.params.some(
              (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value),
            ),
          ).toBe(false);
        }
      });

      it(`PB-C15 ${path} selected-period read/write counts and UTC binds are already bounded`, async () => {
        const h = hotzoneBrowsingHarness(hotzoneKit);
        const result = await h.request(twin, `${path}?season=2025-12`);
        expect(result.status).toBe(200);
        const reads = h.statements.filter(
          (s) => /^select\b/i.test(s.sql) && /\bfrom\b/i.test(s.sql),
        );
        expect(reads).toHaveLength(path === "/hotzones" || path.endsWith("/joins") ? 2 : 0);
        for (const statement of reads) {
          expect(statement.params).toContain("2025-12-01T00:00:00.000Z");
          expect(statement.params).toContain("2026-01-01T00:00:00.000Z");
        }
        const writes = h.statements.filter((s) => /^(?:insert|update|delete)\b/i.test(s.sql));
        expect(writes).toHaveLength(1);
        expect(writes[0]!.sql).toContain('insert into "board_view_logs"');
        expect(writes[0]!.params).toContain("2025-12");
        if (reads.length) {
          const prose = elements(result.html, "p").map(text).join(" ");
          expect(prose).toMatch(/3 joins/);
          expect(prose).toMatch(/2 scheduled gatherings/);
          expect(prose).toMatch(/kept \d+ days/);
        }
      });
    }
  });
}
