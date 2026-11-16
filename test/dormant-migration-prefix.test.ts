import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  botReconciliationIntents,
  eventEchoes,
  eventEchoMembers,
  eventSyncAttempts,
} from "../src/db/admin-schema";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url).href), "utf8");
const prefix = [
  ["1034_event-echoes", "5b35e192433f369990f96b14c681fc77179e15df9dd73c2f84a7446e4220fada"],
  [
    "1035_bot-reconciliation-intents",
    "0322c376fb923eb09833b0a7e0dca1635f25a1d79025f456dea0d87cce7ba583",
  ],
  [
    "1036_event-sync-claim-started",
    "cc2993bd6cd66dadcc69acbb1ab4732941e975f423b2e2ebd632f11d59118573",
  ],
] as const;

describe("dormant migration prefix", () => {
  it("pins the SQL bytes, lock entries and ordered cumulative snapshot chain", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const lock = JSON.parse(read("migrations.lock")) as {
      migrations: { path: string; sha256: string }[];
    };
    let previous = JSON.parse(read("drizzle/meta/1033_snapshot.json")).id as string;
    let previousTime = journal.entries.find((entry) => entry.idx === 33)!.when;
    for (const [index, [tag, hash]] of prefix.entries()) {
      const path = `drizzle/${tag}.sql`;
      expect(createHash("sha256").update(read(path)).digest("hex")).toBe(hash);
      expect(lock.migrations.filter((entry) => entry.path === path)).toEqual([
        { path, sha256: hash },
      ]);
      const entry = journal.entries.find((item) => item.tag === tag)!;
      expect(entry.idx).toBe(34 + index);
      expect(entry.when).toBeGreaterThan(previousTime);
      previousTime = entry.when;
      const snapshot = JSON.parse(read(`drizzle/meta/${tag.slice(0, 4)}_snapshot.json`)) as {
        id: string;
        prevId: string;
      };
      expect(snapshot.prevId).toBe(previous);
      previous = snapshot.id;
    }
  });

  it("retains all prefix tables and the claim column in the cumulative schema", () => {
    const snapshot = JSON.parse(read("drizzle/meta/1036_snapshot.json")) as {
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    for (const table of [eventEchoes, eventEchoMembers, botReconciliationIntents]) {
      const config = getTableConfig(table);
      expect(Object.keys(snapshot.tables[`public.${config.name}`]!.columns).sort()).toEqual(
        config.columns.map((column) => column.name).sort(),
      );
    }
    expect(getTableConfig(eventSyncAttempts).columns.map((column) => column.name)).toContain(
      "claim_started_at",
    );
    expect(snapshot.tables["public.event_sync_attempts"]!.columns).toHaveProperty(
      "claim_started_at",
    );
  });
});
