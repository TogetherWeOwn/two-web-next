// Independent neighboring pins: each byte bound and canonicality decision must
// fail on its own mutant, not because another oversized field masks the break.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backHref,
  compileInvestigationKit,
  detailHref,
  investigationDocument,
  listPath,
  recorded,
  twins,
} from "./helpers/join-investigation";

let kit: Awaited<ReturnType<typeof compileInvestigationKit>>;
beforeAll(async () => {
  kit = await compileInvestigationKit();
});
afterAll(() => kit?.dispose());

// Literal UTF-8 fixtures, independent of the product's limit/helper. The mixed
// cases distinguish bytes from JS length and code points on both sides of 256.
const outcomes = [
  { name: "ASCII 256", value: "a".repeat(256), bytes: 256, accepted: true },
  { name: "ASCII 257", value: "a".repeat(257), bytes: 257, accepted: false },
  { name: "multibyte 256", value: "界".repeat(85) + "a", bytes: 256, accepted: true },
  { name: "multibyte 257", value: "界".repeat(85) + "ab", bytes: 257, accepted: false },
];

for (const twin of twins) {
  const render = (path: string) => investigationDocument(kit, twin, path, [recorded]);
  describe(`${twin}: independent investigation context boundaries`, () => {
    it.each(outcomes)(
      "outgoing $name: bound navigation, not the list/storage filter",
      async (row) => {
        expect(Buffer.byteLength(row.value, "utf8")).toBe(row.bytes);
        const page = await render(
          `${listPath}?${new URLSearchParams({ outcome: row.value, q: "exact", page: "2" })}`,
        );
        expect(page.status).toBe(200);
        expect(page.headers["cache-control"]).toBe("private, no-store");
        const reads = page.statements.filter((statement) =>
          statement.sql.includes('from "join_attempts"'),
        );
        expect(reads).toHaveLength(1);
        expect(reads[0]!.params).toContain(row.value);
        const href = detailHref(page.html);
        const url = new URL(href, "https://example.test");
        expect(url.pathname).toBe("/admin/join-attempts/7");
        if (row.accepted) {
          expect([...url.searchParams]).toEqual([
            ["from_outcome", row.value],
            ["from_q", "exact"],
            ["from_page", "2"],
          ]);
        } else {
          expect(href).toBe("/admin/join-attempts/7");
          expect(url.search).toBe("");
        }
      },
    );

    // Request detail directly: no list normalization and no outgoing guard can
    // hide a missing incoming cap. Even encoded multibyte cases stay below 4096.
    it.each(outcomes)("incoming $name: exact accepted return or bare refusal", async (row) => {
      expect(Buffer.byteLength(row.value, "utf8")).toBe(row.bytes);
      const search = `?${new URLSearchParams({ from_outcome: row.value, from_q: "exact", from_page: "2" })}`;
      expect(Buffer.byteLength(search, "utf8")).toBeLessThan(4096);
      const detail = await render(`${listPath}/7${search}`);
      expect(detail.status).toBe(200);
      expect(detail.headers["cache-control"]).toBe("private, no-store");
      expect(backHref(detail.html)).toBe(
        row.accepted
          ? `/admin/join-attempts?page=2&outcome=${encodeURIComponent(row.value)}&q=exact`
          : "/admin/join-attempts",
      );
    });

    // Only ignored padding grows. Every recognized field is short and valid,
    // so deleting the raw-search guard cannot be masked by an outcome/q cap.
    it.each([
      { bytes: 4096, accepted: true },
      { bytes: 4097, accepted: false },
    ])("incoming raw url.search $bytes bytes has an independent bound", async (row) => {
      const prefix = "?from_outcome=error&from_q=exact&from_page=2&ignored=";
      // %61 is one decoded character but three serialized bytes. An assertion
      // on decoded values would accept the 4097-byte attack incorrectly.
      const remaining = row.bytes - Buffer.byteLength(prefix, "utf8");
      const search = prefix + "%61".repeat(Math.floor(remaining / 3)) + "a".repeat(remaining % 3);
      const wireUrl = new URL(`${listPath}/7${search}`, "https://example.test");
      expect(wireUrl.search).toBe(search);
      expect(Buffer.byteLength(wireUrl.search, "utf8")).toBe(row.bytes);
      expect(wireUrl.searchParams.get("from_outcome")).toBe("error");
      expect(wireUrl.searchParams.get("from_q")).toBe("exact");
      expect(wireUrl.searchParams.get("from_page")).toBe("2");
      expect(Buffer.byteLength(wireUrl.searchParams.get("ignored")!, "utf8")).toBeLessThan(1400);
      const detail = await render(wireUrl.pathname + wireUrl.search);
      expect(detail.status).toBe(200);
      expect(backHref(detail.html)).toBe(
        row.accepted ? "/admin/join-attempts?page=2&outcome=error&q=exact" : "/admin/join-attempts",
      );
    });

    it("direct embedded-NUL outcome context refuses rather than silently normalizing", async () => {
      const detail = await render(
        "/admin/join-attempts/7?from_outcome=er%00ror&from_q=exact&from_page=2",
      );
      expect(detail.status).toBe(200);
      expect(backHref(detail.html)).toBe("/admin/join-attempts");
    });

    it("list-side embedded NUL still normalizes and carries the canonical positive control", async () => {
      const list = await render("/admin/join-attempts?outcome=er%00ror&q=exact&page=2");
      expect(list.status).toBe(200);
      const reads = list.statements.filter((statement) =>
        statement.sql.includes('from "join_attempts"'),
      );
      expect(reads).toHaveLength(1);
      expect(reads[0]!.params).toContain("error");
      const href = detailHref(list.html);
      expect(href).toBe("/admin/join-attempts/7?from_outcome=error&from_q=exact&from_page=2");
      expect(backHref((await render(href)).html)).toBe(
        "/admin/join-attempts?page=2&outcome=error&q=exact",
      );
    });
  });
}
