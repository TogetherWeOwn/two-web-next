// A throwing expiry prune must never change a decided throttle verdict.
// Regression cover for the refused-path prune: without best-effort handling,
// a DELETE failure after a refusal rejects checkJoinThrottle, and the generic
// middleware catch turns that into an admission (fail-open), while the direct
// join path (no catch) turns a 429 into a 500. Hermetic: an in-memory SQL
// double with a throwing DELETE, no database required.
import { describe, expect, it } from "vitest";
import { checkJoinThrottle } from "../src/join/service";
import type { Sql } from "../src/sessions";
import { withThrottleTx } from "./helpers/throttle-tx-double";

function fixture(failPrune: boolean) {
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
      if (failPrune) throw new Error("prune boom");
      return [];
    }
    throw new Error("Unexpected throttle statement");
  }) as unknown as Sql);
  return { hits, sql };
}

describe("throttle prune failure keeps the decided verdict", () => {
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
});
