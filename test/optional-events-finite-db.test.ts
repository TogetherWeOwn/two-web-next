// Finite-before-LIMIT proof on a uniquely owned synthetic schema (agent-testdb or CI service only).
import { describe, expect, it } from "vitest";
import { listHomeUpcoming } from "../src/events/reads";
import { notFoundSuggestions } from "../src/events/suggestions";
import type { EnvWithAdminDb } from "../src/admin/db";
import { createMemberDataFixture, testDatabaseUrl } from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;
const url = raw ? testDatabaseUrl(raw).href : undefined;
const now = new Date("2069-01-01T00:00:00Z");

describe.skipIf(!url)(
  "optional event reads exclude nonfinite starts before LIMIT (isolated test DB)",
  () => {
    async function seed(
      client: Awaited<ReturnType<typeof createMemberDataFixture>>["client"],
      valid: number,
    ) {
      await client`insert into events (event_key, title, starts_at, ends_at, status) values
      ('neg-inf', 'Negative infinity', '-infinity', '2070-01-01T00:00:00Z', 'published'),
      ('pos-inf', 'Positive infinity', 'infinity', 'infinity', 'published')`;
      for (let i = 1; i <= valid; i++) {
        await client`insert into events (event_key, title, starts_at, ends_at, status)
        values (${`ok-${i}`}, ${`Finite ${i}`}, ${`2069-02-0${i}T18:00:00Z`}, ${`2069-02-0${i}T20:00:00Z`}, 'published')`;
      }
    }

    it("refills homepage and 404 slots from later finite rows", async () => {
      const { client, db, dispose } = await createMemberDataFixture(url!);
      try {
        await seed(client, 4);
        const home = await listHomeUpcoming(db, now);
        expect(home.map((e) => e.eventKey)).toEqual(["ok-1", "ok-2", "ok-3"]);
        const found = await notFoundSuggestions({ ADMIN_DB: db } as unknown as EnvWithAdminDb, now);
        expect(found.map((e) => e.key)).toEqual(["ok-1", "ok-2", "ok-3"]);
        for (const e of [...home, ...found])
          expect(Number.isFinite(e.startsAt.getTime())).toBe(true);
      } finally {
        await dispose();
      }
    });

    it("returns empty when every eligible row is nonfinite", async () => {
      const { client, db, dispose } = await createMemberDataFixture(url!);
      try {
        await seed(client, 0);
        expect(await listHomeUpcoming(db, now)).toEqual([]);
        expect(
          await notFoundSuggestions({ ADMIN_DB: db } as unknown as EnvWithAdminDb, now),
        ).toEqual([]);
      } finally {
        await dispose();
      }
    });
  },
);
