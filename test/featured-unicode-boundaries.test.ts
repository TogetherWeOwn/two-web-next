import { describe, expect, it } from "vitest";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";

const base = {
  title: "Game night",
  image_url: "https://cdn.discordapp.com/photo.png",
  image_alt: "Players together",
};
const fields = [
  { input: "title", output: "title", error: "Keep the headline to 255 characters." },
  { input: "image_alt", output: "imageAlt", error: "Keep the alt text to 255 characters." },
] as const;
const characters = [
  { label: "ASCII", pattern: ["x"] },
  { label: "BMP", pattern: ["界"] },
  { label: "astral", pattern: ["😀"] },
  { label: "mixed astral/BMP/ASCII", pattern: ["😀", "界", "x"] },
];

function text(pattern: string[], count: number): string {
  return Array.from({ length: count }, (_, i) => pattern[i % pattern.length]).join("");
}

function errors(data: Record<string, unknown>): Record<string, string> {
  try {
    parseFeaturedForm(data);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("Expected featured validation to fail");
}

// Server limits count Unicode code points, not UTF-16 units or graphemes.
// Native HTML maxlength and browser editor parity are outside this contract.
describe("featured Unicode boundaries", () => {
  for (const { input, output, error } of fields) {
    describe(input, () => {
      it.each(characters)("accepts exactly 255 $label code points", ({ pattern }) => {
        const value = text(pattern, 255);
        expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
      });
      it.each(characters)(
        "rejects 256 $label code points with the existing field error",
        ({ pattern }) => {
          expect(errors({ ...base, [input]: text(pattern, 256) })).toEqual({ [input]: error });
        },
      );
      it("accepts the reported 128 astral characters", () => {
        const value = "😀".repeat(128);
        expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
      });
      it("measures after trimming, without truncating overlong input", () => {
        const value = "😀".repeat(255);
        expect(parseFeaturedForm({ ...base, [input]: ` \t${value}\r\n ` })[output]).toBe(value);
        expect(errors({ ...base, [input]: ` \t${value}x\r\n ` })).toEqual({ [input]: error });
      });
      it.each([
        { label: "combining marks", value: "é".repeat(127) + "x" },
        { label: "emoji joiners", value: "👩‍💻".repeat(85) },
      ])("counts $label as separate code points", ({ value }) => {
        expect([...value]).toHaveLength(255);
        expect(parseFeaturedForm({ ...base, [input]: value })[output]).toBe(value);
        expect(errors({ ...base, [input]: value + "x" })).toEqual({ [input]: error });
      });
    });
  }

  it("retains headline and image-description requiredness", () => {
    expect(errors({ ...base, title: " \t " })).toEqual({ title: "Give it a headline." });
    expect(errors({ ...base, image_alt: " \r\n " })).toEqual({
      image_alt: "Describe the photo in one plain sentence for screen-reader visitors.",
    });
    expect(errors({ ...base, title: "😀".repeat(256), image_alt: "😀".repeat(256) })).toEqual({
      title: fields[0].error,
      image_alt: fields[1].error,
    });
  });

  it("keeps optional text null and other featured fields unchanged", () => {
    expect(
      parseFeaturedForm({
        title: " Game night ",
        body: " \n ",
        url: " http://example.com ",
        image_url: " ",
        image_alt: " \t ",
        position: "2",
        is_published: "on",
        starts_at: "2030-01-01 18:00",
        ends_at: "2030-01-01 19:00",
      }),
    ).toEqual({
      title: "Game night",
      body: null,
      url: "http://example.com",
      imageUrl: null,
      imageAlt: null,
      position: 2,
      isPublished: true,
      startsAtUtc: new Date("2030-01-01T18:00:00Z"),
      endsAtUtc: new Date("2030-01-01T19:00:00Z"),
      startsAtUtcText: "2030-01-01T18:00:00.000000Z",
      endsAtUtcText: "2030-01-01T19:00:00.000000Z",
    });
  });

  it("still validates URLs alongside a valid boundary headline", () => {
    expect(errors({ ...base, title: "😀".repeat(255), url: "javascript:alert(1)" })).toEqual({
      url: "Link is a full http(s) URL, or empty for no link.",
    });
    expect(
      errors({
        ...base,
        image_alt: "😀".repeat(255),
        image_url: "http://cdn.discordapp.com/photo.png",
      }),
    ).toEqual({
      image_url:
        "Image URL must be HTTPS on an approved public host, without credentials or a custom port (255 characters maximum).",
    });
  });
});
