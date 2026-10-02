import { describe, expect, it } from "vitest";
import { safeNext } from "../src/join/service";

// TOG-12442: pin safeNext control-byte rejection. A surviving value lands in
// the callback Location header where Headers.set throws on control bytes and
// turns login into a 500, so NUL/C0 controls and DEL must all be rejected
// while ordinary same-origin paths still pass. DB-free.
describe("safeNext control-byte rejection", () => {
  it.each([0, 1, 31, 127])("rejects control code %j in path", (code) => {
    expect(safeNext(`/events${String.fromCharCode(code)}`)).toBeNull();
  });

  it("rejects tab and newline inside the path", () => {
    expect(safeNext("/events\tx")).toBeNull();
    expect(safeNext("/events\nx")).toBeNull();
    expect(safeNext("/events\rx")).toBeNull();
  });

  it("still passes an ordinary same-origin path with a query", () => {
    expect(safeNext("/events?x=1")).toBe("/events?x=1");
  });
});
