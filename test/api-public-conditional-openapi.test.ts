import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getOpenApiDocument } from "../src/public-data/openapi";

const doc = getOpenApiDocument("https://togetherweown.com");

describe("public conditional-read documentation", () => {
  it("describes validators and bodyless 304 responses on every public operation", () => {
    for (const operation of Object.values(doc.paths)) {
      const { parameters, responses } = operation.get;
      expect(parameters).toContainEqual(
        expect.objectContaining({ name: "If-None-Match", in: "header", required: false }),
      );
      expect(responses["200"].headers).toHaveProperty("ETag");
      expect(responses["200"].headers).toHaveProperty("Cache-Control");
      expect(responses["304"].headers).toHaveProperty("ETag");
      expect(responses["304"].headers).toHaveProperty("Cache-Control");
      expect(responses["304"]).not.toHaveProperty("content");
      expect(responses).toHaveProperty("429");
    }
    expect(Object.keys(doc.paths)).toEqual([
      "/api/public/events",
      "/api/public/events/{key}",
      "/api/public/community",
      "/api/public/join",
    ]);
  });

  it("distinguishes admission and discovery-document revalidation", () => {
    const guide = readFileSync(new URL("../docs/machine-interface.md", import.meta.url), "utf8");
    expect(guide).toContain("rate limit still apply before a `304`");
    expect(guide).toContain("`GET /openapi.json` also supports ETag revalidation");
    expect(guide).toContain("independently of the four");
    expect(guide).toContain("remaining");
    expect(guide).toContain("max-age=0, must-revalidate");
  });
});
