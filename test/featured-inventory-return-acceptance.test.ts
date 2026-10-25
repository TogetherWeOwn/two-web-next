// route-inventory: GET /admin/featured
// route-inventory: GET /admin/featured/:id
// Independent acceptance: change the transport, not these destination oracles.
import { describe, expect, it } from "vitest";
import {
  attr,
  editorForm,
  elements,
  entry,
  links,
  origin,
  query,
  renderEditor,
  search,
  text,
  type Renderer,
} from "./helpers/featured-inventory-return";

const renderers: Renderer[] = ["Hono", "Kit"];
const desired = { q: query, published: "0", sort: "updated_at", order: "desc", page: "2" };
function state(url: URL) {
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe("/admin/featured");
  const result = Object.fromEntries(url.searchParams);
  expect([...url.searchParams.keys()].length).toBe(Object.keys(result).length);
  expect(
    Object.keys(result).every((k) => ["q", "published", "sort", "order", "page"].includes(k)),
  ).toBe(true);
  return { q: "", published: "", sort: "position", order: "asc", page: "1", ...result };
}
function returnLinks(html: string, expected = desired) {
  const back = links(html).filter((link) => /^Back to these featured results$/i.test(link.label));
  const cancel = links(html).filter((link) => link.label === "Cancel");
  expect(
    back,
    "a native, meaningfully named Back anchor must survive a fresh document GET",
  ).toHaveLength(1);
  expect(cancel).toHaveLength(1);
  for (const link of [...back, ...cancel]) expect(state(link.url)).toEqual(expected);
}
function privateResponse(headers: Headers) {
  const directives = headers.get("cache-control")?.split(/,\s*/);
  expect(directives).toContain("private");
  expect(directives).toContain("no-store");
}
function contextNames(url: URL) {
  const result: Record<string, string> = {};
  for (const [semantic, value] of Object.entries(desired)) {
    const matches = [...url.searchParams].filter(([, v]) => v === value);
    expect(
      matches,
      `row href must carry structured ${semantic}, not an arbitrary return URL`,
    ).toHaveLength(1);
    result[semantic] = matches[0]![0];
  }
  expect(new Set(Object.values(result)).size).toBe(5);
  return result;
}

for (const renderer of renderers)
  describe(`${renderer} featured inventory return`, () => {
    it("CONTROL: direct bookmark retains the native fallback, one keyed read and private no-store", async () => {
      const result = await renderEditor(renderer, new URL("/admin/featured/7", origin));
      expect(result.status).toBe(200);
      privateResponse(result.headers);
      expect(result.probe.queries).toHaveLength(1);
      expect(result.probe.queries[0]!.params).toEqual([7]);
      expect(links(result.html).find((a) => a.label === "Cancel")?.url.href).toBe(
        `${origin}/admin/featured`,
      );
      for (const deletion of [false, true]) {
        const form = editorForm(result.html, deletion);
        expect(form.method).toBe("post");
        expect(new URL(form.action, origin).pathname).toBe(
          `/admin/featured/7${deletion ? "/delete" : ""}`,
        );
      }
      expect(
        elements(result.html, "form").some((f) => attr(f, "data-event-editor") !== undefined),
      ).toBe(true);
      expect(
        elements(result.html, "script").some(
          (s) => attr(s, "src") === "/islands/admin-event-editor.js",
        ),
      ).toBe(true);
    });

    it("carries five normalized fields from page two, not an open return destination", async () => {
      const result = await entry(renderer);
      expect(result.probe.queries).toHaveLength(1);
      expect(result.probe.queries[0]!.params).toContain(25);
      privateResponse(result.headers);
      expect(result.url.origin).toBe(origin);
      expect(result.url.pathname).toBe("/admin/featured/7");
      contextNames(result.url);
      expect(
        [...result.url.searchParams.values()].some(
          (v) => v.includes("/admin/") || /^https?:/.test(v),
        ),
      ).toBe(false);
      expect(result.url.search.length).toBeLessThan(1000);
    });

    it("fresh tabs, reloads and the other renderer retain Back and Cancel without referrer or storage", async () => {
      const { url } = await entry(renderer === "Hono" ? "Kit" : "Hono");
      for (let visit = 0; visit < 2; visit++) {
        const result = await renderEditor(renderer, new URL(url.href));
        expect(result.status).toBe(200);
        privateResponse(result.headers);
        expect(result.probe.queries).toHaveLength(1);
        returnLinks(result.html);
        expect(editorForm(result.html).method).toBe("post");
      }
    });

    it("normalizes Unicode, NUL, whitespace and invalid sort/page at the list producer", async () => {
      const raw = new URLSearchParams({
        q: ` \u0000${query} `,
        published: "false",
        sort: "drop table",
        order: "DESC",
        page: "9007199254740992",
      });
      const { url } = await entry(renderer, `?${raw}`);
      const result = await renderEditor(renderer, url);
      returnLinks(result.html, {
        q: query,
        published: "",
        sort: "position",
        order: "asc",
        page: "1",
      });
      expect(elements(result.html, "script").some((s) => text(s).includes("<slot>"))).toBe(false);
    });

    it.each([128, 129])(
      "keeps the existing normalized free-text bound (%s UTF-16 units)",
      async (length) => {
        const q = "x".repeat(length);
        const { url } = await entry(
          renderer,
          `?${new URLSearchParams({ q, published: "1", sort: "updated_at", order: "desc", page: "2" })}`,
        );
        const result = await renderEditor(renderer, url);
        returnLinks(result.html, { ...desired, q: length === 128 ? q : "", published: "1" });
      },
    );

    it("normalizes untrusted context again at the edit boundary instead of trusting the row producer", async () => {
      const { url } = await entry(renderer);
      const names = contextNames(url);
      url.searchParams.set(names.q!, ` \u0000${query} `);
      url.searchParams.set(names.page!, "-2");
      url.searchParams.set(names.sort!, "unknown");
      url.searchParams.set(names.order!, "DESC");
      url.searchParams.set(names.published!, "yes");
      const result = await renderEditor(renderer, url);
      returnLinks(result.html, {
        q: query,
        published: "",
        sort: "position",
        order: "asc",
        page: "1",
      });
    });

    it("bounds oversized context at the consumer, not just at the list producer", async () => {
      const { url } = await entry(renderer);
      const names = contextNames(url);
      url.searchParams.set(names.q!, "x".repeat(8192));
      url.searchParams.set(names.page!, "9".repeat(300));
      const result = await renderEditor(renderer, url);
      expect(result.status).toBe(200);
      returnLinks(result.html, { ...desired, q: "", page: "1" });
      expect(editorForm(result.html).fields.toString().length).toBeLessThan(2000);
    });

    it("malformed percent/UTF-8 context stays local, bounded and non-executable", async () => {
      const { url } = await entry(renderer);
      const names = contextNames(url);
      url.searchParams.set(names.q!, "malformed-sentinel");
      url.search = url.search.replace("malformed-sentinel", "%E0%A4%A%ZZ");
      const result = await renderEditor(renderer, url);
      expect(result.status).toBe(200);
      const cancel = links(result.html).find((link) => link.label === "Cancel")!;
      const normalized = state(cancel.url);
      expect(normalized.q.length).toBeLessThanOrEqual(128);
      expect(["1", "2"]).toContain(normalized.page);
      expect(cancel.url.href.length).toBeLessThan(1000);
      expect(elements(result.html, "slot")).toEqual([]);
    });

    it("ambiguous duplicate context cannot escape or multiply into forms and links", async () => {
      const { url } = await entry(renderer);
      const names = contextNames(url);
      url.searchParams.append(names.q!, "https://evil.example/steal");
      url.searchParams.append(names.page!, "9007199254740992");
      const result = await renderEditor(renderer, url);
      expect(result.status).toBe(200);
      const cancel = links(result.html).find((link) => link.label === "Cancel")!;
      const parsed = state(cancel.url);
      // Reject the ambiguous context entirely or normalize using the existing
      // first-value list authority. Last-value authority escalation is not valid.
      expect(["", query]).toContain(parsed.q);
      expect(["1", "2"]).toContain(parsed.page);
      expect(cancel.url.href).not.toContain("evil.example");
      const form = editorForm(result.html);
      for (const name of new Set(form.fields.keys()))
        expect(form.fields.getAll(name)).toHaveLength(1);
      expect([...form.fields.values()].join(" ")).not.toContain("evil.example");
    });

    it.each([
      "https://evil.example/steal",
      "//evil.example/steal",
      "/admin/events",
      "javascript:alert(1)",
    ])(
      "ignores arbitrary return destinations (%s) while retaining structured state",
      async (target) => {
        const { url } = await entry(renderer);
        for (const name of ["return", "returnTo", "return_url", "next", "redirect"])
          url.searchParams.set(name, target);
        const result = await renderEditor(renderer, url);
        returnLinks(result.html);
        const form = editorForm(result.html);
        for (const name of ["return", "returnTo", "return_url", "next", "redirect"])
          expect(form.fields.has(name)).toBe(false);
        expect(links(result.html).some((link) => link.url.hostname === "evil.example")).toBe(false);
      },
    );

    it.each(["guest", "member"] as const)(
      "CONTROL: %s admission refuses before the contextual keyed read",
      async (admission) => {
        const result = await renderEditor(renderer, new URL(`/admin/featured/7${search}`, origin), {
          admission,
        });
        expect(result.status).toBe(admission === "guest" ? 302 : 403);
        expect(result.probe.queries).toEqual([]);
        expect(result.bindingCalls).toBe(0);
        expect(result.html).not.toContain(query);
      },
    );
  });
