// route-inventory: GET /admin/queue/source-evidence/:id
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildEvidenceSelects,
  canonicalStatementTexts,
  normalizeStatementText,
  STATEMENT_SET_HASH,
  statementSetHash,
} from "../src/admin/source-evidence";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const sources = {
  queue_failed_jobs_by_id: "src/jobs/preview.ts",
  events_by_key_exists: "src/jobs/preview.ts",
  stale_keys: "src/jobs/events.ts",
  pending_sync: "src/jobs/events.ts",
  failed_sync: "src/jobs/events.ts",
} as const;

describe("statement-set identity binding", () => {
  it("pins the statement-set hash", async () => {
    expect(await statementSetHash()).toBe(STATEMENT_SET_HASH);
    expect(STATEMENT_SET_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("keeps every canonical text verbatim in the module that executes it", () => {
    const normalized = Object.fromEntries(
      Object.entries(sources).map(([statement, path]) => [
        statement,
        normalizeStatementText(read(path)),
      ]),
    ) as Record<keyof typeof sources, string>;
    for (const { statement, text } of canonicalStatementTexts()) {
      expect(
        normalized[statement].includes(normalizeStatementText(text)),
        `${statement} drifted from ${sources[statement]}`,
      ).toBe(true);
    }
  });

  it("covers every executed source SELECT and nothing else", () => {
    expect(
      canonicalStatementTexts()
        .map((entry) => entry.statement)
        .sort(),
    ).toEqual(Object.keys(sources).sort());
  });

  it("never reaches the preview-success handler, sessions, or the queue", () => {
    const module = read("src/admin/source-evidence.ts");
    for (const forbidden of [
      "activity_log",
      "recordQueuePreviewAccess",
      "previewFailedJob",
      "adminGuard",
      "sessions",
      "SYNC_EVENT_QUEUE",
      "redispatch",
    ]) {
      expect(module.includes(forbidden), `forbidden reference: ${forbidden}`).toBe(false);
    }
  });
});

describe("evidence validation", () => {
  const startedAt = Date.now();
  const fresh = new Date(startedAt).toISOString();
  it("accepts one fresh marker per executed SELECT, null for empty reads", () => {
    expect(
      buildEvidenceSelects(
        [
          { statement: "queue_failed_jobs_by_id", rowCount: 1, readAt: fresh },
          { statement: "events_by_key_exists", rowCount: 0, readAt: null },
        ],
        true,
        startedAt,
        startedAt + 1000,
      ),
    ).toEqual([
      {
        index: 0,
        statement: "queue_failed_jobs_by_id",
        rowCount: 1,
        readAt: new Date(Date.parse(fresh)).toISOString(),
      },
      { index: 1, statement: "events_by_key_exists", rowCount: 0, readAt: null },
    ]);
  });

  it.each([
    {
      label: "unknown statement",
      reports: [{ statement: "queue_jobs", rowCount: 1, readAt: fresh }],
    },
    {
      label: "missing failed-row read",
      reports: [{ statement: "events_by_key_exists", rowCount: 1, readAt: fresh }],
    },
    {
      label: "stale failed-row marker",
      reports: [
        {
          statement: "queue_failed_jobs_by_id",
          rowCount: 1,
          readAt: new Date(0).toISOString(),
        },
      ],
    },
    {
      label: "missing marker on a nonempty read",
      reports: [
        { statement: "queue_failed_jobs_by_id", rowCount: 1, readAt: fresh },
        { statement: "stale_keys", rowCount: 2, readAt: null },
      ],
    },
  ])("refuses on $label", ({ reports }) => {
    expect(() =>
      buildEvidenceSelects(
        reports as unknown as Parameters<typeof buildEvidenceSelects>[0],
        true,
        startedAt,
        startedAt + 1000,
      ),
    ).toThrow();
  });
});
