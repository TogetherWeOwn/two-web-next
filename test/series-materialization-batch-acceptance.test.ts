import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import { materializeMissingInstances, type EventRow } from "../src/admin/store-event-writes";
import {
  expectedCreationProperties,
  SERIES_ACTOR,
  seriesParent,
} from "./series-materialization-batch.fixture";

type Audit = {
  subjectId: string;
  subjectType: string;
  logName: string;
  causerId: string | null;
  description: string;
  properties: Record<string, unknown>;
};
type Statement = { sql: string; params: unknown[] };
type Fault =
  | "missing"
  | "duplicate"
  | "extra"
  | "wrong-key"
  | "wrong-index"
  | "wrong-parent"
  | "duplicate-index"
  | "swapped-keys";

/** Real Drizzle SQL, fake transport only: record actual statements and decode their bind values. */
function driver(
  options: {
    existing?: EventRow[];
    reverse?: boolean;
    fault?: Fault;
    insertError?: boolean;
    auditError?: boolean;
  } = {},
) {
  const statements: Statement[] = [];
  const inserted: EventRow[] = [];
  const audits: Audit[] = [];
  const columns = Object.values(getTableColumns(events));
  const byName = new Map(columns.map((column) => [column.name, column]));
  const keys = new Map(
    Object.entries(getTableColumns(events)).map(([key, col]) => [col.name, key]),
  );
  let nextId = 200;
  let inFlight = false;
  const db = drizzle(async (query, params) => {
    if (inFlight) throw new Error("parallel statement on max:1 transaction");
    inFlight = true;
    try {
      // Force a microtask boundary: Promise.all over writes must not pass accidentally.
      await Promise.resolve();
      statements.push({ sql: query, params: structuredClone(params) });
      if (/^select /i.test(query)) {
        if (!query.includes('from "events"')) throw new Error(`unexpected query: ${query}`);
        return { rows: (options.existing ?? []).map((row) => [row.recurrenceIndex]) };
      }
      const insert =
        /^insert into "(events|activity_log)" \(([^)]+)\) values (.*?)(?: returning (.*))?$/i.exec(
          query,
        );
      if (!insert || /on conflict/i.test(query)) throw new Error(`unexpected statement: ${query}`);
      const [, table, names, tuples, returning] = insert;
      const fields = names!.split(", ").map((name) => name.replaceAll('"', ""));
      const values = tuples!
        .slice(1, -1)
        .split(/\), \(/)
        .map((tuple) => {
          const row: Record<string, unknown> = {};
          tuple.split(", ").forEach((token, index) => {
            if (token === "default") return;
            const parameter = /^\$(\d+)$/.exec(token);
            if (!parameter) throw new Error(`unexpected insert expression: ${token}`);
            row[fields[index]!] = params[Number(parameter[1]) - 1];
          });
          return row;
        });
      if (table === "activity_log") {
        if (options.auditError) throw new Error("fixture audit failure");
        for (const value of values) {
          audits.push({
            subjectId: value.subject_id as string,
            subjectType: value.subject_type as string,
            logName: value.log_name as string,
            causerId: value.causer_id as string | null,
            description: value.description as string,
            properties: JSON.parse(value.properties as string),
          });
        }
        return { rows: [] };
      }
      if (options.insertError) throw new Error("fixture child insert failure");
      const rows = values.map((value) => {
        const row = seriesParent({
          id: nextId++,
          game: null,
          description: null,
          accessibilityNotes: null,
          location: null,
          organizer_name: null,
          join_url: null,
          join_instructions: null,
          capacity: null,
          status: "draft",
          createdBy: null,
          discordEventId: null,
          syncRevision: 1,
          syncedRevision: 0,
          discordSyncFailedAt: null,
          discordSyncFailureCode: null,
          agentGrantId: null,
          proofMarker: null,
          agentVersion: 1,
          rsvpOpen: true,
          recurrenceFrequency: null,
          recurrenceCount: null,
          recurrenceEndsOn: null,
          parentEventId: null,
          recurrenceIndex: null,
          icsSequence: 0n,
        });
        for (const [name, raw] of Object.entries(value)) {
          const column = byName.get(name)!;
          (row as unknown as Record<string, unknown>)[keys.get(name)!] =
            raw === null ? null : column.mapFromDriverValue(raw);
        }
        inserted.push(structuredClone(row));
        return row;
      });
      let returned = options.reverse ? [...rows].reverse() : [...rows];
      if (options.fault === "missing") returned = returned.slice(1);
      if (options.fault === "duplicate") returned = returned.map(() => returned[0]!);
      // A one-row INSERT still receives a malformed extra row in the old linear implementation.
      if (options.fault === "duplicate" && returned.length === 1) returned.push(returned[0]!);
      if (options.fault === "extra") returned.push(seriesParent({ id: 999, recurrenceIndex: 51 }));
      if (options.fault === "wrong-key")
        returned[0] = { ...returned[0]!, eventKey: "01K00000000000000000000099" };
      if (options.fault === "wrong-index") returned[0] = { ...returned[0]!, recurrenceIndex: 52 };
      if (options.fault === "wrong-parent") returned[0] = { ...returned[0]!, parentEventId: 999 };
      if (options.fault === "duplicate-index") {
        returned = returned.map((row) => ({ ...row, recurrenceIndex: 2 }));
      }
      if (options.fault === "swapped-keys") {
        const firstKey = returned[0]!.eventKey;
        returned = returned.map((row, index) => ({
          ...row,
          eventKey:
            index === 0 ? (returned[1]?.eventKey ?? "01K00000000000000000000099") : firstKey,
        }));
      }
      if (!returning) return { rows: [] };
      const projection = returning.split(", ").map((name) => name.replaceAll('"', ""));
      return {
        rows: returned.map((row) =>
          projection.map((name) => {
            const raw = (row as unknown as Record<string, unknown>)[keys.get(name)!];
            return raw == null ? null : byName.get(name)!.mapToDriverValue(raw);
          }),
        ),
      };
    } finally {
      inFlight = false;
    }
  });
  return {
    db: db as unknown as Parameters<typeof materializeMissingInstances>[0],
    statements,
    inserted,
    audits,
    childStatements: () => statements.filter((s) => /^insert into "events"/.test(s.sql)),
    auditStatements: () => statements.filter((s) => /^insert into "activity_log"/.test(s.sql)),
  };
}

describe("weekly series bounded materialization — transport acceptance", () => {
  // Break: reverting to one INSERT per occurrence makes 26/52 linear again.
  it.each([1, 26, 52])(
    "batch.count.%i: one bounded child and audit batch, no parent copy",
    async (count) => {
      const run = driver();
      const parent = seriesParent({ recurrenceCount: count });
      expect(await materializeMissingInstances(run.db, parent, SERIES_ACTOR.id)).toBe(count - 1);
      expect(run.inserted).toHaveLength(count - 1);
      expect(run.audits).toHaveLength(count - 1);
      expect(run.statements.filter((s) => /^select /.test(s.sql)).length).toBeLessThanOrEqual(1);
      expect(run.childStatements()).toHaveLength(count === 1 ? 0 : 1);
      expect(run.auditStatements()).toHaveLength(count === 1 ? 0 : 1);
      expect(run.inserted.map((row) => row.recurrenceIndex)).toEqual(
        Array.from({ length: count - 1 }, (_, i) => i + 2),
      );
      expect(new Set(run.inserted.map((row) => row.eventKey)).size).toBe(count - 1);
      for (const row of run.inserted) {
        expect(row.eventKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(row.eventKey).not.toBe(parent.eventKey);
        expect(row).toMatchObject({
          status: "draft",
          parentEventId: 101,
          createdBy: parent.createdBy,
        });
      }
    },
  );

  // Break: copying a cancelled child again or overwriting its moderator edits.
  it("batch.partial.cancelled: fill only missing indices and leave all existing rows byte-identical", async () => {
    const existing = [
      seriesParent({
        id: 201,
        parentEventId: 101,
        recurrenceIndex: 2,
        status: "cancelled",
        title: "Skipped week",
      }),
      seriesParent({
        id: 202,
        parentEventId: 101,
        recurrenceIndex: 4,
        status: "published",
        title: "One-off title",
      }),
    ];
    const before = structuredClone(existing);
    const run = driver({ existing });
    expect(await materializeMissingInstances(run.db, seriesParent({ recurrenceCount: 6 }))).toBe(3);
    expect(run.inserted.map((row) => row.recurrenceIndex)).toEqual([3, 5, 6]);
    expect(existing).toEqual(before);
    expect(run.childStatements()).toHaveLength(1);
    expect(run.auditStatements()).toHaveLength(1);
    expect(run.audits.every((row) => row.causerId === null)).toBe(true);
    expect(run.statements.some((s) => /^(update|delete)/i.test(s.sql))).toBe(false);
  });

  it("batch.noop: a complete series including a cancelled child emits no writes", async () => {
    const run = driver({
      existing: [
        seriesParent({ parentEventId: 101, recurrenceIndex: 2, status: "cancelled" }),
        seriesParent({ parentEventId: 101, recurrenceIndex: 3 }),
      ],
    });
    expect(await materializeMissingInstances(run.db, seriesParent({ recurrenceCount: 3 }))).toBe(0);
    expect(run.statements).toHaveLength(1);
    expect(run.inserted).toEqual([]);
    expect(run.audits).toEqual([]);
  });

  // Break: zipping submitted rows with unordered RETURNING rows loses per-child audit identity.
  it("batch.returning.reordered: full copied fields and creation audits follow returned identity, not position", async () => {
    const run = driver({ reverse: true });
    const parent = seriesParent({ recurrenceCount: 4 });
    expect(await materializeMissingInstances(run.db, parent, SERIES_ACTOR.id)).toBe(3);
    for (const child of run.inserted) {
      expect(child).toMatchObject({
        title: parent.title,
        game: parent.game,
        description: parent.description,
        accessibilityNotes: parent.accessibilityNotes,
        timezone: parent.timezone,
        location: parent.location,
        organizer_name: parent.organizer_name,
        join_url: parent.join_url,
        join_instructions: parent.join_instructions,
        capacity: parent.capacity,
        status: "draft",
        createdBy: parent.createdBy,
        parentEventId: 101,
        recurrenceFrequency: null,
        recurrenceCount: null,
        recurrenceEndsOn: null,
        discordEventId: null,
        rsvpOpen: true,
        agentGrantId: null,
        proofMarker: null,
      });
      const entries = run.audits.filter((audit) => audit.subjectId === child.eventKey);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        subjectId: child.eventKey,
        subjectType: "Event",
        logName: "default",
        causerId: SERIES_ACTOR.id,
        description: "created event Weekly co-op — all welcome",
        properties: expectedCreationProperties(child),
      });
    }
    expect(run.childStatements()).toHaveLength(1);
    expect(run.auditStatements()).toHaveLength(1);
  });

  it("batch.nulls: nullable copied fields and null creator remain null", async () => {
    const run = driver();
    const parent = seriesParent({
      recurrenceCount: 2,
      game: null,
      description: null,
      accessibilityNotes: null,
      location: null,
      organizer_name: null,
      join_url: null,
      join_instructions: null,
      capacity: null,
      createdBy: null,
    });
    expect(await materializeMissingInstances(run.db, parent)).toBe(1);
    expect(run.inserted[0]).toMatchObject({
      game: null,
      description: null,
      accessibilityNotes: null,
      location: null,
      organizer_name: null,
      join_url: null,
      join_instructions: null,
      capacity: null,
      createdBy: null,
    });
    expect(run.audits[0]!.causerId).toBeNull();
    for (const field of [
      "game",
      "description",
      "accessibilityNotes",
      "location",
      "organizer_name",
      "join_url",
      "join_instructions",
      "capacity",
      "createdBy",
    ]) {
      expect(run.audits[0]!.properties).not.toHaveProperty(field);
    }
  });

  // Break: accepting missing/duplicate/foreign RETURNING rows commits incomplete audit coverage.
  it.each<Fault>([
    "missing",
    "duplicate",
    "extra",
    "wrong-key",
    "wrong-index",
    "wrong-parent",
    "duplicate-index",
    "swapped-keys",
  ])("batch.returning.%s: reject before accepting any child audit", async (fault) => {
    const run = driver({ fault });
    await expect(
      materializeMissingInstances(run.db, seriesParent({ recurrenceCount: 4 }), SERIES_ACTOR.id),
    ).rejects.toThrow();
    expect(run.audits).toEqual([]);
  });

  it.each(["insert", "audit"])(
    "batch.failure.%s: do not turn a failed statement into a success count",
    async (at) => {
      const run = driver({ insertError: at === "insert", auditError: at === "audit" });
      await expect(
        materializeMissingInstances(run.db, seriesParent({ recurrenceCount: 4 })),
      ).rejects.toMatchObject({
        cause: { message: `fixture ${at === "insert" ? "child insert" : "audit"} failure` },
      });
    },
  );

  // Break: replacing the pure wall-clock expansion with UTC-week arithmetic, dropping subminutes or ignoring bounds.
  it.each([
    {
      id: "spring",
      start: "2030-03-24T20:00:00.123Z",
      end: "2030-03-24T22:15:00.456Z",
      wantStart: "2030-03-31T19:00:00.123Z",
      wantEnd: "2030-03-31T21:15:00.456Z",
    },
    {
      id: "fall",
      start: "2030-10-20T19:00:00.123Z",
      end: "2030-10-20T21:15:00.456Z",
      wantStart: "2030-10-27T20:00:00.123Z",
      wantEnd: "2030-10-27T22:15:00.456Z",
    },
    {
      id: "gap",
      start: "2030-03-24T01:30:00.123Z",
      end: "2030-03-24T02:30:00.456Z",
      wantStart: "2030-03-31T01:30:00.123Z",
      wantEnd: "2030-03-31T01:30:00.456Z",
    },
    {
      id: "fold",
      start: "2030-10-20T00:30:00.123Z",
      end: "2030-10-20T02:30:00.456Z",
      wantStart: "2030-10-27T00:30:00.123Z",
      wantEnd: "2030-10-27T03:30:00.456Z",
    },
  ])(
    "batch.wall.$id: preserve literal UTC instants from the host's local week",
    async ({ start, end, wantStart, wantEnd }) => {
      const run = driver();
      expect(
        await materializeMissingInstances(
          run.db,
          seriesParent({ recurrenceCount: 2, startsAt: new Date(start), endsAt: new Date(end) }),
        ),
      ).toBe(1);
      expect(run.inserted[0]!.startsAt.toISOString()).toBe(wantStart);
      expect(run.inserted[0]!.endsAt.toISOString()).toBe(wantEnd);
    },
  );

  it.each([
    { id: "inclusive-end", count: 52, until: "2030-01-20", indices: [2, 3] },
    { id: "between-weeks", count: null, until: "2030-01-19", indices: [2] },
    { id: "count-tighter", count: 2, until: "2030-12-31", indices: [2] },
    { id: "parent-only", count: null, until: "2030-01-06", indices: [] },
  ])(
    "batch.bound.$id: the tighter count or local end date wins",
    async ({ count, until, indices }) => {
      const run = driver();
      expect(
        await materializeMissingInstances(
          run.db,
          seriesParent({
            recurrenceCount: count,
            recurrenceEndsOn: new Date(`${until}T00:00:00Z`),
          }),
        ),
      ).toBe(indices.length);
      expect(run.inserted.map((row) => row.recurrenceIndex)).toEqual(indices);
    },
  );

  it("batch.limit: an unbounded stored weekly rule still stops at 52 including the parent", async () => {
    const run = driver();
    expect(await materializeMissingInstances(run.db, seriesParent({ recurrenceCount: null }))).toBe(
      51,
    );
    expect(run.inserted.at(-1)?.recurrenceIndex).toBe(52);
    expect(run.childStatements()).toHaveLength(1);
    expect(run.auditStatements()).toHaveLength(1);
  });

  it("batch.non-series: no rule means no materialization query", async () => {
    const run = driver();
    expect(
      await materializeMissingInstances(run.db, seriesParent({ recurrenceFrequency: null })),
    ).toBe(0);
    expect(run.statements).toEqual([]);
  });
});
