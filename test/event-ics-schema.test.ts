import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([false, true])(
  "calendar snapshot chains and generation adds no duplicate column (later migration: %s)",
  (laterMigration) => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
    const previous = readJson("drizzle/meta/1013_snapshot.json");
    const current = readJson("drizzle/meta/1014_snapshot.json");
    expect(current.prevId).toBe(previous.id);
    expect(current.tables["public.events"].columns.ics_sequence).toMatchObject({
      name: "ics_sequence",
      type: "bigint",
      notNull: true,
      default: "0",
    });
    const journal = readJson("drizzle/meta/_journal.json");

    const scratch = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "ics-schema-"),
    );
    try {
      mkdirSync(join(scratch, "src/db"), { recursive: true });
      for (const file of ["schema.ts", "admin-schema.ts"])
        cpSync(join(root, "src/db", file), join(scratch, "src/db", file));
      cpSync(join(root, "drizzle"), join(scratch, "drizzle"), { recursive: true });
      cpSync(join(root, "drizzle.config.ts"), join(scratch, "drizzle.config.ts"));
      symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
      writeFileSync(join(scratch, "package.json"), '{"type":"module"}\n');
      if (laterMigration) {
        const last = journal.entries.at(-1);
        const prefix = last.tag.split("_")[0];
        const next = String(Number(prefix) + 1).padStart(4, "0");
        const latest = readJson(`drizzle/meta/${prefix}_snapshot.json`);
        const tag = `${next}_synthetic-forward-migration`;
        journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag });
        writeFileSync(join(scratch, `drizzle/${tag}.sql`), "SELECT 1;\n");
        writeFileSync(
          join(scratch, `drizzle/meta/${next}_snapshot.json`),
          JSON.stringify({
            ...latest,
            id: randomUUID(),
            prevId: latest.id,
          }),
        );
        writeFileSync(join(scratch, "drizzle/meta/_journal.json"), JSON.stringify(journal));
      }
      const tags = journal.entries.map((entry: { tag: string }) => entry.tag);
      expect(tags).toEqual(
        expect.arrayContaining(["1013_hot-path-indexes", "1014_event-ics-sequence"]),
      );
      expect(tags.indexOf("1013_hot-path-indexes")).toBeLessThan(
        tags.indexOf("1014_event-ics-sequence"),
      );
      const before = readdirSync(join(scratch, "drizzle"));
      // drizzle-kit can exit 0 after serialization failures: assert output and files too.
      const output = execFileSync(
        process.execPath,
        [join(root, "node_modules/drizzle-kit/bin.cjs"), "generate"],
        {
          cwd: scratch,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(output).toContain("No schema changes, nothing to migrate");
      expect(readdirSync(join(scratch, "drizzle"))).toEqual(before);
      expect(JSON.parse(readFileSync(join(scratch, "drizzle/meta/_journal.json"), "utf8"))).toEqual(
        journal,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  15_000,
);
