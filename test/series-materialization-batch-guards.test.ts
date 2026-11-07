import { describe, expect, it } from "vitest";
import { activityLog, events } from "../src/db/admin-schema";
import { materializeMissingInstances, type EventRow } from "../src/admin/store-event-writes";
import { SERIES_ACTOR, seriesParent } from "./series-materialization-batch.fixture";

type Value = Record<string, unknown>;

/** Fluent-level fake: the events INSERT returns whatever `shape` makes of the submitted rows. */
function fakeDb(shape: (rows: EventRow[]) => EventRow[]) {
  const auditSubjects: string[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: (table: unknown) => ({
      values: (value: Value | Value[]) => {
        if (table === activityLog) {
          for (const entry of [value].flat()) auditSubjects.push(entry.subjectId as string);
          return Promise.resolve();
        }
        expect(table).toBe(events);
        const rows = (value as Value[]).map(
          (v, i) => ({ ...seriesParent(), ...v, id: 200 + i }) as unknown as EventRow,
        );
        return { returning: async () => shape(rows) };
      },
    }),
  };
  return { db: db as unknown as Parameters<typeof materializeMissingInstances>[0], auditSubjects };
}

const parent = seriesParent({ recurrenceCount: 4 });

describe("weekly series batch — returned-row guards", () => {
  // Break: dropping the per-index seen check lets an exact duplicate row, on top of a full
  // set, pass the size check and write a second creation audit.
  it("refuses a duplicate of an otherwise complete RETURNING set before any audit", async () => {
    const run = fakeDb((rows) => [...rows, rows[0]!]);
    await expect(materializeMissingInstances(run.db, parent, SERIES_ACTOR.id)).rejects.toThrow(
      "unexpected row",
    );
    expect(run.auditSubjects).toEqual([]);
  });

  // Break: removing the index sort writes audits in RETURNING order, which is unspecified.
  it("writes creation audits in recurrence-index order whatever the RETURNING order", async () => {
    // Keys are fresh per call, so compare order through the index each key was issued for.
    const indexByKey = new Map<string, number>();
    const capture = fakeDb((rows) => {
      for (const row of rows) indexByKey.set(row.eventKey, row.recurrenceIndex!);
      return [...rows].reverse();
    });
    expect(await materializeMissingInstances(capture.db, parent, SERIES_ACTOR.id)).toBe(3);
    expect(capture.auditSubjects.map((key) => indexByKey.get(key))).toEqual([2, 3, 4]);
  });
});
