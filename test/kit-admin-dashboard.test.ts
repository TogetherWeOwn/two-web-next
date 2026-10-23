// Kit admin shell + dashboard port: the Kit (admin) route group
// shares one moderator guard contract with the Hono panel — guest OAuth
// bounce with a safe return, signed non-moderator 403, store failure 503 —
// and GET /admin renders the dashboard from the same bounded, optional
// analytics reads. Children reuse the layout guard; no child rotates or
// re-audits.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveDashboardWidgets } from "../src/admin/kit-dashboard";
import { decideKitAdminGuard } from "../src/admin/kit-guard";
import type { KitLocals } from "../src/kit-session";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const MOD = {
  userId: "100000000000000111",
  username: "mod",
  avatar: null,
  member: true,
  moderator: true,
};
const MEMBER = {
  userId: "100000000000000222",
  username: "pleb",
  avatar: null,
  member: true,
  moderator: false,
};

const authenticated = (session: typeof MOD): KitLocals => ({
  status: "authenticated",
  session,
  returnTo: null,
  joinResult: null,
  expiredWrite: null,
});
const guest = (): KitLocals => ({
  status: "guest",
  session: null,
  returnTo: null,
  joinResult: null,
  expiredWrite: null,
});
const unknown = (): KitLocals => ({
  status: "unknown",
  session: null,
  returnTo: null,
  joinResult: null,
  expiredWrite: null,
});

describe("Kit admin guard: one contract, no rotation, no audit of its own", () => {
  it("guest bounces to OAuth with the requested page as a safe next", () => {
    const decision = decideKitAdminGuard(guest(), "/admin/events?status=draft");
    expect(decision).toEqual({
      kind: "guest",
      location: "/auth/discord?next=%2Fadmin%2Fevents%3Fstatus%3Ddraft",
    });
  });

  it("real layout load marks its guest redirect private without writing cookies", async () => {
    const { outputFiles } = await build({
      entryPoints: [join(root, "web/src/routes/admin/+layout.server.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      tsconfigRaw: { compilerOptions: {} },
      plugins: [
        {
          name: "kit-admin-load-fixture",
          setup(builder) {
            builder.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
              path: "kit",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: `export const redirect = (status, location) => { throw { status, location }; };
                export const error = (status, message) => { throw { status, message }; };`,
              loader: "js",
            }));
          },
        },
      ],
    });
    const { load } = await import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`
    );
    const setHeaders = vi.fn();
    const cookies = { set: vi.fn(), delete: vi.fn() };
    await expect(
      load({
        locals: guest(),
        url: new URL("https://next.example.test/admin/events?status=draft"),
        setHeaders,
        cookies,
      }),
    ).rejects.toEqual({
      status: 302,
      location: "/auth/discord?next=%2Fadmin%2Fevents%3Fstatus%3Ddraft",
    });
    expect(setHeaders).toHaveBeenCalledExactlyOnceWith({
      "cache-control": "no-store, private",
      vary: "Cookie",
    });
    expect(cookies.set).not.toHaveBeenCalled();
    expect(cookies.delete).not.toHaveBeenCalled();
  });

  it("guest with a hostile current path falls back to the dashboard", () => {
    const decision = decideKitAdminGuard(guest(), "//evil.test/admin");
    expect(decision).toEqual({ kind: "guest", location: "/auth/discord?next=%2Fadmin" });
  });

  it("signed non-moderator is forbidden, never bounced into a login loop", () => {
    expect(decideKitAdminGuard(authenticated(MEMBER), "/admin")).toEqual({ kind: "forbidden" });
  });

  it("moderator passes with the row actor, reading nothing itself", async () => {
    const storeGet = vi.fn();
    void storeGet;
    expect(decideKitAdminGuard(authenticated(MOD), "/admin")).toEqual({
      kind: "pass",
      actor: { id: MOD.userId, username: MOD.username },
    });
  });

  it("session store failure is unavailable, never a false logout or pass", () => {
    expect(decideKitAdminGuard(unknown(), "/admin")).toEqual({ kind: "unavailable" });
    expect(decideKitAdminGuard(undefined, "/admin")).toEqual({ kind: "unavailable" });
  });
});

describe("Kit admin manifest: Hono-owned until the enablement review", () => {
  it("registers GET /admin as a dashboard member read, still Hono-served", () => {
    const manifest = read("src/route-ownership.ts");
    expect(manifest).toMatch(/path:\s*"\/admin"/);
    expect(manifest).toMatch(/\/admin"[^}]*resource:\s*"dashboard"/);
    expect(manifest).toMatch(/\/admin"[^}]*action:\s*"view"/);
    expect(manifest).toMatch(/\/admin"[^}]*route:\s*"admin\.dashboard"/);
    // Off by default: flipping enabled flips ownership, and the parity
    // ledger fails any enabled route with no executed journey covering it.
    expect(manifest).toMatch(/\/admin"[^}]*enabled:\s*false/);
  });
});

describe("Kit admin route group: thin guard binding, shared reads", () => {
  it("layout load is the only guard: bounce, 403, 503, no CSR, no cookie writes", () => {
    const layout = read("web/src/routes/admin/+layout.server.ts");
    expect(layout).toContain("decideKitAdminGuard");
    expect(layout).toContain("redirect(302");
    expect(layout).toContain("error(403");
    expect(layout).toContain("error(503");
    expect(layout).toContain("csr = false");
    expect(layout).not.toMatch(
      /dbFor|ADMIN_DB|SESSION_STORE|recordAccess|setSignedCookie|cookies\.set/,
    );
    // The OAuth destination is built once, in the tested guard — never a
    // second literal here that could drift from it.
    expect(layout).not.toContain("/auth/discord?next=");
    expect(read("src/admin/kit-guard.ts")).toContain("/auth/discord?next=");
  });

  it("dashboard load reuses the bounded optional widgets, degrading safely", () => {
    const load = read("web/src/routes/admin/+page.server.ts");
    expect(load).toContain("dashboardJoinFunnel");
    expect(load).toContain("topZeroResultSearches");
    expect(load).toContain("FUNNEL_READ_DEADLINE_MS");
    expect(load).not.toMatch(/select\(|from\(|sql`/);
  });

  it("dashboard load settles both widgets and maps a classified outage to 503", () => {
    const load = read("web/src/routes/admin/+page.server.ts");
    // Promise.all would let the funnel's rethrown outage escape into
    // SvelteKit's 500 error page; allSettled lets the load decide first.
    expect(load).toContain("Promise.allSettled");
    expect(load).toContain("resolveDashboardWidgets");
    expect(load).toContain("error(503");
    expect(read("src/admin/kit-dashboard.ts")).toContain("isDatabaseUnavailable");
  });

  it("parity gates record the Kit tab-sync probe without enabling admin routes", () => {
    const gates = read("docs/kit-parity-gates.md");
    expect(gates).toContain("tab-sync controller");
    expect(gates).toContain("auth-status");
    expect(gates).toContain("`enabled: false`");
  });

  it("dashboard keeps the Hono testids, copy and mixed-mode destinations", () => {
    const page = read("web/src/routes/admin/+page.svelte");
    // The h1 stays "Moderation": e2e/profile.spec.ts and
    // e2e/staging/admin.spec.ts select it by exact role name at enablement.
    expect(page).toContain(">Moderation</h1>");
    for (const needle of [
      'data-testid="admin-actor"',
      'data-testid="join-funnel"',
      'data-testid="join-funnel-empty"',
      'data-testid="top-zero-searches"',
      'data-testid="top-zero-searches-empty"',
      'href="/admin/events"',
      'href="/admin/featured"',
      'href="/admin/activity-log"',
      'href="/admin/join-attempts"',
    ]) {
      expect(page).toContain(needle);
    }
    // The Site destination lives in the shared chrome, not the page.
    expect(read("web/src/lib/AdminShell.svelte")).toContain('href="/"');
  });

  it("keeps the scroll-region focus outline visible on the dark canvas", () => {
    // Without this rule the new tabindex regions fall back to the shared
    // sheet's dark outline on the Kit dark root canvas — nearly invisible
    // for the keyboard users the regions were added for. Deleting the style
    // block must fail this test.
    const page = read("web/src/routes/admin/+page.svelte");
    expect(page).toContain(".admin-table-scroll:focus-visible");
    expect(page).toContain("outline-color: currentColor");
  });

  it("admin chrome is responsive, labelled, skippable and never indexed", () => {
    const shell = read("web/src/lib/AdminShell.svelte");
    for (const needle of [
      'aria-label="Administration"',
      'href="#main"',
      'id="main"',
      "TWO admin",
      "moderators only",
      "noindex",
    ]) {
      expect(shell).toContain(needle);
    }
  });
});

describe("Kit admin dashboard outage mapping: 503 like Hono, never a 500", () => {
  const refused = (): Error =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  const funnelValue = { added: 3, already_member: 1 };
  const zeroValue = [{ query: "zzz", searches: 2, lastSearchedAt: "2026-10-01T00:00:00.000Z" }];

  it("a refused funnel read is an outage, even when the widgets settle together", () => {
    expect(
      resolveDashboardWidgets(
        { status: "rejected", reason: refused() },
        { status: "fulfilled", value: zeroValue },
      ),
    ).toEqual({ outage: true });
  });

  it("a refused zero-search read is an outage too", () => {
    expect(
      resolveDashboardWidgets(
        { status: "fulfilled", value: funnelValue },
        { status: "rejected", reason: refused() },
      ),
    ).toEqual({ outage: true });
  });

  it("a wrapped transport cause (Drizzle-style) is still an outage", () => {
    expect(
      resolveDashboardWidgets(
        { status: "rejected", reason: new Error("query failed", { cause: refused() }) },
        { status: "fulfilled", value: zeroValue },
      ),
    ).toEqual({ outage: true });
  });

  it("an ordinary widget failure degrades to an omitted section, not an outage", () => {
    expect(
      resolveDashboardWidgets(
        { status: "rejected", reason: new Error("syntax error at end of input") },
        { status: "fulfilled", value: zeroValue },
      ),
    ).toEqual({ outage: false, funnel: undefined, zeroSearches: zeroValue });
  });

  it("a query cancellation degrades to an omitted section, not an outage", () => {
    const cancellation = Object.assign(new Error("statement timeout"), {
      name: "PostgresError",
      code: "57014",
    });
    expect(
      resolveDashboardWidgets(
        { status: "fulfilled", value: funnelValue },
        { status: "rejected", reason: cancellation },
      ),
    ).toEqual({ outage: false, funnel: funnelValue, zeroSearches: undefined });
  });

  it("healthy widgets pass their values through", () => {
    expect(
      resolveDashboardWidgets(
        { status: "fulfilled", value: funnelValue },
        { status: "fulfilled", value: zeroValue },
      ),
    ).toEqual({ outage: false, funnel: funnelValue, zeroSearches: zeroValue });
  });
});
