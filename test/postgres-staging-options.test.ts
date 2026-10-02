import { expect, it } from "vitest";
import postgres from "postgres";
import { query } from "../spike/hyperdrive-semantics/staging-checks";

it("forces extended prepared execution in the real lazy driver without connecting", async () => {
  const sql = postgres({ host: "unused.invalid", fetch_types: false, prepare: true });
  try {
    for (const parameters of [[], [1]]) {
      const pending = query(sql, parameters.length ? "SELECT $1" : "SELECT 1", parameters);
      // Lazy Query objects expose the effective wire-protocol options; never await.
      expect((pending as unknown as { options: unknown }).options).toMatchObject({
        prepare: true,
        simple: false,
      });
    }
  } finally {
    await sql.end({ timeout: 0 });
  }
});
