import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRoster } from "../src/admin/reads";
import { rawMemberOwner, validateNonSensitiveRead } from "../src/db/read-classification";
import { MemberReadRefused } from "../src/member-reads";
import {
  capturedRoster,
  key,
  memberId,
  middleName,
  queueQuery,
  waitlistFixture,
  type WaitlistFixture,
} from "./helpers/admin-waitlist-order";

let fixture: WaitlistFixture;
beforeAll(async () => {
  fixture = await waitlistFixture();
});
afterAll(async () => {
  await fixture?.dispose();
});
const ranks = (rows: { waitlistPosition?: number | null }[]) => rows.map((r) => r.waitlistPosition);
const firstSeven = [
  memberId(1),
  memberId(2),
  memberId(3),
  memberId(4),
  memberId(5),
  memberId(6),
  memberId(7),
];

describe.skipIf(!process.env.DATABASE_URL)(
  "global moderator waitlist positions in PostgreSQL",
  () => {
    it("WQ-D01 keeps sub-ms timestamps, bigint legacy keys and native-id final ties exact", async () => {
      const { rows, total } = await capturedRoster(fixture, {
        roster_status: "waitlisted",
      });
      expect(total).toBe(107);
      expect(rows.slice(0, 7).map((r) => r.userId)).toEqual(firstSeven);
      expect(ranks(rows.slice(0, 7))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it.each(["", "waitlisted"])(
      "WQ-D02 search status=%s keeps the middle member at 57, not one",
      async (status) => {
        const result = await capturedRoster(fixture, {
          roster_q: middleName,
          roster_status: status,
        });
        expect(result.total).toBe(1);
        expect(result.rows.map((r) => [r.username, r.waitlistPosition])).toEqual([
          [middleName, 57],
        ]);
        expect(result.audits.map((a) => a.subjectUserIds)).toEqual([[memberId(57)]]);
      },
    );

    it("WQ-D03 the second page starts at 101 and keeps absent/blank members in the queue", async () => {
      const result = await capturedRoster(fixture, {
        roster_status: "waitlisted",
        roster_page: "2",
      });
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
      "WQ-D04 %s has no queue position or filtered-count drift",
      async (status) => {
        const result = await capturedRoster(fixture, { roster_status: status });
        expect(result.total).toBe(1);
        expect(result.rows.map((r) => [r.status, r.waitlistPosition])).toEqual([[status, null]]);
      },
    );

    it("WQ-D05 all-mode queue ordering is deterministic, with non-waitlisted rows unranked", async () => {
      const first = await capturedRoster(fixture);
      const tail = await capturedRoster(fixture, { roster_page: "2" });
      expect(first.total).toBe(110);
      expect(first.rows).toHaveLength(100);
      expect(ranks(first.rows)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
      expect(ranks(tail.rows).slice(0, 7)).toEqual([101, 102, 103, 104, 105, 106, 107]);
      expect(tail.rows.slice(7)).toHaveLength(3);
      expect(ranks(tail.rows.slice(7))).toEqual([null, null, null]);
      const repeated = await capturedRoster(fixture, { roster_page: "2" });
      expect(repeated.rows).toEqual(tail.rows);
    });

    it("WQ-D06 descending queue mode reverses global ranks without renumbering", async () => {
      const result = await capturedRoster(fixture, {
        roster_status: "waitlisted",
        roster_order: "desc",
      });
      expect(ranks(result.rows).slice(0, 5)).toEqual([107, 106, 105, 104, 103]);
      const last = await capturedRoster(fixture, {
        roster_status: "waitlisted",
        roster_order: "desc",
        roster_page: "2",
      });
      expect(ranks(last.rows)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    });

    it("WQ-D07 answering again changes Answered sorting but never FIFO position", async () => {
      await fixture.client`update rsvps set updated_at='2098-01-01' where event_id=${fixture.event.id} and user_id=${memberId(57)}`;
      try {
        const result = await capturedRoster(fixture, { roster_q: middleName });
        expect(result.rows[0]!.waitlistPosition).toBe(57);
        const answered = await listRoster(
          fixture.db,
          key,
          queueQuery({ roster_sort: "answered", roster_order: "desc" }),
        );
        expect(answered.rows[0]!.userId).toBe(memberId(57));
        expect((answered.rows[0] as { waitlistPosition?: number }).waitlistPosition).toBe(57);
      } finally {
        await fixture.client`update rsvps set updated_at='2026-03-01 00:00:54+00' where event_id=${fixture.event.id} and user_id=${memberId(57)}`;
      }
    });

    it.each(["answered", "status"])(
      "WQ-D08 preserves both directions of the existing %s sort",
      async (sort) => {
        for (const order of ["asc", "desc"] as const) {
          const result = await capturedRoster(fixture, {
            roster_sort: sort,
            roster_order: order,
          });
          const ordered = [...result.rows].sort((a, b) => {
            const cmp =
              sort === "status"
                ? a.status.localeCompare(b.status)
                : Date.parse(a.answeredAt as unknown as string) -
                  Date.parse(b.answeredAt as unknown as string);
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

    it("WQ-D09 fixed-size set reads audit every transported owner, including lookahead", async () => {
      const result = await capturedRoster(fixture, {
        roster_status: "waitlisted",
      });
      const statements = [...fixture.statements];
      const reads = statements.filter((s) => /^\s*select\b/i.test(s.sql));
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.length).toBeLessThanOrEqual(4);
      const memberReads = reads.filter((s) => !/count\(\*\)/i.test(s.sql));
      expect(memberReads.length).toBeGreaterThan(0);
      for (const read of memberReads) expect(read.sql).toMatch(/\blimit\b/i);
      const owners = result.audits.flatMap((a) => a.subjectUserIds);
      for (const row of result.rows) expect(owners).toContain(row.userId);
      expect(owners.length).toBeGreaterThanOrEqual(100);
      expect(owners.length).toBeLessThanOrEqual(101);
      expect(
        owners.every((id) => Array.from({ length: 101 }, (_, i) => memberId(i + 1)).includes(id)),
      ).toBe(true);
      await capturedRoster(fixture, { roster_q: middleName });
      expect(fixture.statements.filter((s) => /^\s*select\b/i.test(s.sql))).toHaveLength(
        reads.length,
      );
      expect(result.response.headers.get("cache-control")).toBe("private, no-store");
    });

    it("WQ-D10 past-end paging keeps the filtered total but reads/audits no phantom members", async () => {
      const result = await capturedRoster(fixture, {
        roster_status: "waitlisted",
        roster_page: "3",
      });
      expect(result.total).toBe(107);
      expect(result.rows).toEqual([]);
      expect(result.audits).toEqual([]);
    });
  },
);

it("WQ-P03 new ranking cannot turn arbitrary roster SQL/member projections into exempt reads", async () => {
  const hostile = [
    'select "user_id", count(*) from "rsvps" group by "user_id"',
    'select count(*) from "rsvps"',
    'select count(*) from "rsvps" inner join "events" on "events"."id" = "rsvps"."event_id" where "events"."event_key" = $1 or true',
    'select "id", "username" from "users"',
    "select user_id, position from (select user_id, row_number() over (order by updated_at) as position from rsvps) line",
  ];
  for (const query of hostile) {
    expect(() => validateNonSensitiveRead("roster-count", query)).toThrow(MemberReadRefused);
    expect(rawMemberOwner(query)).toBeUndefined();
  }
});
