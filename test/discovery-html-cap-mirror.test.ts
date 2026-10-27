// The island sources are standalone scripts, so the finite HTML cap is mirrored
// as a literal in each. Pin both mirrors to the one contract constant.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DISCOVERY_HTML_MAX_BYTES } from "../src/islands/contracts";

describe("discovery HTML byte cap mirrors", () => {
  it.each(["events-calendar", "past-events"])("%s mirrors the contract constant", (island) => {
    const source = readFileSync(`assets/islands/${island}.js`, "utf8");
    const literals = [...source.matchAll(/var HTML_MAX_BYTES = (\d+);/g)].map((m) => Number(m[1]));
    expect(literals).toEqual([DISCOVERY_HTML_MAX_BYTES]);
  });

  it("is a finite cap above the largest measured page and below the 4 MiB ceiling", () => {
    expect(DISCOVERY_HTML_MAX_BYTES).toBeGreaterThan(177_177);
    expect(DISCOVERY_HTML_MAX_BYTES).toBeLessThanOrEqual(4_194_304);
  });
});

// The body-less compatibility path buffers with text() and then bounds the
// parse by UTF-8 bytes (not characters) against the same cap. Run each island's
// shipped readHtml source against a response with no body stream.
function shippedReadHtml(island: string): (response: unknown, signal: unknown) => Promise<string> {
  const source = readFileSync(`assets/islands/${island}.js`, "utf8");
  const slice = source.match(/var HTML_MAX_BYTES[\s\S]*?\n {2}\}\n/)?.[0];
  if (!slice) throw new Error(`readHtml not found in ${island}`);
  return new Function(`${slice}\nreturn readHtml;`)();
}

describe.each(["events-calendar", "past-events"])("%s body-less fallback byte cap", (island) => {
  const cap = DISCOVERY_HTML_MAX_BYTES;
  const read = shippedReadHtml(island);
  const bodyless = (html: string) => ({ text: async () => html });
  const signal = { aborted: false };

  it("commits a body of exactly cap UTF-8 bytes made of 2-byte characters", async () => {
    const html = "é".repeat(cap / 2);
    expect(new TextEncoder().encode(html).byteLength).toBe(cap);
    expect(html.length).toBeLessThan(cap);
    await expect(read(bodyless(html), signal)).resolves.toBe(html);
  });

  it("rejects a body of at most cap characters but more than cap UTF-8 bytes", async () => {
    const html = "é".repeat(cap / 2 + 1);
    expect(html.length).toBeLessThanOrEqual(cap);
    expect(new TextEncoder().encode(html).byteLength).toBeGreaterThan(cap);
    await expect(read(bodyless(html), signal)).rejects.toThrow("HTML too large");
  });

  it("accepts cap ASCII bytes and rejects cap + 1", async () => {
    await expect(read(bodyless("a".repeat(cap)), signal)).resolves.toHaveLength(cap);
    await expect(read(bodyless("a".repeat(cap + 1)), signal)).rejects.toThrow("HTML too large");
  });
});
