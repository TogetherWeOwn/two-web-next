// safeNext's byte cap (src/join/service.ts): the surviving return destination
// lands in a Location header and a signed cookie, so it is bounded in UTF-8
// bytes, not characters.
import { describe, expect, it } from "vitest";
import { MAX_RETURN_DESTINATION_BYTES, safeNext } from "../src/join/service";

describe("safeNext byte cap", () => {
  it("keeps a path of exactly the cap and refuses one byte more", () => {
    const atCap = `/${"a".repeat(MAX_RETURN_DESTINATION_BYTES - 1)}`;
    expect(safeNext(atCap)).toBe(atCap);
    expect(safeNext(`${atCap}a`)).toBeNull();
  });

  it("measures bytes, not characters", () => {
    // Two bytes per "é": under the cap in characters, over it in bytes.
    const wide = `/${"é".repeat(MAX_RETURN_DESTINATION_BYTES / 2)}`;
    expect(wide.length).toBeLessThan(MAX_RETURN_DESTINATION_BYTES);
    expect(safeNext(wide)).toBeNull();
    const fits = `/${"é".repeat(MAX_RETURN_DESTINATION_BYTES / 2 - 1)}a`;
    expect(new TextEncoder().encode(fits).byteLength).toBe(MAX_RETURN_DESTINATION_BYTES);
    expect(safeNext(fits)).toBe(fits);
  });
});
