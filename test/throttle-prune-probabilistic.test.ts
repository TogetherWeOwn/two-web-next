// The throttle expiry prune runs on a sample of requests, not every one: the
// prune is a second transaction (BEGIN + SET + DELETE + COMMIT) on the hot
// admission path, and every throttled read pays it. A 10% sample still drains
// far more than each request inserts (up to 1,000 rows per prune against one
// insert per admitted request), while 90% of admissions skip the round trips.
//
// Pure unit tests with an in-memory throttle store; Math.random is pinned per
// case so both branches are deterministic.
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkJoinThrottle } from "../src/join/service";
import type { Sql } from "../src/sessions";

function recordingSql(record: { deletes: number }): Sql {
  const tag = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("pg_advisory_xact_lock")) return [];
    if (statement.includes("SELECT count(*)")) return [{ n: 0, wait: 1 }];
    if (statement.includes("INSERT INTO web_throttle_hits")) return [];
    if (statement.includes("DELETE FROM web_throttle_hits")) {
      record.deletes += 1;
      return [];
    }
    throw new Error(`Unexpected throttle statement: ${statement.slice(0, 80)}`);
  }) as unknown as Sql & {
    begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  };
  (tag as { unsafe?: unknown }).unsafe = async () => [];
  tag.begin = (run) => run(tag as unknown as Sql);
  return tag as unknown as Sql;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("throttle prune sampling", () => {
  it("prunes when the sample hits", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.05);
    const record = { deletes: 0 };
    const verdict = await checkJoinThrottle(recordingSql(record), "probe:1.2.3.4", 60);
    expect(verdict).toEqual({ limited: false });
    expect(record.deletes).toBe(1);
  });

  it("skips the prune when the sample misses", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const record = { deletes: 0 };
    const verdict = await checkJoinThrottle(recordingSql(record), "probe:1.2.3.4", 60);
    expect(verdict).toEqual({ limited: false });
    expect(record.deletes).toBe(0);
  });
});
