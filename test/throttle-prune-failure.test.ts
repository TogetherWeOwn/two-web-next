// A throwing expiry prune must never change a decided throttle verdict.
// Regression cover for the refused-path prune: without best-effort handling,
// a DELETE failure after a refusal rejects checkJoinThrottle, and the generic
// middleware catch turns that into an admission (fail-open), while the direct
// join path (no catch) turns a 429 into a 500. Hermetic: an in-memory SQL
// double with a throwing DELETE, no database required.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkJoinThrottle } from "../src/join/service";
import type { Sql } from "../src/sessions";
import { withThrottleTx } from "./helpers/throttle-tx-double";

class PruneBoomError extends Error {
  override name = "PruneBoomError";
}

function fixture(failPrune: boolean, pruneError: unknown = new Error("prune boom")) {
  const hits: string[] = [];
  const sql = withThrottleTx((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)"))
      return [{ n: hits.filter((bucket) => bucket === values[0]).length, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits")) {
      hits.push(values[0] as string);
      return [];
    }
    if (query.includes("DELETE FROM web_throttle_hits")) {
      if (failPrune) throw pruneError;
      return [];
    }
    throw new Error("Unexpected throttle statement");
  }) as unknown as Sql);
  return { hits, sql };
}

describe("throttle prune failure keeps the decided verdict", () => {
  beforeEach(() => {
    // Pin the prune sample so these cases exercise the throwing prune
    // deterministically; sampling itself is pinned separately.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a refused request stays refused when the prune throws", async () => {
    const { hits, sql } = fixture(true);
    const bucket = "prune-failure-refused";
    hits.push(bucket, bucket);
    const verdict = await checkJoinThrottle(sql, bucket, 2);
    expect(verdict).toEqual({ limited: true, retryAfter: 30 });
    // No hit recorded for the refusal, even though pruning failed.
    expect(hits).toEqual([bucket, bucket]);
  });

  it("an admitted request stays admitted when the prune throws", async () => {
    const { hits, sql } = fixture(true);
    const bucket = "prune-failure-admitted";
    const verdict = await checkJoinThrottle(sql, bucket, 2);
    expect(verdict).toEqual({ limited: false });
    expect(hits).toEqual([bucket]);
  });

  it("logs the exception class, never the message, and keeps the refusal", async () => {
    const { hits, sql } = fixture(true, new PruneBoomError("prune boom detail"));
    const bucket = "prune-failure-warn-class";
    hits.push(bucket, bucket);
    const warns: unknown[][] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args);
    });
    try {
      const verdict = await checkJoinThrottle(sql, bucket, 2);
      expect(verdict).toEqual({ limited: true, retryAfter: 30 });
      expect(hits).toEqual([bucket, bucket]);
    } finally {
      spy.mockRestore();
    }
    expect(warns).toHaveLength(1);
    const first = warns[0]!;
    expect(first[0]).toBe("Join throttle prune failed; keeping the decided verdict.");
    expect(first[1]).toMatchObject({ exception: "PruneBoomError" });
    // The DB error text (which can quote statement bindings) never reaches the log.
    expect(JSON.stringify(first)).not.toContain("prune boom detail");
  });

  it("names a non-Error prune throw by constructor, unknown when absent", async () => {
    for (const [thrown, exception, leaked] of [
      ["prune boom string", "String", "prune boom string"],
      [null, "unknown", "null"],
    ] as const) {
      const { hits, sql } = fixture(true, thrown);
      const bucket = "prune-failure-warn-non-error";
      hits.push(bucket, bucket);
      const warns: unknown[][] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warns.push(args);
      });
      try {
        const verdict = await checkJoinThrottle(sql, bucket, 2);
        expect(verdict).toEqual({ limited: true, retryAfter: 30 });
        expect(hits).toEqual([bucket, bucket]);
      } finally {
        spy.mockRestore();
      }
      expect(warns).toHaveLength(1);
      const first = warns[0]!;
      expect(first[0]).toBe("Join throttle prune failed; keeping the decided verdict.");
      expect(first[1]).toMatchObject({ exception });
      // The thrown value itself never reaches the log.
      expect(JSON.stringify(first)).not.toContain(leaked);
    }
  });
});
