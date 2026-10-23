// Exercise the exported preview oracle against actual Hono route/Kit load+SSR
// output. No handwritten populated fixture can hide stale link serialization.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileInvestigationKit,
  detailHref,
  investigationDocument,
  recorded,
  twins,
} from "./helpers/join-investigation";

let kit: Awaited<ReturnType<typeof compileInvestigationKit>>;
let assertJoinAttemptsContract: (input: {
  label: string;
  html: string;
  headers: Record<string, string>;
  status: number;
  expected: { status: number; marker: string | null };
}) => string[];
beforeAll(async () => {
  kit = await compileInvestigationKit();
  // Dynamic URL import keeps this JS CLI's public API executable without adding
  // a production declaration/shim or suppressing the TypeScript checker.
  ({ assertJoinAttemptsContract } = await import(
    new URL("../ci/kit-parity-gates.mjs", import.meta.url).href
  ));
});
afterAll(() => kit?.dispose());

const structuredPath = "/admin/join-attempts?outcome=error&q=request%3Afixture-7&page=2";
const missingRows = "attempt rows or empty state present";

for (const twin of twins) {
  const render = (rows = [recorded]) => investigationDocument(kit, twin, structuredPath, rows);
  const oracle = (page: Awaited<ReturnType<typeof render>>) =>
    assertJoinAttemptsContract({
      ...page,
      label: twin,
      // The real Kit load/SSR seam does not run framework response hooks.
      // Supply only their transport metadata; leave actual rendered HTML and
      // the real load's private/no-store header untouched.
      headers: {
        "content-type": "text/html; charset=UTF-8",
        ...(twin === "Kit" ? { "x-two-renderer": "kit" } : {}),
        ...page.headers,
      },
      expected: { status: 200, marker: twin === "Kit" ? "kit" : null },
    });

  describe(`${twin}: preview join-attempts oracle on real renders`, () => {
    it("accepts populated real output with structured detail context", async () => {
      const page = await render();
      expect(page.status).toBe(200);
      expect(detailHref(page.html)).toBe(
        "/admin/join-attempts/7?from_outcome=error&from_q=request%3Afixture-7&from_page=2",
      );
      expect(page.html).not.toContain('data-testid="join-attempts-empty"');
      expect(oracle(page)).toEqual([]);
    });

    it("retains the populated bare-detail-link positive control", async () => {
      const page = await render();
      const bare = {
        ...page,
        html: page.html.replace(
          /href="\/admin\/join-attempts\/7\?[^"]*"/g,
          'href="/admin/join-attempts/7"',
        ),
      };
      expect(detailHref(bare.html)).toBe("/admin/join-attempts/7");
      expect(oracle(bare)).toEqual([]);
    });

    it("retains the actual empty-render positive control", async () => {
      const page = await render([]);
      expect(page.html).toContain('data-testid="join-attempts-empty"');
      expect(detailHref(page.html)).toBe("");
      expect(oracle(page)).toEqual([]);
    });

    it.each([
      "/admin/join-attempts",
      "/admin/join-attempts/7suffix",
      "/admin/join-attempts/7/extra",
      "/admin/join-attempts/7#fragment",
      "/admin/join-attempts/not-a-number?from_page=2",
      "https://evil.example/admin/join-attempts/7?from_page=2",
      "//evil.example/admin/join-attempts/7?from_page=2",
      "/admin/join-attempts/7?",
      "/admin/join-attempts/7?from_q=%ZZ",
      "/admin/join-attempts/7?from_page",
      "/admin/join-attempts/7?return=/admin/events",
      "/admin/join-attempts/7?from_q=exact#fragment",
      "/admin/join-attempts/7?from_q=exact trailing",
    ])("rejects malformed/non-detail row link %s", async (href) => {
      const page = await render();
      const html = page.html.replace(/href="\/admin\/join-attempts\/7\?[^"]*"/g, `href="${href}"`);
      expect(html).not.toBe(page.html);
      expect(oracle({ ...page, html })).toEqual([`${twin}: ${missingRows}`]);
    });

    it("still refuses a populated shell with no row link and no empty marker", async () => {
      const page = await render();
      const html = page.html.replace(/href="\/admin\/join-attempts\/7\?[^"]*"/g, "");
      expect(html).not.toBe(page.html);
      expect(oracle({ ...page, html })).toEqual([`${twin}: ${missingRows}`]);
    });

    it("keeps status/admission and private-no-store checks", async () => {
      const page = await render();
      expect(oracle({ ...page, status: 403 })).toEqual([`${twin}: status 403 !== 200`]);
      expect(
        oracle({ ...page, headers: { ...page.headers, "cache-control": "public, max-age=60" } }),
      ).toContain(`${twin}: admin page answers private, no-store`);
    });

    it("keeps admin shell, column and filter assertions on populated output", async () => {
      const page = await render();
      for (const [from, to, failure] of [
        [
          'aria-label="Administration"',
          'aria-label="Other"',
          "administration nav has an accessible name",
        ],
        [
          'class="skip-link" href="#main"',
          'class="skip-link" href="#other"',
          "skip link targets #main",
        ],
        ['<th scope="col">Outcome</th>', "<th>Outcome</th>", "Outcome column present"],
        [
          'id="q" name="q" type="search"',
          'id="other" name="q" type="search"',
          "exact-search input present",
        ],
      ]) {
        const html = page.html.replace(from!, to!);
        expect(html).not.toBe(page.html);
        expect(oracle({ ...page, html })).toContain(`${twin}: ${failure}`);
      }
      expect(
        oracle({
          ...page,
          html: page.html.replace(
            "</head>",
            '<link rel="canonical" href="https://example.test/admin/join-attempts"></head>',
          ),
        }),
      ).toContain(`${twin}: admin page carries no canonical URL`);
    });
  });
}
