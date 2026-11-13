import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { rewriteFixtureHtml } from "../e2e/rewrite-fixture-html";
import { decodeWireBody } from "./fixtures/decode-wire-body";

describe("gzip-aware fixture clients", () => {
  it("decodes raw gzip bytes and preserves identity and empty bodies", () => {
    const plain = Buffer.from("hello");
    const headers: [string, string][] = [["Content-Encoding", "gzip"]];
    const compressed = gzipSync(plain);
    expect(decodeWireBody([compressed.subarray(0, 3), compressed.subarray(3)], headers)).toEqual(
      plain,
    );
    expect(headers).toEqual([["Content-Encoding", "gzip"]]);
    expect(decodeWireBody([plain], [])).toEqual(plain);
    expect(decodeWireBody([], headers)).toBeNull();
    expect(() => decodeWireBody([plain], headers)).toThrow();
  });

  it.each(["identity", "gzip"])("rewrites %s HTML as identity", async (encoding) => {
    const html = '<a href="https://example.test/events">Events</a>';
    const body = encoding === "gzip" ? gzipSync(html) : Buffer.from(html);
    const headers = new Headers({
      "content-type": "text/html",
      "content-length": "12",
      etag: '"old"',
    });
    if (encoding === "gzip") headers.set("content-encoding", "gzip");
    const response = await rewriteFixtureHtml(
      new Response(body, { status: 201, headers }),
      "https://example.test",
      "https://fixture.test",
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.text()).toBe('<a href="https://fixture.test/events">Events</a>');
  });
});
