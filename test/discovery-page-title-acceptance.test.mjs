import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TITLE_SUFFIX,
  compileTitleRenderers,
  titleFixture,
  titleMetadata,
  titleVectors,
} from "./helpers/discovery-page-title-acceptance.mjs";

let renderTitle;
const rendered = new Map();

// Decode serialized text only; the paired Playwright suite asserts the real
// browser DOM, including the title-closing injection, against these same vectors.
function text(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity.startsWith("#")) {
      return String.fromCodePoint(
        Number.parseInt(entity.slice(entity[1] === "x" ? 2 : 1), entity[1] === "x" ? 16 : 10),
      );
    }
    return entities[entity];
  });
}

beforeAll(async () => {
  vi.stubGlobal("fetch", () => {
    throw new Error("Discovery title renders must not access the network");
  });
  renderTitle = await compileTitleRenderers();
  for (const twin of ["Hono", "Kit"]) {
    for (const vector of titleVectors) {
      rendered.set(
        `${twin}:${vector.name}`,
        await renderTitle(twin, vector.kind, titleFixture(vector)),
      );
    }
  }
});
afterAll(() => vi.unstubAllGlobals());

for (const twin of ["Hono", "Kit"]) {
  describe(`${twin} discovery page titles`, () => {
    it.each(titleVectors)("orients tabs/history for $name", (vector) => {
      const html = rendered.get(`${twin}:${vector.name}`);
      const titles = [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)];
      expect(titles).toHaveLength(1);
      expect(titles[0][1]).not.toContain("<");
      const actual = text(titles[0][1]);
      expect(actual).toBe(`${vector.title}${TITLE_SUFFIX}`);
      expect(Array.from(actual.slice(0, -TITLE_SUFFIX.length)).length).toBeLessThanOrEqual(70);
    });

    it.each(titleVectors)("preserves canonical and robots for $name", (vector) => {
      const html = rendered.get(`${twin}:${vector.name}`);
      const expected = titleMetadata(vector);
      const canonical = [...html.matchAll(/<link\b[^>]*rel="canonical"[^>]*href="([^"]*)"/g)].map(
        (match) => text(match[1]),
      );
      const robots = [...html.matchAll(/<meta\b[^>]*name="robots"[^>]*content="([^"]*)"/g)].map(
        (match) => text(match[1]),
      );
      expect(canonical).toEqual([expected.canonical]);
      expect(robots).toEqual(expected.robots === null ? [] : [expected.robots]);
    });
  });
}

describe("shared pinned title vectors", () => {
  it.each(titleVectors)("keeps both renderers identical for $name", (vector) => {
    const titles = ["Hono", "Kit"].map((twin) =>
      text(rendered.get(`${twin}:${vector.name}`).match(/<title>([\s\S]*?)<\/title>/)[1]),
    );
    expect(titles[0]).toBe(titles[1]);
  });
});
