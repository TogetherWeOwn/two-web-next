// Kit join-attempts audit-list port: the Kit route reuses the Hono viewer's
// reads and keeps its privacy posture — moderator-only trace identifiers,
// audited subjects, private/no-store/noindex, accessible scroll and paging,
// no wildcard search expansion. Kit-owned since the enablement review.
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const load = () => read("web/src/routes/admin/join-attempts/+page.server.ts");
const page = () => read("web/src/routes/admin/join-attempts/+page.svelte");

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
  it("keeps the filter grammar: GET form, exact-search copy, bounded outcome allowlist", () => {
    const html = page();
    expect(html).toContain('<form method="get" action="/admin/join-attempts" class="filters">');
    expect(html).toContain("Search is an exact Discord id or request id.");
    expect(html).toContain('for="q">Discord id or request id</label>');
    expect(html).toContain('id="q" name="q" type="search"');
    expect(html).toContain('id="outcome" name="outcome"');
    // The All option renders from the shared outcome list at runtime; the
    // source carries the label expression, not the literal bytes.
    expect(html).toContain('? "All" : o');
    expect(html).toContain("</option>");
    expect(html).toContain(">Filter</button>");
    // No wildcard expansion: the options come from the shared outcome list,
    // and no substring/pattern control is added to the form.
    expect(html).not.toMatch(/ilike|contains|startsWith|pattern=|wildcard/i);
  });

  it("keeps the accessible scroll region, scoped headers, testids and empty state", () => {
    const html = page();
    // Attribute-per-line in source, one region on the wire: pin each fragment.
    for (const needle of [
      'class="admin-table-scroll"',
      'role="region"',
      'aria-label="Join attempts list"',
      'aria-describedby="join-attempts-scroll-hint"',
      'id="join-attempts-scroll-hint"',
      "Scroll horizontally to see all columns on smaller screens.",
    ]) {
      expect(html).toContain(needle);
    }
    expect(html).toContain("tabindex={0}");
    expect(html).toContain('data-testid="join-attempts-table-scroll"');
    expect(html).toContain('data-testid="join-attempts-table"');
    expect(html).toContain('data-testid="join-attempts-empty"');
    expect(html).toContain("joinAttemptsEmptyText(query, data.retentionDays)");
    expect(html).not.toContain("No join attempts.");
    expect(html.match(/<th scope="col">/g)).toHaveLength(5);
    expect(html.match(/<th\b(?![^>]*scope="col")/g)).toBeNull();
  });

  it("links rows to the Kit-owned detail pages with the same accessible names", () => {
    const html = page();
    expect(html).toContain("`/admin/join-attempts/${r.id}${contextSearch}`");
    expect(html).toContain("joinAttemptContextSearch");
    expect(html).toContain("View join attempt");
  });

  it("keeps paging accessible: labelled nav, page counter, filter-preserving prev/next", () => {
    const html = page();
    expect(html).toContain('<nav aria-label="Join attempt pages" class="actions">');
    expect(html).toContain("Page {query.page}");
    expect(html).toContain('rel="prev"');
    expect(html).toContain('rel="next"');
    expect(html).toContain("prevUrl");
    expect(html).toContain("nextUrl");
    // The hrefs are built by the shared URL helper in the load, so paging
    // keeps every filter exactly like the Hono viewer.
    expect(load()).toContain("joinAttemptsUrl(query, query.page - 1)");
    expect(load()).toContain("joinAttemptsUrl(query, query.page + 1)");
  });

  it("ships no JavaScript: no island, no script src, no event handler, no CSR", () => {
    const html = page();
    // The one <script lang="ts"> block is the component's types-only props
    // derivation: it compiles away, and the group layout sets csr=false so
    // no hydration bundle ships that the CSP would block.
    expect(html).not.toMatch(/<script src|islands\/|on:click|onClick|addEventListener/);
    expect(html).not.toContain("{@html");
    expect(read("web/src/routes/admin/+layout.server.ts")).toContain("csr = false");
  });

  it("never indexes moderator trace data: admin chrome carries noindex", () => {
    expect(read("web/src/lib/AdminShell.svelte")).toContain("noindex");
  });
});
