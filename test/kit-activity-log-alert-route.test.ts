// Implementation-owned pin: a code bug inside the Kit activity-log load
// emits its error.alert diagnostic naming THIS route (GET
// /admin/activity-log). The acceptance suite
// (test/kit-activity-log.test.ts) pins the alert count, event and level,
// but not which route emitted the line, so a copy-pasted or drifted route
// string would pass there. This file pins the emitter: change the route
// in reportLoadFailure and this fails while the acceptance suite stays
// green.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { loadActivityLogPage } from "../src/admin/kit-activity-log";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

const env = { APP_URL: "https://example.test" } as unknown as Env;
const db = {} as unknown as Db;

describe("activity-log alert route pin (implementation-owned)", () => {
  beforeEach(() => {
    __resetAlertRateLimitForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("names GET /admin/activity-log on the code-bug error.alert line", async () => {
    const setHeaders = vi.fn() as unknown as (headers: Record<string, string>) => void;
    await expect(
      loadActivityLogPage({
        env,
        subjectParam: null,
        causerParam: null,
        pageParam: null,
        setHeaders,
        dbForFn: async () => db,
        listFn: async () => {
          throw new TypeError("probe: cannot read properties of undefined");
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    const lines = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.includes('"error.alert"'));
    expect(lines, "expected exactly one error.alert diagnostic").toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as {
      event?: unknown;
      level?: unknown;
      method?: unknown;
      route?: unknown;
    };
    expect(parsed.event).toBe("error.alert");
    expect(parsed.level).toBe("critical");
    expect(parsed.method).toBe("GET");
    expect(parsed.route).toBe("/admin/activity-log");
  });
});
