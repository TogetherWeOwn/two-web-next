import { describe, expect, it } from "vitest";
import {
  exceedsByteLimit,
  exceedsCodePointLimit,
  exceedsCodeUnitLimit,
  exceedsUtf8ByteLimit,
  fitsUtf8ByteLimit,
} from "../src/http/length-limit";

describe("inclusive length limits", () => {
  it("accepts accumulated bytes at the cap and rejects one more byte", () => {
    expect(exceedsByteLimit(8, 8)).toBe(false);
    expect(exceedsByteLimit(9, 8)).toBe(true);
  });

  it("counts UTF-8 bytes for multibyte and astral text", () => {
    expect(exceedsUtf8ByteLimit("é😀", 6)).toBe(false);
    expect(exceedsUtf8ByteLimit("é😀x", 6)).toBe(true);
    expect(fitsUtf8ByteLimit("é😀", 6)).toBe(true);
    expect(fitsUtf8ByteLimit("é😀x", 6)).toBe(false);
  });

  it("counts an unpaired surrogate as the UTF-8 replacement character", () => {
    expect(exceedsUtf8ByteLimit("\uD800", 3)).toBe(false);
    expect(exceedsUtf8ByteLimit("\uD800x", 3)).toBe(true);
  });

  it("counts UTF-16 code units for text fields that use String.length", () => {
    expect(exceedsCodeUnitLimit("é😀", 3)).toBe(false);
    expect(exceedsCodeUnitLimit("é😀x", 3)).toBe(true);
  });

  it("counts code points for text fields that use string iteration", () => {
    expect(exceedsCodePointLimit("é😀", 2)).toBe(false);
    expect(exceedsCodePointLimit("é😀x", 2)).toBe(true);
  });

  it("preserves comparison direction for a nonnumeric ceiling or measured size", () => {
    expect(exceedsByteLimit(Number.NaN, 6)).toBe(false);
    expect(exceedsUtf8ByteLimit("é😀", Number.NaN)).toBe(false);
    expect(fitsUtf8ByteLimit("é😀", Number.NaN)).toBe(false);
  });
});
