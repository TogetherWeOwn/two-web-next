// A throwing expiry prune must never change a decided throttle verdict.
// Regression cover for the refused-path prune: without best-effort handling,
// a DELETE failure after a refusal rejects checkJoinThrottle, and the generic
// middleware catch turns that into an admission (fail-open), while the direct
// join path (no catch) turns a 429 into a 500. Hermetic: an in-memory SQL
// double with a throwing DELETE, no database required.
import { describe, expect, it, vi } from "vitest";
import { checkWebThrottle } from "../src/http/throttle";
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
  it("a refused request stays refused when the prune throws", async () => {
    const { hits, sql } = fixture(true);
    const bucket = "prune-failure-refused";
    hits.push(bucket, bucket);
    const verdict = await checkJoinThrottle(sql, bucket, 2);
    expect(verdict).toEqual({ limited: true, retryAfter: 30 });
    // No hit recorded for the refusal, even though pruning failed.
    expect(hits).toEqual([bucket, bucket]);

    const failure = new PruneBoomError("fixture prune failure");
    const direct = fixture(true, failure);
    direct.hits.push(bucket, bucket);
    const onPruneFailure = vi.fn();
    expect(await checkWebThrottle(direct.sql, bucket, 2, onPruneFailure)).toEqual(verdict);
    expect(onPruneFailure).toHaveBeenCalledExactlyOnceWith({ err: failure });
    expect(direct.hits).toEqual(hits);
  });

  it("an admitted request stays admitted when the prune throws", async () => {
    const { hits, sql } = fixture(true);
    const bucket = "prune-failure-admitted";
    const verdict = await checkJoinThrottle(sql, bucket, 2);
    expect(verdict).toEqual({ limited: false });
    expect(hits).toEqual([bucket]);
  });

  it("keeps a refusal when the prune reporter throws", async () => {
    const { hits, sql } = fixture(true);
    const bucket = "prune-reporter-throws";
    hits.push(bucket);
    const report = vi.fn(() => {
      throw new Error("fixture reporter throw");
    });

    expect(await checkWebThrottle(sql, bucket, 1, report)).toEqual({
      limited: true,
      retryAfter: 30,
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(hits).toEqual([bucket]);
  });

  it("admits without waiting for a prune reporter that later rejects", async () => {
    const { hits, sql } = fixture(true);
    const bucket = "prune-reporter-rejects";
    let rejectReport!: (reason: Error) => void;
    const pendingReport = new Promise<void>((_, reject) => {
      rejectReport = reject;
    });
    // A Vitest mock observes promise settlements itself and would mask a leak.
    let reports = 0;
    const report = () => {
      reports++;
      return pendingReport;
    };

    expect(await checkWebThrottle(sql, bucket, 1, report)).toEqual({ limited: false });
    expect(reports).toBe(1);
    expect(hits).toEqual([bucket]);
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      rejectReport(new Error("fixture reporter rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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
