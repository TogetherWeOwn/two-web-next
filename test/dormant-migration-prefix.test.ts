import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { eventEchoes, eventEchoMembers } from "../src/db/dormant-schema";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url).href), "utf8");
const prefix = [
  ["1034_event-echoes", "5b35e192433f369990f96b14c681fc77179e15df9dd73c2f84a7446e4220fada"],
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

  it("retains the Echo tables in the cumulative schema", () => {
    const snapshot = JSON.parse(read("drizzle/meta/1034_snapshot.json")) as {
      tables: Record<
        string,
        {
          columns: Record<string, unknown>;
          indexes: Record<string, unknown>;
          foreignKeys: Record<string, unknown>;
          uniqueConstraints: Record<string, unknown>;
          checkConstraints: Record<string, unknown>;
        }
      >;
    };
    for (const table of [eventEchoes, eventEchoMembers]) {
      const config = getTableConfig(table);
      const saved = snapshot.tables[`public.${config.name}`]!;
      expect(Object.keys(saved.columns).sort()).toEqual(
        config.columns.map((column) => column.name).sort(),
      );
      expect(Object.keys(saved.indexes).sort()).toEqual(
        config.indexes.map((index) => index.config.name).sort(),
      );
      expect(Object.keys(saved.foreignKeys).sort()).toEqual(
        config.foreignKeys.map((key) => key.getName()).sort(),
      );
      expect(Object.keys(saved.checkConstraints).sort()).toEqual(
        config.checks.map((check) => check.name).sort(),
      );
      expect(Object.keys(saved.uniqueConstraints).sort()).toEqual(
        [
          ...config.uniqueConstraints.map((constraint) => constraint.name),
          ...config.columns.filter((column) => column.isUnique).map((column) => column.uniqueName),
        ].sort(),
      );
    }
  });
});
