// route-inventory: GET /admin/activity-log
// Acceptance-owned: both real renderers and the real Kit layout/load binding.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityWindowHarness,
  compileActivityWindowKit,
  WINDOW_NOW,
  windowRows,
} from "./helpers/activity-log-window";

let kit: Awaited<ReturnType<typeof compileActivityWindowKit>>;
beforeAll(async () => {
  kit = await compileActivityWindowKit();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const WINDOWS = [
  { when: "all", label: "All recorded time", cutoff: null },
  { when: "24h", label: "Last 24 hours", cutoff: "2026-10-31T07:30:00.000Z" },
  { when: "7d", label: "Last 7 days", cutoff: "2026-10-25T07:30:00.000Z" },
  { when: "30d", label: "Last 30 days", cutoff: "2026-10-02T07:30:00.000Z" },
] as const;
const decode = (text: string) => text.replaceAll("&amp;", "&");
const textOf = (text: string) => text.replace(/<!--[\s\S]*?-->|<[^>]*>/g, "").trim();

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} activity window acceptance`, () => {
    it.each(WINDOWS)(
      "renders a native When select and the effective $when selection",
      async ({ when, label }) => {
        const fixture = activityWindowHarness(kit);
        const reply = await fixture.request(
          twin,
          `/admin/activity-log?when=${when}&subject=Event&causer=100&page=2`,
        );
        expect(reply.status).toBe(200);
        expect(reply.headers.get("cache-control")).toBe("private, no-store");
        const form = reply.html.match(/<form\b[^>]*>[\s\S]*?<\/form>/)![0];
        expect(form).toMatch(/method=["']get["']/i);
        expect(form).toContain('action="/admin/activity-log"');
        const selects = [...form.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)];
        expect(selects).toHaveLength(1);
        expect(selects[0]![1]).toMatch(/\bname=["']when["']/);
        const id = selects[0]![1]!.match(/\bid=["']([^"']+)["']/)![1]!;
        expect(form).toContain(`for="${id}"`);
        expect(form).toMatch(/<label\b[^>]*>\s*When\s*<\/label>/);
        const options = [...selects[0]![2]!.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)];
        expect(options.map((o) => textOf(o[2]!))).toEqual(WINDOWS.map((w) => w.label));
        const selected = options.filter((o) => /\bselected(?:\s|=|$)/.test(o[1]!));
        expect(selected.length).toBeLessThanOrEqual(1);
        // An omitted selected attribute means the first option in native HTML.
        expect(textOf((selected[0] ?? options[0])![2]!)).toBe(label);
        expect(form).not.toMatch(/type=["'](?:date|datetime-local|time)["']/);
        // Native GET form carries only effective filters, not a stale paging token.
        expect(form).not.toMatch(/name=["']page["'][^>]*value=["']2["']/);
      },
    );

    it.each(WINDOWS.filter((w) => w.cutoff !== null))(
      "forwards $when from the URL into one bound SQL cutoff",
      async ({ when, cutoff }) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(WINDOW_NOW));
        const fixture = activityWindowHarness(kit);
        const reply = await fixture.request(twin, `/admin/activity-log?when=${when}`);
        expect(reply.status).toBe(200);
        const reads = fixture.statements.filter((s) => s.sql.includes('from "activity_log"'));
        expect(reads).toHaveLength(1);
        expect(reads[0]!.sql).toMatch(/"created_at"\s*>=\s*\$/);
        expect(
          reads[0]!.params.filter(
            (p) => typeof p === "string" && Date.parse(p) === Date.parse(cutoff!),
          ),
        ).toHaveLength(1);
        if (twin === "Kit") expect(reply.data).toMatchObject({ query: { when } });
      },
    );

    it("preserves all three effective filters in BOTH paging directions", async () => {
      const fixture = activityWindowHarness(kit, { rows: windowRows(103) });
      const reply = await fixture.request(
        twin,
        "/admin/activity-log?when=7d&subject=A%26B&causer=100&page=2",
      );
      expect(reply.status).toBe(200);
      for (const [rel, page] of [
        ["prev", "1"],
        ["next", "3"],
      ]) {
        const anchor = [...reply.html.matchAll(/<a\b([^>]*)>/g)].find((a) =>
          a[1]!.includes(`rel="${rel}"`),
        )!;
        expect(anchor).toBeDefined();
        const href = anchor[1]!.match(/href="([^"]*)"/)![1]!;
        const url = new URL(decode(href), "https://example.test");
        expect(Object.fromEntries(url.searchParams)).toEqual({
          when: "7d",
          subject: "A&B",
          causer: "100",
          page,
        });
      }
    });

    it.each(["24h", "7d", "30d"])(
      "renders effective filtered empty copy for %s-only results",
      async (when) => {
        const fixture = activityWindowHarness(kit, { rows: [] });
        const reply = await fixture.request(twin, `/admin/activity-log?when=${when}`);
        expect(reply.status).toBe(200);
        expect(reply.html).toContain("No activity matches these filters.");
        expect(reply.html).not.toContain("No activity yet.");
        expect(fixture.audits).toHaveLength(0);
      },
    );

    it("normalizes unknown input to a visibly selected all-time scope without reflecting it", async () => {
      const fixture = activityWindowHarness(kit, { rows: [] });
      const reply = await fixture.request(twin, "/admin/activity-log?when=unrecognized-window");
      expect(reply.status).toBe(200);
      const options = [...reply.html.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)];
      expect(options).toHaveLength(4);
      const selected = options.filter((o) => /\bselected(?:\s|=|$)/.test(o[1]!));
      expect(selected.length).toBeLessThanOrEqual(1);
      expect(textOf((selected[0] ?? options[0])![2]!)).toBe("All recorded time");
      expect(reply.html).toContain("No activity yet.");
      expect(reply.html).not.toContain("unrecognized-window");
      const sql = fixture.statements.find((s) => s.sql.includes('from "activity_log"'))!.sql;
      expect(sql).not.toMatch(/"created_at"\s*>=/);
    });

    it("CONTROL: audits every returned snowflake, including the invisible 51st lookahead", async () => {
      const fixture = activityWindowHarness(kit);
      const reply = await fixture.request(twin, "/admin/activity-log?when=7d");
      expect(reply.status).toBe(200);
      expect(reply.html).toContain("Recorded fixture change 51");
      expect(reply.html).not.toContain("Recorded fixture change 1</td>");
      expect(reply.html).not.toContain("100000000000001050");
      expect(fixture.audits).toEqual([
        {
          subjectUserIds: windowRows()
            .map((r) => r.causer_id)
            .sort(),
          resource: "activity_log",
          route: "admin.activity-log.index",
          viewerDiscordId: "100000000000000103",
        },
      ]);
      expect(fixture.statements.filter((s) => s.sql.includes('from "activity_log"'))).toHaveLength(
        1,
      );
      expect(reply.html).not.toMatch(/\bproperties\b|\bsubject_user_ids\b/);
    });

    it("CONTROL: null, legacy and viewer causers do not become invented audit subjects", async () => {
      const rows = windowRows(4);
      rows[0]!.causer_id = null;
      rows[1]!.causer_id = "42";
      rows[2]!.causer_id = "100000000000000103";
      const fixture = activityWindowHarness(kit, { rows });
      const reply = await fixture.request(twin, "/admin/activity-log?when=7d");
      expect(reply.status).toBe(200);
      expect(reply.html).toContain("42 (legacy ID)");
      expect(fixture.audits).toHaveLength(1);
      expect(fixture.audits[0]!.subjectUserIds).toEqual(["100000000000001003"]);
    });

    it("NEGATIVE CONTROL: failed access audit refuses contents and does not diagnose row data", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const fixture = activityWindowHarness(kit, { failAudit: true });
      const reply = await fixture.request(twin, "/admin/activity-log?when=24h");
      expect(reply.status).toBe(503);
      expect(reply.headers.get("cache-control")).toBe("private, no-store");
      const output = reply.html + JSON.stringify(errors.mock.calls);
      expect(output).not.toContain("Recorded fixture change");
      expect(output).not.toContain("100000000000001000");
      expect(output).not.toContain("fixture-51");
      expect(output).not.toContain("properties");
      expect(fixture.audits).toHaveLength(0);
      expect(fixture.statements.filter((s) => s.sql.includes('from "activity_log"'))).toHaveLength(
        1,
      );
      expect(
        fixture.statements.filter((s) => s.sql.includes('insert into "member_data_access_logs"')),
      ).toHaveLength(1);
    });

    it.each(["guest", "member"] as const)(
      "CONTROL: denies %s before reading any activity even with a window",
      async (actor) => {
        const fixture = activityWindowHarness(kit);
        const reply = await fixture.request(twin, "/admin/activity-log?when=30d", actor);
        expect(reply.status).toBe(actor === "guest" ? 302 : 403);
        expect(fixture.statements).toHaveLength(0);
        expect(fixture.audits).toHaveLength(0);
        expect(reply.html).not.toContain("Recorded fixture change");
      },
    );

    it("CONTROL: unavailable DB returns a private refusal, not an empty success", async () => {
      const fixture = activityWindowHarness(kit, { unavailable: true });
      const reply = await fixture.request(twin, "/admin/activity-log?when=7d");
      expect(reply.status).toBe(503);
      expect(reply.headers.get("cache-control")).toBe("private, no-store");
      expect(reply.html).not.toContain("No activity yet.");
      expect(fixture.statements).toHaveLength(0);
    });
  });
}
