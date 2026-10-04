// canonicalEventKey: direct unit pin of the helper's contract. ULIDs are
// stored uppercase, so a key in any other letter case canonicalizes to the
// uppercase form; seed/demo keys, garbage, empty and encoded/padded inputs
// return null and keep their current path. Route-level 301 behavior is pinned
// separately in test/events-key-canonical.test.ts.
import { describe, expect, it } from "vitest";
import { canonicalEventKey } from "../src/events/keys";

// Allowlisted synthetic fixture ULID only (see .gitleaks.toml).
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("canonicalEventKey", () => {
  it("uppercases a lowercase ULID", () => {
    expect(canonicalEventKey(KEY.toLowerCase())).toBe(KEY);
  });

  it("returns an already-canonical ULID unchanged", () => {
    expect(canonicalEventKey(KEY)).toBe(KEY);
  });

  it("uppercases a mixed-case ULID", () => {
    const mixed = `${KEY.slice(0, 13).toLowerCase()}${KEY.slice(13)}`;
    expect(canonicalEventKey(mixed)).toBe(KEY);
  });

  it("returns null for seed/demo keys", () => {
    for (const key of ["seed-calendar-01", "seed-calendar-50"]) {
      expect(canonicalEventKey(key), key).toBeNull();
    }
  });

  it("returns null for non-ULID garbage and empty input", () => {
    for (const key of ["", "not-a-ulid", KEY.slice(0, 25), `${KEY}X`, `${KEY.slice(0, -1)}I`]) {
      expect(canonicalEventKey(key), key).toBeNull();
    }
  });

  it("returns null for encoded or padded inputs", () => {
    for (const key of [` ${KEY} `, `${KEY}\n`, `${KEY.slice(0, -1)}%56`]) {
      expect(canonicalEventKey(key), JSON.stringify(key)).toBeNull();
    }
  });
});
