import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { pgReconciliationReads } from "../src/admin/reconciliation-reads";

const key = "12345678-1234-1234-1234-123456789abc";
const now = new Date("2026-01-01T00:00:00Z");
const row = {
  idempotency_key: key,
  verb: "event.upsert",
  subject: "event:42",
  first_seen_at: now,
  last_attempt_at: now,
  attempts: 2,
  last_code: "needs_reconciliation",
  last_status: 409,
  resolved_at: null,
  resolution: null,
  last_request_id: "secret-request",
  resolved_by: "secret-actor",
};

function fixture(rows: object[], fail = false) {
  const calls: { query: string; values: unknown[] }[] = [];
  const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    calls.push({ query, values });
    if (fail) throw new Error("database unavailable");
    return query.includes("set_config") ? [] : rows;
  };
  const sql = { begin: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) };
  return { reads: pgReconciliationReads(sql as unknown as ReturnType<typeof postgres>), calls };
}

describe("dormant reconciliation reads", () => {
  it("uses bounded ordered projections, preserving the original key", async () => {
    const { reads, calls } = fixture([row]);
    const [open] = await reads.listOpen();
    const [resolved] = await reads.listResolved();
    expect(open).toEqual({
      idempotencyKey: key,
      verb: "event.upsert",
      subject: "event:42",
      firstSeenAt: now,
      lastAttemptAt: now,
      attempts: 2,
      lastCode: "needs_reconciliation",
      lastStatus: 409,
      resolvedAt: null,
      resolution: null,
    });
    expect(resolved).toEqual(open);
    expect(calls[1]?.values).toEqual([100]);
    expect(calls[1]?.query).toContain(
      "where resolved_at is null order by first_seen_at asc, idempotency_key asc",
    );
    expect(calls[1]?.query).toMatch(/limit\s+\?\s*$/);
    expect(calls[3]?.values).toEqual([50]);
    expect(calls[3]?.query).toContain(
      "where resolved_at is not null order by resolved_at desc, idempotency_key asc",
    );
    expect(calls[3]?.query).toMatch(/limit\s+\?\s*$/);
    for (const call of [calls[1], calls[3]]) {
      expect(call?.query).not.toMatch(/select \*|last_request_id|resolved_by/i);
    }
  });

  it("rejects invalid keys without a query and returns null for a missing key", async () => {
    const { reads, calls } = fixture([]);
    expect(await reads.get("not-a-uuid")).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await reads.get(key)).toBeNull();
    expect(calls[1]?.values).toEqual([key]);
    expect(calls[1]?.query).toContain("limit 1");
  });

  it("does not return untrusted diagnostics or free-text legacy fields", async () => {
    const { reads } = fixture([
      {
        ...row,
        subject: "secret text!",
        last_code: "private-token",
        last_status: 900,
        resolution: "private note",
      },
    ]);
    expect(await reads.get(key)).toMatchObject({
      subject: null,
      lastCode: "unknown",
      lastStatus: null,
      resolution: null,
    });
    const allowed = fixture([
      { ...row, resolution: "confirmed", last_code: null, last_status: null },
    ]);
    expect(await allowed.reads.get(key)).toMatchObject({
      resolution: "confirmed",
      lastCode: null,
      lastStatus: null,
    });
  });

  it("propagates database failures", async () => {
    const { reads } = fixture([], true);
    await expect(reads.listOpen()).rejects.toThrow("database unavailable");
  });
});
