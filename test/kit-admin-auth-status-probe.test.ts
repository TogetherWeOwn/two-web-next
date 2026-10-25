// Acceptance tests: auth-status tab-sync probe port (paired with the Kit build).
//
// Failing-first for the Kit port: on a tree without the port the Kit admin
// carries no tab-sync controller and the layout guard stays read-only, so the
// Kit section is red; the port makes it green without editing this file. The
// Hono section pins the contract the port must preserve (probe script on the
// moderator panel, signed-cookie round-trip across tabs, sign-out/expiry
// invalidation) and stays green throughout. Hermetic throughout — memory
// sessions, no database, no network, no secrets.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import production from "../src/index";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import type { Env } from "../src/env";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  SESSION_TTL_SECONDS,
  createMemorySessionStore,
  hashToken,
  newSessionToken,
} from "../src/sessions";
import { mergeCookies } from "./fixtures/session-recovery";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const SECRET = "test-kit-probe-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_MODERATOR_ROLE_IDS: "",
  SESSION_SECRET: SECRET,
};

async function moderatorCookie(store: ReturnType<typeof createMemorySessionStore>) {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({
    tokenHash,
    userId: "100000000000000111",
    username: "mod",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned(SESSION_COOKIE, token, SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return { cookie: serialized.split(";")[0]!, tokenHash };
}

function appWithStore(store: ReturnType<typeof createMemorySessionStore>) {
  return {
    request: (path: string, init?: RequestInit) =>
      production.request(new URL(path, APP_URL), init, { ...env, SESSION_STORE: store }),
  };
}

const probeCookie = (setCookies: string[]) =>
  setCookies.find((c) => c.startsWith(`${AUTH_STATUS_COOKIE}=`));

/** The bearer inside a `name=signed` cookie pair (unsigned half). */
const bearerOf = (pair: string): string => {
  const signedValue = decodeURIComponent(pair.slice(pair.indexOf("=") + 1).split(";")[0]!);
  return signedValue.slice(0, signedValue.lastIndexOf("."));
};

describe("Hono reference: moderator tab-sync probe (the contract the Kit port preserves)", () => {
  it("moderator GET /admin sets the signed probe cookie and exactly one tab-sync controller", async () => {
    const store = createMemorySessionStore();
    const mod = await moderatorCookie(store);
    const page = await appWithStore(store).request("/admin", {
      headers: { cookie: mod.cookie },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html.match(/data-testid="auth-tab-sync"/g)).toHaveLength(1);
    expect(html).toContain('<script src="/islands/auth-status.js"');
    const setCookies = page.headers.getSetCookie();
    const probe = probeCookie(setCookies);
    expect(probe).toBeDefined();
    for (const flag of [
      `${AUTH_STATUS_COOKIE}=`,
      "Path=/",
      "Secure",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${SESSION_TTL_SECONDS}`,
    ]) {
      expect(probe).toContain(flag);
    }
    expect(probe).not.toMatch(/Domain=/i);
    // The probe value is signed (value.signature), never a bare hash.
    expect(probe!.split(";")[0]!.split("=")[1]).toContain(".");
  });

  it("the signed probe cookie round-trips across two tabs without the session cookie", async () => {
    const store = createMemorySessionStore();
    const mod = await moderatorCookie(store);
    const { request } = appWithStore(store);
    // Tab A loads the panel and jar-merges both cookies, like a browser profile.
    const page = await request("/admin", { headers: { cookie: mod.cookie } });
    expect(page.status).toBe(200);
    const tabA = mergeCookies(mod.cookie, page);
    expect(tabA).toContain(AUTH_STATUS_COOKIE);

    // Tab B opens later with the same profile jar and rechecks the server.
    const recheck = await request("/auth/status", { headers: { cookie: tabA } });
    expect(recheck.status).toBe(200);
    expect(await recheck.json()).toEqual({ authenticated: true });
    expect(recheck.headers.getSetCookie()).toEqual([]);
    expect(recheck.headers.get("cache-control")).toBe("no-store, private");

    // The probe alone proves liveness: no session cookie, still authenticated,
    // so a rotated tab keeps syncing before its new Set-Cookie is delivered.
    const probeOnly = tabA.split("; ").find((c) => c.startsWith(`${AUTH_STATUS_COOKIE}=`))!;
    const lone = await request("/auth/status", { headers: { cookie: probeOnly } });
    expect(await lone.json()).toEqual({ authenticated: true });
    expect(lone.headers.getSetCookie()).toEqual([]);

    // A forged or absent probe never authenticates and never sets cookies.
    for (const bad of ["", `${AUTH_STATUS_COOKIE}=forged`]) {
      const res = await request("/auth/status", { headers: { cookie: bad } });
      expect(await res.json()).toEqual({ authenticated: false });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it("sign-out clears the probe cookie and revokes the lineage so both tabs read false", async () => {
    const store = createMemorySessionStore();
    const mod = await moderatorCookie(store);
    const { request } = appWithStore(store);
    const page = await request("/admin", { headers: { cookie: mod.cookie } });
    const jar = mergeCookies(mod.cookie, page);
    expect(jar).toContain(AUTH_STATUS_COOKIE);

    const logout = await request("/logout", {
      method: "POST",
      headers: { cookie: jar, origin: APP_URL },
    });
    expect(logout.status).toBe(303);
    const cleared = logout.headers.getSetCookie();
    expect(cleared.some((c) => c.startsWith(`${SESSION_COOKIE}=`) && /Max-Age=0/i.test(c))).toBe(
      true,
    );
    expect(
      cleared.some((c) => c.startsWith(`${AUTH_STATUS_COOKIE}=`) && /Max-Age=0/i.test(c)),
    ).toBe(true);

    // Both tabs share the revoked lineage: the old jar (and its probe alone)
    // now reads signed-out on the next recheck.
    expect(await (await request("/auth/status", { headers: { cookie: jar } })).json()).toEqual({
      authenticated: false,
    });
    const probeOnly = jar.split("; ").find((c) => c.startsWith(`${AUTH_STATUS_COOKIE}=`))!;
    expect(
      await (await request("/auth/status", { headers: { cookie: probeOnly } })).json(),
    ).toEqual({
      authenticated: false,
    });
  });

  it("expiry and revocation read false; a store outage is 503, never a false logout", async () => {
    const store = createMemorySessionStore();
    const { request } = appWithStore(store);
    const dead = await moderatorCookie(store);
    await store.revoke(dead.tokenHash);
    const revokedPage = await request("/admin", { headers: { cookie: dead.cookie } });
    expect(revokedPage.status).toBe(302);

    const live = await moderatorCookie(store);
    const livePage = await request("/admin", { headers: { cookie: live.cookie } });
    const jar = mergeCookies(live.cookie, livePage);
    vi.spyOn(store, "isActive").mockRejectedValueOnce(new Error("storage unavailable"));
    const outage = await request("/auth/status", { headers: { cookie: jar } });
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({ authenticated: false });

    // Revoke the jar's live bearer (the panel view already rotated the login
    // bearer): the lineage dies and the probe answers false.
    const liveHash = await hashToken(
      bearerOf(jar.split("; ").find((c) => c.startsWith(`${SESSION_COOKIE}=`))!),
    );
    await store.revoke(liveHash);
    expect(await (await request("/auth/status", { headers: { cookie: jar } })).json()).toEqual({
      authenticated: false,
    });
  });
});

describe("Kit admin tab-sync probe port (fails until the enablement slice lands it)", () => {
  const kitRouteSources = () => {
    const files = [
      "web/src/lib/AdminShell.svelte",
      "web/src/routes/admin/+page.svelte",
      "web/src/routes/admin/+layout.svelte",
      "web/src/routes/admin/+layout.server.ts",
      "web/src/hooks.server.ts",
      "src/route-ownership.ts",
    ];
    return files.map((f) => ({ file: f, body: read(f) }));
  };

  it("the Kit admin ships the tab-sync controller, not just a comment about it", () => {
    const sources = kitRouteSources();
    const withController = sources.filter((s) =>
      /<script[^>]*\/islands\/auth-status\.js[^>]*data-testid="auth-tab-sync"/.test(s.body),
    );
    expect(
      withController.map((s) => s.file),
      'Kit admin must render <script src="/islands/auth-status.js" defer data-testid="auth-tab-sync"> (today only a comment says it is not ported)',
    ).not.toHaveLength(0);
    for (const s of withController) {
      expect(s.body).toContain("defer");
    }
  });

  it("the Kit admin guard writes the signed probe cookie within the Hono scope", () => {
    const candidates = [
      "web/src/routes/admin/+layout.server.ts",
      "src/admin/kit-guard.ts",
      "web/src/hooks.server.ts",
      "src/route-ownership.ts",
    ];
    let bodies: string;
    try {
      bodies = candidates.map((f) => read(f)).join("\n");
      for (const extra of ["src/admin/kit-auth-status.ts", "src/kit-session.ts"]) {
        try {
          bodies += `\n${read(extra)}`;
        } catch {
          /* The port may reuse src/auth-status.ts instead of a new module. */
        }
      }
    } catch {
      expect.unreachable("Kit admin guard sources must remain readable");
      return;
    }
    // Same cookie the Hono panel signs: the shared name, never a renamed fork.
    expect(
      bodies,
      "Kit admin must reference the shared probe cookie (AUTH_STATUS_COOKIE / __Host-two_session_status); today the guard stays read-only",
    ).toMatch(/AUTH_STATUS_COOKIE|__Host-two_session_status/);
    // Same signing authority: the session secret via the shared helper or the
    // hono cookie primitive — a client-generated or unsigned value is a finding.
    expect(
      bodies,
      "Kit probe cookie must be signed with the session secret (prepareAuthStatus / generateSignedCookie / serializeSigned + SESSION_SECRET)",
    ).toMatch(/prepareAuthStatus|generateSignedCookie|serializeSigned/);
    expect(bodies).toMatch(/SESSION_SECRET/);
    // Same scope as src/auth-status.ts OPTIONS: host-only path, Secure,
    // HttpOnly, Lax, bounded lifetime — never a Domain or a session-cookie write.
    expect(bodies).toMatch(/Path=\/|path:\s*"\/"/);
    expect(bodies).toMatch(/[Ss]ameSite.*[Ll]ax|sameSite:\s*"lax"/);
    expect(bodies).toMatch(/Max-Age|SESSION_TTL_SECONDS|maxAge/);
  });

  it("the Kit probe adds no wider writes and the admin stays Hono-owned until enablement", () => {
    const layout = read("web/src/routes/admin/+layout.server.ts");
    // The probe cookie is the only cookie the Kit admin may write: the
    // session cookie stays Hono-issued, and rotation/revocation stay in the
    // Hono logout/read path (sibling CISO boundary; out of scope: flipping routes).
    expect(layout).not.toMatch(/__Host-two_session=/);
    expect(layout).not.toMatch(/issueSession|\.revoke\(|\.rotate\(|revokeLineage/);
    expect(layout).toContain("csr = false");
    const manifest = read("src/route-ownership.ts");
    expect(manifest).toMatch(/path:\s*"\/admin"/);
    expect(manifest).toMatch(/\/admin"[^}]*enabled:\s*false/);
    // No forked sync controller: the island stays the shipped first-party
    // binder, never a second TwoAuth definition in the Kit tree.
    for (const f of ["web/src/lib/AdminShell.svelte", "web/src/routes/admin/+page.svelte"]) {
      expect(read(f)).not.toContain("window.TwoAuth =");
    }
  });
});
