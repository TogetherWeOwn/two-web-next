import { describe, expect, it } from "vitest";
import { explicitMethodRefusal } from "../src/http/method";

describe("explicit method refusal policy", () => {
  it.each([
    ["Origin, Cookie", "Origin, Cookie, Accept"],
    ["Origin, aCcEpT, Cookie", "Origin, aCcEpT, Cookie"],
  ])("preserves existing Vary dimensions: %s", (vary, expected) => {
    expect(explicitMethodRefusal({ allow: "PUT, DELETE", accept: null, vary }).headers.Vary).toBe(
      expected,
    );
  });

  it("keeps exact JSON media-range detection instead of weighted negotiation", () => {
    expect(
      explicitMethodRefusal({
        allow: "PUT, DELETE",
        accept: "text/html, application/json;q=0",
        vary: null,
      }).error,
    ).toBe("method_not_allowed");
  });
});
