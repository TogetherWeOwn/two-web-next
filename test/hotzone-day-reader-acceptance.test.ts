// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// Acceptance-owned test-first handoff: consume unchanged with implementation.
// HZD_* case IDs and assertion causes survive the existing Vitest JSON reporter.
// Canonical: TZ=America/Los_Angeles npx vitest run test/hotzone-day-reader-acceptance.test.ts --reporter=json --outputFile=/tmp/hotzone-day-reader.json
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePeriodKit, type PeriodKit } from "./helpers/hotzone-period-picker";
import {
  attr,
  dayRows,
  days,
  elements,
  formUrl,
  getForm,
  link,
  main,
  renderDayRequest,
  tables,
  words,
} from "./helpers/hotzone-day-reader";

let kit: PeriodKit;
beforeAll(async () => {
  kit = await compilePeriodKit();
});
afterAll(() => kit?.dispose());
const total = dayRows.flat().reduce((sum, value) => sum + value, 0);
const season = "2026-Q1";
const signals = ["joins", "voice", "games"] as const;

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} weekday reader`, () => {
    // Kills wrong weekday indexing, transposition, sorting by count, truncation,
    // filtering zero cells, and changing the aggregate instead of projecting it.
    it.each(days.map((day, index) => ({ ...day, index })))(
      "HZD_01_$token: projects all 24 source cells for $name, including zero",
      async ({ token, name, index }) => {
        const result = await renderDayRequest(
          twin,
          `/hotzones/joins?season=${season}&day=${token}`,
          kit,
        );
        expect(result.status).toBe(200);
        const node = main(result.html);
        const reader = tables(node).find((table) => table.headings.length === 2);
        expect(
          reader,
          "HZD_PROJECTION: implement the native two-column weekday reader",
        ).toBeDefined();
        expect(reader!.headings[0]).toMatch(/hour.*UTC/i);
        expect(reader!.headings[1]).toMatch(/^count$/i);
        expect(reader!.caption).toMatch(new RegExp(name, "i"));
        expect(reader!.rows).toHaveLength(24);
        expect(reader!.rows.map((row) => row[0])).toEqual(
          Array.from({ length: 24 }, (_, hour) =>
            expect.stringMatching(
              new RegExp(`^${String(hour).padStart(2, "0")}(?::00)?(?: UTC)?$`),
            ),
          ),
        );
        expect(reader!.rows.map((row) => row[1])).toEqual(dayRows[index]!.map(String));
        expect(reader!.rows.every((row) => row.length === 2)).toBe(true);
        expect(tables(node).filter((table) => table.headings.length === 25)).toHaveLength(0);
        expect(words(node)).toContain(`${total} joins`);
        expect(words(node)).toContain("17 scheduled gatherings");
      },
    );

    // Default contract is preserved even when the new selector is malformed.
    it.each([
      "",
      "&day=",
      "&day=SUN",
      "&day=Sunday",
      "&day=0",
      "&day=-1",
      "&day=7",
      "&day=sun%20",
      "&day=__proto__",
      "&day=%3Cscript%3E",
      "&day=sun&day=sat",
      "&day=sun&day=sun",
      "&day=bad&day=sun",
      "&day=sun&day=bad",
    ])(
      "HZD_02_%s: absent/invalid/repeated day falls back to full week without extra work",
      async (query) => {
        const result = await renderDayRequest(
          twin,
          `/hotzones/joins?season=${season}${query}`,
          kit,
        );
        expect(result.status).toBe(200);
        const full = tables(main(result.html)).find((table) => table.headings.length === 25);
        expect(
          full,
          "HZD_FALLBACK: invalid selectors must retain the full-week board",
        ).toBeDefined();
        expect(full!.headings.slice(1)).toEqual(
          Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")),
        );
        expect(full!.rows).toEqual(dayRows.map((row, i) => [days[i]!.name, ...row.map(String)]));
        expect(
          tables(main(result.html)).filter((table) => table.headings.length === 2),
        ).toHaveLength(0);
        expect(result.hits).toEqual(["events-read:192.0.2.17"]);
        expect(
          result.statements.filter((s) => s.sql.includes('from "join_attempts"')),
        ).toHaveLength(1);
        expect(result.statements.filter((s) => s.sql.includes('from "events"'))).toHaveLength(1);
        expect(result.inserts).toHaveLength(1);
        expect(result.headers.get("cache-control")).toBe("public, max-age=300");
        expect(result.headers.get("vary")).toBe("Cookie");
      },
    );

    it.each(signals)(
      "HZD_03_%s: native weekday selection preserves signal and committed season",
      async (signal) => {
        const path = `/hotzones/${signal}`;
        const result = await renderDayRequest(twin, `${path}?season=${season}&day=sat`, kit);
        const node = main(result.html);
        const select = elements(node, "select").find((el) => attr(el, "name") === "day");
        expect(
          select,
          "HZD_CONTROL: provide a labelled native weekday select with a GET submit",
        ).toBeDefined();
        const id = attr(select!, "id");
        expect(id).not.toBe("");
        const label = elements(node, "label").find((el) => attr(el, "for") === id);
        expect(label && words(label)).toMatch(/day/i);
        const options = elements(select!, "option");
        for (const day of days) {
          const option = options.find((el) => attr(el, "value") === day.token);
          expect(option && words(option)).toMatch(new RegExp(day.name, "i"));
        }
        expect(
          options
            .filter((el) => el.attrs.some((a) => a.name === "selected"))
            .map((el) => attr(el, "value")),
        ).toEqual(["sat"]);
        const form = getForm(node, "day");
        expect((attr(form, "method") || "get").toLowerCase()).toBe("get");
        expect(
          elements(form, "button").length +
            elements(form, "input").filter((el) => attr(el, "type") === "submit").length,
        ).toBeGreaterThan(0);
        const url = formUrl(form, { day: "sun" }, path);
        expect(url.pathname).toBe(path);
        expect([...url.searchParams.entries()].sort()).toEqual([
          ["day", "sun"],
          ["season", season],
        ]);
        const changed = await renderDayRequest(twin, `${url.pathname}${url.search}`, kit);
        expect(changed.status).toBe(200);
        expect(
          tables(main(changed.html)).find((table) => table.headings.length === 2)?.caption,
        ).toMatch(/Sunday/i);
        const full = link(node, /^(?:return to |back to |show |view )?(?:the )?full week$/i);
        expect(full.pathname).toBe(path);
        expect([...full.searchParams.entries()]).toEqual([["season", season]]);
        expect(
          tables(
            main((await renderDayRequest(twin, `${full.pathname}${full.search}`, kit)).html),
          ).some((table) => table.headings.length === 25),
        ).toBe(true);
        for (const target of signals) {
          const cross = link(node, new RegExp(`^${target}$`, "i"));
          expect(cross.pathname).toBe(`/hotzones/${target}`);
          expect(cross.searchParams.get("season")).toBe(season);
          expect(cross.searchParams.get("day")).toBe("sat");
        }
      },
    );

    it.each(signals)(
      "HZD_04_%s: period apply, shortcuts and reset keep the chosen weekday",
      async (signal) => {
        const path = `/hotzones/${signal}`;
        const node = main(
          (await renderDayRequest(twin, `${path}?season=${season}&day=sun`, kit)).html,
        );
        const form = getForm(node, "season");
        const applied = formUrl(form, { season: "2026-02" }, path);
        expect(applied.pathname).toBe(path);
        expect([...applied.searchParams.entries()].sort()).toEqual([
          ["day", "sun"],
          ["season", "2026-02"],
        ]);
        for (const [label, value] of [
          [/^This month$/, "2026-04"],
          [/^This quarter$/, "2026-Q2"],
          [/^All available data$/, null],
        ] as const) {
          const url = link(node, label);
          expect(url.pathname).toBe(path);
          expect(url.searchParams.getAll("day")).toEqual(["sun"]);
          expect(url.searchParams.get("season")).toBe(value);
          expect(
            tables(
              main((await renderDayRequest(twin, `${url.pathname}${url.search}`, kit)).html),
            ).find((table) => table.headings.length === 2)?.caption,
          ).toMatch(/Sunday/i);
        }
      },
    );

    it("HZD_05: empty selected day retains all 24 zero hours and honest retention", async () => {
      const result = await renderDayRequest(twin, "/hotzones/joins?season=2025-01&day=sun", kit, {
        fixture: "empty",
      });
      expect(result.status).toBe(200);
      const node = main(result.html);
      const reader = tables(node).find((table) => table.headings.length === 2);
      expect(reader, "HZD_EMPTY: empty day must remain readable, not disappear").toBeDefined();
      expect(reader!.rows.map((row) => row[1])).toEqual(Array(24).fill("0"));
      expect(words(node)).toMatch(/90 days.*0 joins.*scheduled gatherings/i);
      expect(words(node)).toMatch(/successful joins only/i);
    });

    it.each(["voice", "games"] as const)(
      "HZD_06_%s: projects seeded source cells without claiming season-specific attendance",
      async (signal) => {
        const full = await renderDayRequest(twin, `/hotzones/${signal}?season=${season}`, kit);
        const source = tables(main(full.html)).find((table) => table.headings.length === 25)!;
        for (const [token, index] of [
          ["sun", 0],
          ["sat", 6],
        ] as const) {
          const result = await renderDayRequest(
            twin,
            `/hotzones/${signal}?season=${season}&day=${token}`,
            kit,
          );
          const node = main(result.html);
          const reader = tables(node).find((table) => table.headings.length === 2);
          expect(reader, "HZD_ESTIMATE: the seeded signals need the same day reader").toBeDefined();
          expect(reader!.rows.map((row) => row[1])).toEqual(source.rows[index]!.slice(1));
          expect(reader!.caption).toMatch(/estimat/i);
          expect(words(node)).toMatch(/season.independent seeded estimates/i);
          expect(words(node)).toMatch(/until.*calibration/i);
          expect(words(node)).toMatch(/total estimate/i);
          expect(
            result.statements.filter(
              (s) => s.sql.includes('from "join_attempts"') || s.sql.includes('from "events"'),
            ),
          ).toHaveLength(0);
        }
      },
    );

    // Controls are separate cases so meaningful existing green behavior is
    // recorded even when day-reader assertions are intentionally RED.
    it.each(signals)(
      "HZD_C01_%s: selected-day URL keeps query/audit/privacy/cache boundaries",
      async (signal) => {
        const result = await renderDayRequest(
          twin,
          `/hotzones/${signal}?season=${season}&day=sun`,
          kit,
        );
        expect(result.status).toBe(200);
        expect(result.dbTouches).toBe(1);
        expect(result.hits).toEqual(["events-read:192.0.2.17"]);
        const reads = result.statements.filter(
          (s) => s.sql.startsWith("select") && !s.sql.startsWith("select set_config("),
        );
        expect(reads).toHaveLength(signal === "joins" ? 2 : 0);
        expect(result.inserts).toHaveLength(1);
        expect(result.inserts[0]).toContain(`hotzones/${signal}`);
        expect(result.inserts[0]).toContain("overall");
        expect(result.inserts[0]).toContain(season);
        if (signal === "joins") {
          expect(result.inserts[0]).toContain(total);
          const query = reads.find((s) => s.sql.includes('from "join_attempts"'))!;
          // Emitted SQL (not source regex): the new mode must not remove the
          // existing aggregate-only/opt-out/outcome/window query contract.
          expect(query.sql).toContain('left join "profiles"');
          expect(query.sql).toContain('"leaderboard_opt_out"');
          expect(query.sql).toMatch(/group by/i);
          expect(query.sql).not.toMatch(/select\s+\*/i);
          expect(query.params).toContain("added");
          expect(query.params).toContain("already_member");
          expect(query.params).toContain(false);
          expect(query.params).toContain("2026-01-01T00:00:00.000Z");
          expect(query.params).toContain("2026-04-01T00:00:00.000Z");
        }
        expect(result.headers.get("cache-control")).toBe("public, max-age=300");
        expect(result.headers.get("vary")).toBe("Cookie");
        expect(words(main(result.html))).not.toMatch(/discord_id|created_at|192\.0\.2\.17/);
        expect(elements(main(result.html), "script")).toHaveLength(0);
      },
    );

    it.each(["day=sun", "day=sun&day=sat", "day=%3Cscript%3E"])(
      "HZD_C02_%s: invalid season still refuses before admission/DB/audit",
      async (query) => {
        const result = await renderDayRequest(twin, `/hotzones/joins?season=invalid&${query}`, kit);
        expect(result.status).toBe(400);
        expect(result.headers.get("cache-control")).toMatch(/no-store/);
        expect(result.dbTouches).toBe(0);
        expect(result.hits).toEqual([]);
        expect(result.statements).toEqual([]);
      },
    );

    it.each(["sun", "bogus", "sun&day=sat"])(
      "HZD_C03_%s: exhausted admission runs no aggregate/audit work",
      async (value) => {
        const result = await renderDayRequest(
          twin,
          `/hotzones/joins?season=${season}&day=${value}`,
          kit,
          { denied: true },
        );
        expect(result.status).toBe(429);
        expect(result.headers.get("retry-after")).toBe("60");
        expect(result.headers.get("cache-control")).toMatch(/no-store/);
        expect(result.dbTouches).toBe(0);
        expect(result.hits).toEqual([]);
        expect(result.statements).toEqual([]);
      },
    );

    it("HZD_C04: index remains full-week; day input does not redesign the index", async () => {
      const result = await renderDayRequest(twin, `/hotzones?season=${season}&day=sun`, kit);
      expect(result.status).toBe(200);
      expect(
        tables(main(result.html)).filter((table) => table.headings.length === 25),
      ).toHaveLength(3);
      expect(
        elements(main(result.html), "select").filter((el) => attr(el, "name") === "day"),
      ).toHaveLength(0);
    });

    it("HZD_C05: anonymous board logging stays fail-open on a day URL", async () => {
      const result = await renderDayRequest(twin, `/hotzones/joins?season=${season}&day=sun`, kit, {
        auditFails: true,
      });
      expect(result.status).toBe(200);
      expect(result.inserts).toHaveLength(1);
      expect(result.statements.filter((s) => s.sql.includes('from "join_attempts"'))).toHaveLength(
        1,
      );
    });
  });
}
