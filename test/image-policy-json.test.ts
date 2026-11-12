import { describe, expect, it } from "vitest";
import { imageHosts, isFeaturedImageUrl } from "../src/image-policy";

const unsupportedHosts: unknown[] = [
  null,
  [],
  ["images.unsplash.com"],
  {},
  { toString: null },
  42,
  true,
  false,
];

describe("JSON-valued featured image host configuration", () => {
  it.each(unsupportedHosts.map((value) => ({ value })))(
    "ignores unsupported host binding $value without admitting coerced hosts",
    ({ value }) => {
      // Wrangler JSON bindings can reach this string-typed field at runtime.
      const raw = value as string;
      expect(imageHosts(raw)).toEqual(["cdn.discordapp.com"]);
      expect(isFeaturedImageUrl("https://images.unsplash.com/cover.jpg", raw)).toBe(false);
      expect(isFeaturedImageUrl("https://cdn.discordapp.com/cover.jpg", raw)).toBe(true);
    },
  );

  it("retains exact host normalization, deduplication and refusals for strings", () => {
    expect(
      imageHosts(
        " Images.Unsplash.com ,images.unsplash.com,*.evil.com,localhost,10.0.0.1,evil.com;script-src *",
      ),
    ).toEqual(["cdn.discordapp.com", "images.unsplash.com"]);
    expect(imageHosts()).toEqual(["cdn.discordapp.com"]);
    expect(imageHosts("")).toEqual(["cdn.discordapp.com"]);
  });
});
