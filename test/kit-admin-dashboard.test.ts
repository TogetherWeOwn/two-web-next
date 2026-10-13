// Kit admin shell + dashboard port: the Kit (admin) route group
// shares one moderator guard contract with the Hono panel — guest OAuth
// bounce with a safe return, signed non-moderator 403, store failure 503 —
// and GET /admin renders the dashboard from the same bounded, optional
// analytics reads. Children reuse the layout guard; no child rotates or
// re-audits.
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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
