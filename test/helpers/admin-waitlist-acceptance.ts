import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listRoster } from "../../src/admin/reads";
import { createMemberDataFixture } from "./member-data-db";
import {
  capturedRoster,
  key,
  memberId,
  middleName,
  queueQuery,
  waitlistFixture,
  type WaitlistFixture,
} from "./admin-waitlist-order";

// Registered inside admin.test.ts's existing DB-required suite: no new skip,
// and no setup hook runs in the DB-free lane.
export function registerWaitlistAcceptance() {
  describe("global moderator waitlist positions in PostgreSQL", () => {
    let fixture: WaitlistFixture;
    beforeAll(async () => {
      fixture = await waitlistFixture();
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    const ranks = (rows: { waitlistPosition?: number | null }[]) =>
      rows.map((r) => r.waitlistPosition);

    it("WQ-D11 disposes the owned schema and pool when seeding fails", async () => {
      let schemaName = "";
      const failure = new Error("waitlist seed refused");
      const dispose = vi.fn<() => Promise<void>>();
      await expect(
        waitlistFixture(async (url) => {
          const owned = await createMemberDataFixture(url);
          schemaName = owned.schemaName;
          dispose.mockImplementation(owned.dispose);
          const client = new Proxy(owned.client, {
            // Fail the first tagged-template RSVP seed after events/users exist;
            // leave Drizzle's unsafe(...).values() API untouched.
            apply: () => {
              throw failure;
            },
          });
          return { ...owned, client, dispose };
        }),
      ).rejects.toBe(failure);
      expect(dispose).toHaveBeenCalledOnce();
      expect(
        await fixture.client`select nspname from pg_namespace where nspname=${schemaName}`,
      ).toHaveLength(0);
    });

    describe.each(["Hono", "Kit"] as const)("%s actual route and Postgres", (renderer) => {
      const roster = (raw: Record<string, string> = {}) => capturedRoster(fixture, raw, renderer);
      it("WQ-D01 keeps sub-ms timestamps, bigint legacy keys and native-id final ties exact", async () => {
        const { rows, total } = await roster({ roster_status: "waitlisted" });
        expect(total).toBe(107);
        expect(rows.slice(0, 7).map((r) => r.userId)).toEqual([1, 2, 3, 4, 5, 6, 7].map(memberId));
        expect(ranks(rows.slice(0, 7))).toEqual([1, 2, 3, 4, 5, 6, 7]);
      });

      it.each(["", "waitlisted"])(
        "WQ-D02 search status=%s keeps global ranks and gaps",
        async (status) => {
          const result = await roster({ roster_q: middleName, roster_status: status });
          expect(result.total).toBe(1);
          expect(result.rows.map((r) => [r.username, r.waitlistPosition])).toEqual([
            [middleName, 57],
          ]);
          expect(result.audits.map((a) => a.subjectUserIds)).toEqual([[memberId(57)]]);
          const gaps = await roster({ roster_q: "Gap", roster_status: status });
          expect(gaps.total).toBe(3);
          expect(ranks(gaps.rows)).toEqual([1, 3, 105]);
          expect(gaps.rows.map((r) => r.userId)).toEqual([1, 3, 105].map(memberId));
        },
      );

      it("WQ-D03 page two starts at 101 and retains absent/blank members", async () => {
        const result = await roster({ roster_status: "waitlisted", roster_page: "2" });
        expect(result.total).toBe(107);
        expect(ranks(result.rows)).toEqual([101, 102, 103, 104, 105, 106, 107]);
        expect(result.rows.map((r) => r.userId)).toEqual(
          [101, 102, 103, 104, 105, 106, 107].map(memberId),
        );
        expect(result.rows[1]!.username).toBeNull();
        expect(result.rows[2]!.username?.trim()).toBe("");
        expect(result.audits[0]!.subjectUserIds).toEqual(result.rows.map((r) => r.userId).sort());
      });

      it.each(["going", "maybe", "not_going"])(
        "WQ-D04 %s has no queue rank or count drift",
        async (status) => {
          const result = await roster({ roster_status: status });
          expect(result.total).toBe(1);
          expect(result.rows.map((r) => [r.status, r.waitlistPosition])).toEqual([[status, null]]);
        },
      );

      it("WQ-D05 all-mode ordering is deterministic with unranked rows last", async () => {
        const first = await roster();
        const tail = await roster({ roster_page: "2" });
        expect(first.total).toBe(110);
        expect(first.rows).toHaveLength(100);
        expect(ranks(first.rows)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
        expect(ranks(tail.rows).slice(0, 7)).toEqual([101, 102, 103, 104, 105, 106, 107]);
        expect(tail.rows.slice(7)).toHaveLength(3);
        expect(ranks(tail.rows.slice(7))).toEqual([null, null, null]);
        expect((await roster({ roster_page: "2" })).rows).toEqual(tail.rows);
      });

      it("WQ-D06 descending queue mode reverses global ranks without renumbering", async () => {
        const result = await roster({ roster_status: "waitlisted", roster_order: "desc" });
        expect(ranks(result.rows).slice(0, 5)).toEqual([107, 106, 105, 104, 103]);
        const last = await roster({
          roster_status: "waitlisted",
          roster_order: "desc",
          roster_page: "2",
        });
        expect(ranks(last.rows)).toEqual([7, 6, 5, 4, 3, 2, 1]);
      });

      it("WQ-D07 answering again changes Answered sorting but never FIFO position", async () => {
        await fixture.client`update rsvps set updated_at='2098-01-01' where event_id=${fixture.event.id} and user_id=${memberId(57)}`;
        try {
          expect((await roster({ roster_q: middleName })).rows[0]!.waitlistPosition).toBe(57);
          const answered = await listRoster(
            fixture.db,
            key,
            queueQuery({ roster_sort: "answered", roster_order: "desc" }),
          );
          expect(answered.rows[0]!.userId).toBe(memberId(57));
          expect(answered.rows[0]!.waitlistPosition).toBe(57);
        } finally {
          await fixture.client`update rsvps set updated_at='2026-03-01 00:00:54+00' where event_id=${fixture.event.id} and user_id=${memberId(57)}`;
        }
      });

      it.each(["answered", "status"])(
        "WQ-D08 preserves both directions of %s sort",
        async (sort) => {
          for (const order of ["asc", "desc"] as const) {
            const result = await roster({ roster_sort: sort, roster_order: order });
            const ordered = [...result.rows].sort((a, b) => {
              const cmp =
                sort === "status"
                  ? a.status.localeCompare(b.status)
                  : a.answeredAt.getTime() - b.answeredAt.getTime();
              return (order === "asc" ? cmp : -cmp) || a.userId.localeCompare(b.userId);
            });
            expect(result.rows.map((r) => r.userId)).toEqual(ordered.map((r) => r.userId));
            expect(
              result.rows.every((r) =>
                r.status === "waitlisted"
                  ? Number.isInteger(r.waitlistPosition)
                  : r.waitlistPosition === null,
              ),
            ).toBe(true);
          }
        },
      );

      it("WQ-D09 bounded reads audit every transported owner", async () => {
        const result = await roster({ roster_status: "waitlisted" });
        const reads = fixture.statements.filter((s) => /^\s*select\b/i.test(s.sql));
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.length).toBeLessThanOrEqual(4);
        const memberReads = reads.filter((s) => /from rsvps\b/i.test(s.sql));
        expect(memberReads.length).toBeGreaterThan(0);
        for (const read of memberReads) expect(read.sql).toMatch(/\blimit\b/i);
        const owners = result.audits.flatMap((a) => a.subjectUserIds);
        for (const row of result.rows) expect(owners).toContain(row.userId);
        expect(owners.length).toBeGreaterThanOrEqual(100);
        expect(owners.length).toBeLessThanOrEqual(101);
        expect(
          owners.every((id) => Array.from({ length: 101 }, (_, i) => memberId(i + 1)).includes(id)),
        ).toBe(true);
        await roster({ roster_q: middleName });
        expect(fixture.statements.filter((s) => /^\s*select\b/i.test(s.sql))).toHaveLength(
          reads.length,
        );
        expect(result.response.headers.get("cache-control")).toBe("private, no-store");
      });

      it("WQ-D12 promotion removes a member from the queue on the next render", async () => {
        await fixture.client`update rsvps set status='going' where event_id=${fixture.event.id} and user_id=${memberId(1)}`;
        try {
          const remaining = await roster({ roster_q: "Gap", roster_status: "waitlisted" });
          expect(remaining.rows.map((r) => [r.userId, r.waitlistPosition])).toEqual([
            [memberId(3), 2],
            [memberId(105), 104],
          ]);
          expect((await roster({ roster_q: "Gap 001" })).rows[0]!.waitlistPosition).toBeNull();
        } finally {
          await fixture.client`update rsvps set status='waitlisted' where event_id=${fixture.event.id} and user_id=${memberId(1)}`;
        }
      });

      it("WQ-D10 past-end paging keeps total but reads/audits no phantom members", async () => {
        const result = await roster({ roster_status: "waitlisted", roster_page: "3" });
        expect(result.total).toBe(107);
        expect(result.rows).toEqual([]);
        expect(result.audits).toEqual([]);
      });
    });
  });
}
