// Implementation-owned pin: NUL (U+0000) in the featured form's `url`
// field is rejected by the shared featured-form validator with a field
// error on `url` only, before anything is persisted. The acceptance oracle
// (test/admin-featured-nul-rejection.test.ts) pins title, body and
// image_alt; this file pins `url`, which `new URL()` would otherwise
// percent-encode and let through as a valid http(s) link. Postgres text
// cannot represent NUL, so a NUL that passes validation only fails later
// as a persistence error instead of the form's field-level 422.
//
// Contract mirrors the oracle: only the field-error key is pinned; the
// exact message wording is the implementer's choice (asserted non-empty,
// never matched literally).
import { describe, expect, it } from "vitest";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";

const NUL = "\u0000";

const base = {
  title: "Game night",
  body: "Bring a friend",
  image_url: "https://cdn.discordapp.com/photo.png",
  image_alt: "Players together",
};

function errors(data: Record<string, unknown>): Record<string, string> {
  try {
    parseFeaturedForm(data);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("Expected featured validation to fail");
}

function expectOnlyFieldError(data: Record<string, unknown>, field: string): void {
  const fields = errors(data);
  expect(Object.keys(fields)).toEqual([field]);
  expect(typeof fields[field]).toBe("string");
  expect(fields[field]!.length).toBeGreaterThan(0);
}

describe("featured form rejects NUL in url before persistence (validator)", () => {
  it.each([
    { label: "embedded", value: `https://example.com/before${NUL}after` },
    { label: "leading", value: `${NUL}https://example.com/evening` },
    { label: "trailing", value: `https://example.com/evening${NUL}` },
    { label: "NUL only", value: NUL },
    { label: "repeated", value: `https://example.com/a${NUL}b${NUL}c` },
  ])("rejects a $label NUL with a field error on url only", ({ value }) => {
    expectOnlyFieldError({ ...base, url: value }, "url");
  });

  it("reports url alongside other offending fields when several carry NUL", () => {
    const fields = errors({
      ...base,
      title: `before${NUL}after`,
      url: `https://example.com/before${NUL}after`,
    });
    expect(Object.keys(fields).sort()).toEqual(["title", "url"]);
    for (const message of Object.values(fields)) expect(message.length).toBeGreaterThan(0);
  });
});

describe("featured form url controls (validator)", () => {
  it("accepts a clean https URL verbatim", () => {
    const url = "https://example.com/events/game-night";
    expect(parseFeaturedForm({ ...base, url }).url).toBe(url);
  });

  it("keeps optional-empty behaviour: missing or blank url stays null", () => {
    expect(parseFeaturedForm({ ...base }).url).toBeNull();
    expect(parseFeaturedForm({ ...base, url: "" }).url).toBeNull();
  });
});
