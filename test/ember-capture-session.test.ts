import { describe, expect, it, vi } from "vitest";
import { hashToken, type Sql } from "../src/sessions";
import { verifyCaptureSession } from "./helpers/ember-capture-session";

// A different canonical TTL detects a copied two-hour literal in the verifier.
vi.mock("../src/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sessions")>()),
  SESSION_TTL_SECONDS: 37,
}));

const token = "synthetic-verification-token-only";
const processNow = Date.parse("2098-12-31T20:00:00Z");
const valid = {
  member: true,
  moderator: false,
  unexpired: true,
  young: true,
  bounded: true,
};

describe("capture session SQL verification", () => {
  it("binds the minting process clock plus the canonical TTL in the actual verification query", async () => {
    const sql = vi.fn().mockResolvedValue([valid]);
    await verifyCaptureSession(sql as unknown as Sql, token, "member", processNow);
    const [parts, expiryUpperBound, tokenHash] = sql.mock.calls[0]!;
    expect(parts.join("?")).toContain("expires_at <= ?::timestamptz as bounded");
    expect(parts.join("?")).toContain("expires_at > now() as unexpired");
    expect(parts.join("?")).toContain("created_at > now() - interval '24 hours' as young");
    expect(expiryUpperBound).toBe("2098-12-31T20:00:37.000Z");
    expect(tokenHash).toBe(await hashToken(token));
  });

  it("requires exactly one row with the correct role and every clock predicate", async () => {
    for (const rows of [
      [],
      [valid, valid],
      ...Object.keys(valid).map((key) => [{ ...valid, [key]: !valid[key as keyof typeof valid] }]),
    ]) {
      const sql = vi.fn().mockResolvedValue(rows);
      await expect(
        verifyCaptureSession(sql as unknown as Sql, token, "member", processNow),
      ).rejects.toThrow();
    }
  });

  it("requires moderator membership as well as the moderator bit", async () => {
    const sql = vi.fn().mockResolvedValue([{ ...valid, moderator: true }]);
    await expect(
      verifyCaptureSession(sql as unknown as Sql, token, "moderator", processNow),
    ).resolves.toBeUndefined();
    sql.mockResolvedValue([{ ...valid, member: false, moderator: true }]);
    await expect(
      verifyCaptureSession(sql as unknown as Sql, token, "moderator", processNow),
    ).rejects.toThrow();
  });
});
