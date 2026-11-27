// Kit join-attempts audit-list port: the Kit route reuses the Hono viewer's
// reads and keeps its privacy posture — moderator-only trace identifiers,
// audited subjects, private/no-store/noindex, accessible scroll and paging,
// no wildcard search expansion. Kit-owned since the enablement review.
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { joinAttemptsUrl } from "../src/admin/table-list";
import { JOIN_OUTCOMES } from "../src/join/service";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer } from "./helpers/kit-ssr-render";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const load = () => read("web/src/routes/admin/join-attempts/+page.server.ts");
const pagePath = "web/src/routes/admin/join-attempts/+page.svelte";

describe("Kit join-attempts manifest: Kit-owned since the enablement review", () => {
  it("registers GET /admin/join-attempts as a join_attempts list member read, Kit-served", () => {
    const manifest = read("src/route-ownership.ts");
    expect(manifest).toMatch(/path:\s*"\/admin\/join-attempts"/);
    expect(manifest).toMatch(/\/admin\/join-attempts"[^}]*resource:\s*"join_attempts"/);
    expect(manifest).toMatch(/\/admin\/join-attempts"[^}]*action:\s*"list"/);
    expect(manifest).toMatch(/\/admin\/join-attempts"[^}]*route:\s*"admin\.join-attempts\.index"/);
    // Enabled: flipping enabled flips ownership, so returning this entry to
    // enabled: false restores the Hono viewer as the rollback.
    expect(manifest).toMatch(/\/admin\/join-attempts"[^}]*enabled:\s*true/);
  });

  it("registers the detail page alongside: its own slice registers the :id entry", () => {
    expect(read("src/route-ownership.ts")).toMatch(/path:\s*"\/admin\/join-attempts\/:id"/);
  });

  it("records the list in the parity-gate inventory as Kit-owned", () => {
    const gates = read("docs/kit-parity-gates.md");
    expect(gates).toContain("GET /admin/join-attempts");
    expect(gates).toContain("admin.join-attempts.index");
    expect(gates).toContain("`enabled: true`");
  });
});

describe("Kit join-attempts load: the shared read, nothing new", () => {
  it("parses with the shared bounded query grammar and reads with the shared retention-window list", () => {
    expect(load()).toContain("parseJoinAttemptsQuery");
    expect(load()).toContain("listJoinAttempts");
    expect(load()).toContain("JOIN_ATTEMPT_PAGE_SIZE");
    expect(load()).toContain("JOIN_RETENTION_DAYS");
    expect(load()).toContain("JOIN_OUTCOMES");
    expect(load()).toContain("joinAttemptsUrl");
    // One shared keyed read plus the lookahead slice: no second query, no
    // hand-rolled SQL, no substring operator that would widen exact search.
    expect(load()).not.toMatch(/select\(|from\(|sql`|ilike|like\(/);
  });

  it("keeps the Hono failure posture: no DB and classified outages answer 503, never a 500 page", () => {
    expect(load()).toContain("dbFor");
    expect(load()).toContain("isDatabaseUnavailable");
    expect(load()).toContain('error(503, "Admin temporarily unavailable")');
  });

  it("keeps every byte private: private no-store on the released response", () => {
    expect(load()).toContain('setHeaders({ "cache-control": "private, no-store" })');
  });

  it("performs no audit of its own: the hook boundary owns subjects and the access-log row", () => {
    // Guard decisions, cookie writes and audit sinks all live elsewhere —
    // the layout guard admits moderators, the member-read boundary classifies
    // and audits. A second guard or sink here could double-log or leak.
    expect(load()).not.toMatch(
      /decideKitAdminGuard|recordAccess|accessSink|cookies\.set|setSignedCookie|SESSION_STORE/,
    );
  });

  it("serializes dates before the wire: ISO strings like the Hono page emits", () => {
    expect(load()).toContain("toISOString()");
  });
});

describe("Kit join-attempts page: the Hono markup contract, no JavaScript", () => {
  const query = { q: '*request&"7', outcome: "added", page: 2 };
  const row = { id: 7, outcome: "added", source: "join", createdAt: "2026-10-01T12:00:00Z" };
  let renderer: Awaited<ReturnType<typeof createKitSsrRenderer>>;
  beforeAll(async () => {
    renderer = await createKitSsrRenderer(pagePath);
  });
  afterAll(() => renderer?.cleanup());

  const data = { outcomes: JOIN_OUTCOMES, retentionDays: 30, hasNext: true };
  const render = (rows = [row], page = query.page) => {
    const filters = { ...query, page };
    const prevUrl = joinAttemptsUrl(filters, page - 1);
    const nextUrl = joinAttemptsUrl(filters, page + 1);
    const html = renderer.renderPage({ ...data, query: filters, rows, prevUrl, nextUrl });
    return elements(parse(html));
  };

  it("keeps the filter grammar: GET form, exact-search copy, bounded outcome allowlist", () => {
    const nodes = render();
    const form = nodes.find((el) => el.tagName === "form");
    if (!form) throw new Error("no filter form rendered");
    expect(attr(form, "method")).toBe("get");
    expect(attr(form, "action")).toBe("/admin/join-attempts");
    expect(attr(form, "class")).toBe("filters");
    const paragraphs = nodes.filter((el) => el.tagName === "p").map(textOf);
    expect(paragraphs.join(" ")).toContain("Search is an exact Discord id or request id.");
    const fields = elements(form);
    const labels = fields.filter((el) => el.tagName === "label");
    expect(labels.map((el) => attr(el, "for"))).toEqual(["q", "outcome"]);
    expect(labels.map(textOf)).toEqual(["Discord id or request id", "Outcome"]);
    const controlTags = ["input", "textarea", "select", "button"];
    const controls = fields.filter((el) => controlTags.includes(el.tagName));
    const names = ["id", "name", "type"];
    const attributes = controls.map((el) => [el.tagName, ...names.map((name) => attr(el, name))]);
    expect(attributes).toEqual([
      ["input", "q", "q", "search"],
      ["select", "outcome", "outcome", undefined],
      ["button", undefined, undefined, "submit"],
    ]);
    const [input] = controls;
    expect(input && attr(input, "value")).toBe(query.q);
    expect(controls.some((el) => attr(el, "pattern") !== undefined)).toBe(false);
    expect(read(pagePath)).not.toMatch(/ilike|contains|startsWith|pattern=|wildcard/i);
    expect(fields.filter((el) => el.tagName === "button").map(textOf)).toEqual(["Filter"]);
    const options = fields.filter((el) => el.tagName === "option");
    expect(options.map((el) => attr(el, "value"))).toEqual(["", ...JOIN_OUTCOMES]);
    expect(options.map(textOf)).toEqual(["All", ...JOIN_OUTCOMES]);
    const selected = options.filter((el) => attr(el, "selected") !== undefined);
    expect(selected.map(textOf)).toEqual([query.outcome]);
  });

  it("keeps the accessible scroll region, scoped headers, testids and empty state", () => {
    const nodes = render([]);
    const scroll = nodes.find((el) => attr(el, "data-testid") === "join-attempts-table-scroll");
    if (!scroll) throw new Error("no scroll region rendered");
    expect(attr(scroll, "class")).toBe("admin-table-scroll");
    expect(attr(scroll, "role")).toBe("region");
    expect(attr(scroll, "aria-label")).toBe("Join attempts list");
    expect(attr(scroll, "aria-describedby")).toBe("join-attempts-scroll-hint");
    expect(attr(scroll, "tabindex")).toBe("0");
    const hint = nodes.find((el) => attr(el, "id") === "join-attempts-scroll-hint");
    expect(hint && textOf(hint)).toBe("Scroll horizontally to see all columns on smaller screens.");
    const table = elements(scroll).find((el) => attr(el, "data-testid") === "join-attempts-table");
    if (!table || table.tagName !== "table") throw new Error("no attempts table rendered");
    const cells = elements(table);
    for (const page of [nodes, render()]) {
      const headers = page.filter((el) => el.tagName === "th");
      expect(headers.map((el) => attr(el, "scope"))).toEqual(Array(5).fill("col"));
    }
    const empty = cells.find((el) => attr(el, "data-testid") === "join-attempts-empty");
    expect(empty && textOf(empty)).toBe("No join attempts.");
  });

  it.each([7, 3000000000])("links row %d to its detail page with an accessible name", (id) => {
    const href = `/admin/join-attempts/${id}`;
    const links = render([{ ...row, id }]).filter((el) => el.tagName === "a");
    const detail = links.find((el) => attr(el, "href") === href);
    expect(detail && attr(detail, "aria-label")).toBe(`View join attempt ${id}: added`);
    expect(detail && textOf(detail)).toBe("added");
  });

  it.each([2, 5])("labels pagination on page %d and preserves both filters", (page) => {
    const navs = render([row], page).filter((el) => el.tagName === "nav");
    const nav = navs.find((el) => attr(el, "aria-label") === "Join attempt pages");
    if (!nav) throw new Error("no pagination rendered");
    expect(attr(nav, "class")).toBe("actions");
    const counter = elements(nav).find((el) => el.tagName === "span");
    expect(counter && textOf(counter)).toBe(`Page ${page}`);
    const links = elements(nav).filter((el) => el.tagName === "a");
    const url = (n: number) => `/admin/join-attempts?page=${n}&outcome=added&q=*request%26%227`;
    expect(links.map((el) => [attr(el, "rel"), attr(el, "href")])).toEqual([
      ["prev", url(page - 1)],
      ["next", url(page + 1)],
    ]);
    // The hrefs are built by the shared URL helper in the load, so paging
    // keeps every filter exactly like the Hono viewer.
    expect(load()).toContain("joinAttemptsUrl(query, query.page - 1)");
    expect(load()).toContain("joinAttemptsUrl(query, query.page + 1)");
  });

  it("adds no page JavaScript and keeps CSR disabled", () => {
    const scripts = render().filter((el) => el.tagName === "script");
    expect(scripts.map((el) => attr(el, "src"))).toEqual(["/islands/auth-status.js"]);
    // The one <script lang="ts"> block is the component's types-only props
    // derivation: it compiles away, and the group layout sets csr=false so
    // no hydration bundle ships that the CSP would block.
    const source = read(pagePath);
    expect(source).not.toMatch(/<script src|islands\/|on:click|onClick|addEventListener/);
    expect(source).not.toContain("{@html");
    expect(read("web/src/routes/admin/+layout.server.ts")).toContain("csr = false");
  });

  it("never indexes moderator trace data: admin chrome carries noindex", () => {
    const robots = render().filter((el) => el.tagName === "meta" && attr(el, "name") === "robots");
    const directives = robots.map((el) => [el.parentNode?.nodeName, attr(el, "content")]);
    expect(directives).toEqual([["head", "noindex, nofollow"]]);
  });
});
