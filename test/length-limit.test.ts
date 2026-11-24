import { describe, expect, it } from "vitest";
import { limitRequestBody } from "../src/http/body-limit";
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

it("caps a Fetch request body when a multibyte character spans two chunks", async () => {
  const actionCap = 4096;
  const atLimit = `${"x".repeat(actionCap - 4)}😀`;
  const bytes = new TextEncoder().encode(atLimit);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, actionCap - 2));
      controller.enqueue(bytes.subarray(actionCap - 2));
      controller.close();
    },
  });
  const upload = (body: RequestInit["body"]) =>
    new Request("https://example.test/", { method: "POST", body, duplex: "half" } as RequestInit);
  const accepted = await limitRequestBody(upload(stream), "action");
  expect(accepted.ok).toBe(true);
  if (accepted.ok) expect(await accepted.request.text()).toBe(atLimit);
  expect(await limitRequestBody(upload(`${atLimit}x`), "action")).toEqual({
    ok: false,
    status: 413,
  });
});
