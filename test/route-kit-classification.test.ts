import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const map = JSON.parse(
  readFileSync(new URL("./fixtures/route-kit-map.json", import.meta.url), "utf8"),
);

describe("Kit route classification", () => {
  it("keeps the legacy Discord login redirect with the OAuth family", () => {
    const rows = map.rows.filter(
      (row: { method: string; path: string }) =>
        row.method === "GET" && row.path === "/auth/discord/redirect",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "api", slice: "API-6", family: "auth" });
  });
});
