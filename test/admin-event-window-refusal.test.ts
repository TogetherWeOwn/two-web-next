import { beforeAll, describe, expect, it } from "vitest";
import {
  eventListParams,
  parseEventListQuery,
  parseEventStartsWindow,
} from "../src/admin/event-list";
import { EventsPage } from "../src/admin/pages/events-list";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db";
import { compilePlanningWindowKit } from "./helpers/admin-event-planning-window";

it("keeps an independently valid singleton when the other date is duplicated", () => {
  expect(parseEventStartsWindow(["2032-02-28", "2032-02-29"], "2032-03-02")).toMatchObject({
    before: "2032-03-02",
    error: expect.stringContaining("only once"),
  });
  expect(parseEventStartsWindow("2032-02-29", ["2032-03-01", "2032-03-02"])).toMatchObject({
    from: "2032-02-29",
    error: expect.stringContaining("only once"),
  });
});

const refusals = [
  "starts_from=nope&starts_before=2032-03-02",
  "starts_from=2032-02-28&starts_from=2032-02-29&starts_before=2032-03-02",
  "starts_from=2032-02-29&starts_before=2032-03-02&starts_before=2032-03-03",
  "starts_from=2032-03-02&starts_before=2032-02-29",
  "starts_from=2032-03-02&starts_before=2032-03-02",
];

// Refused windows must return before touching any database method.
const env = {
  APP_URL: "https://fixture.example.test",
  ADMIN_DB: new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "then") return undefined;
        throw new Error("Unexpected database work for refused window");
      },
    },
  ) as Db,
} as EnvWithAdminDb;

describe("refused UTC window navigation", () => {
  let kit: Awaited<ReturnType<typeof compilePlanningWindowKit>>;
  beforeAll(async () => {
    kit = await compilePlanningWindowKit();
  });

  for (const renderer of ["Hono", "Kit"] as const) {
    it.each(refusals)(
      `${renderer} offers explicit correction/clear, never an unfiltered sort or pager: %s`,
      async (raw) => {
        const search = new URLSearchParams(`${raw}&page=3`);
        const query = parseEventListQuery(eventListParams(search));
        let html: string;
        if (renderer === "Hono") {
          html = String(EventsPage({ query, rows: [], hasNext: false }));
        } else {
          const response = await kit.request({ env, path: `/admin/events?${search}` });
          expect(response.status).toBe(200);
          html = await response.text();
        }
        expect(html).toContain('role="alert"');
        expect(html).toContain("Clear filters</a>");
        expect(html).not.toContain('aria-label="Sort by');
        expect(html).not.toContain('rel="prev"');
        expect(html).not.toContain('rel="next"');
        expect(html).not.toContain("First page of these results</a>");
      },
    );
  }
});
