// Kit join-attempt detail port: the Kit route reuses the Hono detail's
// reads and keeps its privacy posture — moderator-only trace identifiers,
// audited subjects, private/no-store/noindex, safe back navigation, no raw
// provider/token payload. Kit-owned since the enablement review.
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  parseJoinAttemptId,
  resolveKitJoinAttemptDetail,
} from "../src/admin/kit-join-attempt-detail";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer } from "./helpers/kit-ssr-render";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const load = () => read("web/src/routes/admin/join-attempts/[id]/+page.server.ts");
const pagePath = "web/src/routes/admin/join-attempts/[id]/+page.svelte";

describe("Kit join-attempt detail manifest: Kit-owned since the enablement review", () => {
  it("registers GET /admin/join-attempts/:id as a join_attempts view member read, Kit-served", () => {
    const manifest = read("src/route-ownership.ts");
    expect(manifest).toMatch(/path:\s*"\/admin\/join-attempts\/:id"/);
    expect(manifest).toMatch(/\/admin\/join-attempts\/:id"[^}]*resource:\s*"join_attempts"/);
    expect(manifest).toMatch(/\/admin\/join-attempts\/:id"[^}]*action:\s*"view"/);
    expect(manifest).toMatch(
      /\/admin\/join-attempts\/:id"[^}]*route:\s*"admin\.join-attempts\.show"/,
    );
    // Enabled: flipping enabled flips ownership, so returning this entry to
    // enabled: false restores the Hono detail as the rollback.
    expect(manifest).toMatch(/\/admin\/join-attempts\/:id"[^}]*enabled:\s*true/);
  });

  it("records the detail in the parity-gate inventory as Kit-owned", () => {
    const gates = read("docs/kit-parity-gates.md");
    expect(gates).toContain("GET /admin/join-attempts/:id");
    expect(gates).toContain("admin.join-attempts.show");
    expect(gates).toContain("`enabled: true`");
  });
});

describe("parseJoinAttemptId: the Hono handler's canonical-ID admission", () => {
  it.each(["1", "7", "999999", "9007199254740991"])("admits canonical id %s", (raw) => {
    expect(parseJoinAttemptId(raw)).toBe(Number(raw));
  });

  it.each(["0", "-1", "1.0", "1e2", "01", "abc", "9007199254740993", "", " 7", "7 "])(
    "refuses non-canonical id %s before any record lookup",
    (raw) => {
      expect(parseJoinAttemptId(raw)).toBeNull();
    },
  );

  it("admits bigserial IDs above the 32-bit cap that parseRecordId refuses", async () => {
    const { parseRecordId } = await import("../src/admin/record-id");
    expect(parseRecordId("3000000000")).toBeNull();
    expect(parseJoinAttemptId("3000000000")).toBe(3000000000);
  });
});

describe("resolveKitJoinAttemptDetail: the shared read, nothing new", () => {
  const row = {
    id: 7,
    outcome: "added",
    source: "join",
    requestId: "detail-request",
    discordId: "100000000000000201",
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
  };

  it("404s a non-canonical ID before any record lookup, like the Hono admission", async () => {
    const get = vi.fn(async () => ({ attempt: row }));
    await expect(resolveKitJoinAttemptDetail("01", { db: {} as never, get })).resolves.toEqual({
      kind: "notFound",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("answers unavailable with no database, like the Hono dbOr503 503", async () => {
    const get = vi.fn(async () => ({ attempt: row }));
    await expect(resolveKitJoinAttemptDetail("7", { db: null, get })).resolves.toEqual({
      kind: "unavailable",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("404s a missing or expired row and maps a classified outage to unavailable", async () => {
    await expect(
      resolveKitJoinAttemptDetail("7", { db: {} as never, get: async () => null }),
    ).resolves.toEqual({ kind: "notFound" });
    const outage = Object.assign(new Error("connection terminated"), {
      name: "PostgresError",
      code: "57P01",
    });
    await expect(
      resolveKitJoinAttemptDetail("7", {
        db: {} as never,
        get: async () => Promise.reject(outage),
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    const boom = new Error("boom");
    await expect(
      resolveKitJoinAttemptDetail("7", {
        db: {} as never,
        get: async () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
  });

  it("returns the Hono detail view: the six safe columns with an ISO instant", async () => {
    const outcome = await resolveKitJoinAttemptDetail("7", {
      db: {} as never,
      get: async () => ({ attempt: row }),
    });
    expect(outcome).toEqual({
      kind: "ok",
      view: {
        id: 7,
        outcome: "added",
        source: "join",
        requestId: "detail-request",
        discordId: "100000000000000201",
        createdAt: "2026-10-01T12:00:00.000Z",
      },
    });
  });

  it("keeps null trace fields null for the page's em-dash fallbacks", async () => {
    const outcome = await resolveKitJoinAttemptDetail("7", {
      db: {} as never,
      get: async () => ({
        attempt: { ...row, source: null, requestId: null, discordId: null },
      }),
    });
    expect(outcome).toEqual({
      kind: "ok",
      view: {
        id: 7,
        outcome: "added",
        source: null,
        requestId: null,
        discordId: null,
        createdAt: "2026-10-01T12:00:00.000Z",
      },
    });
  });
});

describe("Kit join-attempt detail load: the shared read, nothing new", () => {
  it("authorizes through the shared layout guard before doing any work", () => {
    expect(load()).toContain("await parent()");
  });

  it("reads with the shared retention-window lookup and the Hono failure posture", () => {
    expect(load()).toContain("resolveKitJoinAttemptDetail");
    expect(load()).toContain("getJoinAttempt");
    expect(load()).toContain("dbFor");
    expect(load()).toContain('error(503, "Admin temporarily unavailable")');
    expect(load()).toContain('error(404, "Join attempt not found")');
    // One shared keyed read: no second query, no hand-rolled SQL.
    expect(load()).not.toMatch(/select\(|from\(|sql`|ilike|like\(/);
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

  it("ships no hydration bundle: the group layout already sets csr=false", () => {
    expect(load()).toContain("csr = false");
  });
});

describe("Kit join-attempt detail page: the Hono markup contract, no JavaScript", () => {
  const view = { id: 7, outcome: "added", createdAt: "2026-10-01T12:34:56.789Z" };
  const missing = { source: null, requestId: null, discordId: null };
  let renderer: Awaited<ReturnType<typeof createKitSsrRenderer>>;
  beforeAll(async () => {
    renderer = await createKitSsrRenderer(pagePath);
  });
  afterAll(() => renderer?.cleanup());

  const render = (trace: Record<string, string | null> = missing, id = view.id) => {
    const html = renderer.renderPage({ view: { ...view, ...trace, id } });
    return elements(parse(html, { scriptingEnabled: false }));
  };

  it("keeps the back navigation and the Outcome/Trace definition lists", () => {
    const nodes = render();
    const back = nodes.find((el) => el.tagName === "a" && textOf(el) === "Back to join attempts");
    expect(back && attr(back, "href")).toBe("/admin/join-attempts");
    expect(nodes.filter((el) => el.tagName === "h2").map(textOf)).toEqual(["Outcome", "Trace"]);
    expect(nodes.filter((el) => el.tagName === "dl")).toHaveLength(2);
    const terms = nodes.filter((el) => el.tagName === "dt").map(textOf);
    expect(terms).toEqual(["Outcome", "Source", "Attempted at (UTC)", "Request ID", "Discord ID"]);
    const hint = nodes.find((el) => el.tagName === "p" && attr(el, "class") === "hint");
    const note = "Attempted at and trace identifiers are shown as recorded.";
    expect(hint && textOf(hint)).toContain(note);
  });

  it("renders the UTC instant in a <time datetime> and em dashes for missing fields", () => {
    const trace = { source: "join", requestId: "request&7", discordId: "100000000000000201" };
    const fixtures = [
      [missing, view.createdAt, ["—", "—", "—"]],
      [trace, "2026-11-01T04:05:06.789Z", ["join", "request&7", "100000000000000201"]],
    ] as const;
    for (const [fields, date, [source, requestId, discordId]] of fixtures) {
      const nodes = render({ ...fields, createdAt: date });
      const time = nodes.find((el) => el.tagName === "time");
      expect(time && attr(time, "datetime")).toBe(date);
      expect(time && textOf(time)).toBe(date);
      const values = nodes.filter((el) => el.tagName === "dd").map((el) => textOf(el).trim());
      expect(values).toEqual(["added", source, date, requestId, discordId]);
    }
  });

  it.each([7, 3000000000])("renders attempt %d in the admin chrome", (id) => {
    const nodes = render(missing, id);
    const heading = `Join attempt ${id}`;
    const titles = nodes.filter((el) => el.tagName === "title");
    expect(titles.map(textOf)).toEqual([`${heading} — TWO admin`]);
    expect(nodes.filter((el) => el.tagName === "h1").map(textOf)).toEqual([heading]);
    const scripts = nodes.filter((el) => el.tagName === "script");
    expect(scripts.map((el) => attr(el, "src"))).toEqual(["/islands/auth-status.js"]);
    expect(nodes.filter((el) => ["form", "input", "button"].includes(el.tagName))).toEqual([]);
    // The one <script lang="ts"> block is the component's types-only props
    // derivation: it compiles away, and csr=false means no hydration bundle
    // ships that the CSP would block.
    const source = read(pagePath);
    expect(source).not.toMatch(/<script src|islands\/|on:click|onClick|addEventListener/);
    expect(source).not.toContain("{@html");
    expect(source).not.toMatch(/<form|<input|<button/);
  });

  it("never indexes moderator trace data: admin chrome carries noindex", () => {
    const robots = render().filter((el) => el.tagName === "meta" && attr(el, "name") === "robots");
    const directives = robots.map((el) => [el.parentNode?.nodeName, attr(el, "content")]);
    expect(directives).toEqual([["head", "noindex, nofollow"]]);
  });
});
