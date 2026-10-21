// route-inventory: GET /auth/recover
// SvelteKit migration card 20/43: GET /auth/recover and the HTML outcomes from
// /join/callback + auth recovery render through the injected Svelte outcome
// renderer (RecoveryModel via renderHtmlOutcome), preserving the Hono
// controllers and the one-use OAuth state/journey logic. The Hono bytes,
// statuses, redirects and cookie clearing stay identical; the Kit route stays
// Hono-owned (enabled: false) until the enablement review.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { renderHtmlOutcome } from "../src/html-outcome";
import { honoRecoveryRenderer } from "../src/recovery-hono";
import { recoveryOutcome, type RecoveryModel } from "../src/recovery-outcome";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { recoveryLanding } from "../src/write-recovery";

const SECRET = "local-fixture-secret-at-least-32-bytes-long";
const TOKEN = "user-token-secret-xyz-never-rendered";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: SECRET,
  DISCORD_MODERATOR_ROLE_IDS: "1546777856984481792",
};

// In-memory Sql double for the journey's two statements (throttle window +
// join_attempts insert), mirroring test/join.test.ts. Anything else is a test
// bug, surfaced loudly.
function fakeSql() {
  const throttle: { bucket: string; at: number }[] = [];
  const attempts: {
    outcome: string;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("count(*)")) {
      const [bucket] = values as [string];
      const cutoff = Date.now() - 60_000;
      const rows = throttle.filter((r) => r.bucket === bucket && r.at > cutoff);
      const wait =
        rows.length === 0
          ? 1
          : Math.max(
              1,
              Math.ceil((Math.min(...rows.map((r) => r.at)) + 60_000 - Date.now()) / 1000),
            );
      return [{ n: rows.length, wait }];
    }
    if (head.includes("INSERT INTO web_throttle_hits")) {
      throttle.push({ bucket: values[0] as string, at: Date.now() });
      return [];
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) {
      const [outcome, source, requestId, discordId] = values as [
        string,
        string | null,
        string | null,
        string | null,
      ];
      attempts.push({ outcome, source, requestId, discordId });
      return [];
    }
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  (sql as unknown as { begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown> }).begin = (
    run,
  ) => run(sql);
  return { sql, attempts };
}

function isolated() {
  const fake = fakeSql();
  const e = {
    ...env,
    SESSION_STORE: createMemorySessionStore(),
    JOIN_DEPS: { store: async () => fake.sql },
  } as unknown as Env;
  return { fake, env: e };
}

function mockDiscord({
  joinStatus = 201,
  token = TOKEN,
}: {
  joinStatus?: number;
  token?: string;
} = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) {
        if (token === "EXCHANGE_FAILS") return new Response("bad", { status: 500 });
        return Response.json({ access_token: token });
      }
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && (init as RequestInit)?.method === "PUT")
        return new Response(null, { status: joinStatus });
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

async function startJoin(e: Env, query = "") {
  const res = await app.request(`/join/discord${query}`, {}, e);
  const location = res.headers.get("location") ? new URL(res.headers.get("location")!) : null;
  return {
    state: location?.searchParams.get("state") ?? null,
    cookie: cookiesFrom(res),
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectRecoveryShell(html: string) {
  // The shared shell every renderer must carry: heading, message lead, retry
  // button and invite fallback with stable testids, no inline scripts (the
  // recovery pages ship no JavaScript, so no-JS holds byte-for-byte).
  expect(html).toContain('id="recovery-heading"');
  expect(html).toContain('data-testid="recovery-retry"');
  expect(html).toContain('data-testid="recovery-invite"');
  expect(html).toContain('class="recovery-actions"');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<iframe");
}

describe("recovery outcomes through the injected renderer", () => {
  it("the Hono adapter keeps the default 200 + private no-store contract", async () => {
    const model: RecoveryModel = {
      title: "Your session expired",
      message: "Sign in again, then review and submit them when you are ready.",
      retryUrl: "/auth/discord?next=%2Fprofile",
      retryLabel: "Log in with Discord",
      inviteUrl: "/discord",
    };
    const f = new Hono<{ Bindings: Env }>();
    f.get("/recover", (c) => renderHtmlOutcome(c, recoveryOutcome(model, honoRecoveryRenderer)));
    const res = await f.request("/recover", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const html = await res.text();
    expectRecoveryShell(html);
    expect(html).toContain("Your session expired");
    expect(html).toContain('href="/auth/discord?next=%2Fprofile"');
    expect(html).toContain('href="/discord"');
  });

  it("a 503 outage outcome keeps its status through the injected renderer", async () => {
    const f = new Hono<{ Bindings: Env }>();
    f.get("/recover", (c) =>
      renderHtmlOutcome(
        c,
        recoveryOutcome(
          {
            title: "Discord is unreachable",
            message: "We couldn't reach Discord to complete the join.",
            retryUrl: "/join/discord",
            retryLabel: "Try again",
            inviteUrl: "https://discord.gg/invite",
          },
          honoRecoveryRenderer,
          { status: 503 },
        ),
      ),
    );
    const res = await f.request("/recover", {}, env);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expectRecoveryShell(await res.text());
  });

  it("cookies set before the injected render survive on the finished response", async () => {
    // The recoveryLanding refactor risk: the two signed journey cookies are
    // written before renderHtmlOutcome buffers the body. If buffering dropped
    // context headers, the one-use journey would silently break.
    const f = new Hono<{ Bindings: Env }>();
    const { setSignedCookie } = await import("hono/cookie");
    f.get("/recover", async (c) => {
      await setSignedCookie(c, "__Host-two_probe", "pending|/profile", c.env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        maxAge: 600,
      });
      return renderHtmlOutcome(
        c,
        recoveryOutcome(
          {
            title: "probe",
            message: "probe",
            retryUrl: "/join/discord",
            retryLabel: "Try again",
            inviteUrl: "/discord",
          },
          honoRecoveryRenderer,
        ),
      );
    });
    const res = await f.request("/recover", {}, env);
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toContain("__Host-two_probe=");
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
  });

  it("GET /auth/recover keeps status, the intended cookie, copy and shell through the refactor", async () => {
    const probe = new Hono();
    probe.get("/auth/recover", (c) => recoveryLanding(c));
    const res = await probe.request("/auth/recover?next=%2Fprofile%3Fedit%3D1", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const html = await res.text();
    expect(html).toContain("Your earlier changes were not saved");
    expect(html).toContain('href="/auth/discord?next=%2Fprofile%3Fedit%3D1"');
    expectRecoveryShell(html);
    const set = res.headers.getSetCookie();
    expect(set.some((c) => c.startsWith("__Host-two_login_intended="))).toBe(true);
    // The landing never mints the pending notice: only a genuine
    // expired-write bounce arms it.
    expect(set.some((c) => c.startsWith("__Host-two_expired_write="))).toBe(false);
  });

  it("join denial renders the shared shell at 200 with no echo, no exchange and cleared journey cookies", async () => {
    const { fake, env: e } = isolated();
    const calls = mockDiscord();
    const start = await startJoin(e, "?source=web-homepage&next=/events");
    const res = await app.request(
      `/join/callback?error=access_denied&error_description=${TOKEN}&state=${start.state}`,
      { headers: { cookie: start.cookie } },
      e,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const html = await res.text();
    expect(html).toContain("Join cancelled");
    expectRecoveryShell(html);
    expect(html).toContain('href="/join/discord?next=%2Fevents&amp;source=web-homepage"');
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain("error_description");
    expect(calls).toHaveLength(0);
    const requestId = res.headers.get("x-request-id");
    expect(fake.attempts).toEqual([
      { outcome: "denied", source: "web-homepage", requestId, discordId: null },
    ]);
    const cleared = res.headers.getSetCookie().join("\n");
    for (const name of ["state", "source", "next"]) {
      const line = cleared.split("\n").find((c) => c.startsWith(`__Host-two_join_${name}=`))!;
      expect(line, `clears join ${name}`).toContain("__Host-two_join_");
      expect(line).toMatch(/Max-Age=0/i);
      expect(line).toMatch(/Secure/i);
      expect(line).toMatch(/HttpOnly/i);
      expect(line).toMatch(/SameSite=Lax/i);
    }
  });

  it("a replayed callback renders expired at 200 with no second exchange, attempt or session", async () => {
    const { fake, env: e } = isolated();
    const calls = mockDiscord({ joinStatus: 201 });
    const { state, cookie } = await startJoin(e, "?source=web-homepage");
    const first = await app.request(
      `/join/callback?code=abc&state=${state}`,
      { headers: { cookie } },
      e,
    );
    expect(first.status).toBe(302);
    const exchanges = calls.length;
    expect(fake.attempts).toHaveLength(1);
    // Replay with the same one-use state: the journey is consumed, so this is
    // an expired recovery render, never a second token exchange.
    const replay = await app.request(
      `/join/callback?code=abc&state=${state}`,
      { headers: { cookie } },
      e,
    );
    expect(replay.status).toBe(200);
    const html = await replay.text();
    expect(html).toContain("Join link expired");
    expectRecoveryShell(html);
    expect(html).not.toContain(TOKEN);
    expect(calls).toHaveLength(exchanges);
    expect(fake.attempts).toHaveLength(1);
    expect(replay.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
  });

  it("a Discord outage renders the shared shell at 503 with retry + invite and no token", async () => {
    const { fake, env: e } = isolated();
    mockDiscord({ token: "EXCHANGE_FAILS" });
    const { state, cookie } = await startJoin(e);
    const res = await app.request(
      `/join/callback?code=abc&state=${state}`,
      { headers: { cookie } },
      e,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const html = await res.text();
    expect(html).toContain("Discord is unreachable");
    expectRecoveryShell(html);
    expect(html).toContain('href="/join/discord"');
    expect(html).not.toContain(TOKEN);
    expect(fake.attempts[0]).toMatchObject({ outcome: "error" });
  });
});

// The Kit load + page are thin bindings over the shared RecoveryModel shape
// (cloudflare:workers + SvelteKit imports stay out of the root test process);
// these source pins guard the markup contract the same way
// test/discord-widget-snapshot.test.ts pins the shipped island by reading it
// as text. Every shell/testid/URL acceptance item is named here, so deleting
// one fails this file first.
describe("Kit GET /auth/recover markup contract (Recovery shell parity)", () => {
  const lib = readFileSync(new NodeURL("../web/src/lib/Recovery.svelte", import.meta.url), "utf8");
  const page = readFileSync(
    new NodeURL("../web/src/routes/auth/recover/+page.svelte", import.meta.url),
    "utf8",
  );
  const load = readFileSync(
    new NodeURL("../web/src/routes/auth/recover/+page.server.ts", import.meta.url),
    "utf8",
  );
  const manifest = readFileSync(new NodeURL("../src/route-ownership.ts", import.meta.url), "utf8");

  it("the shared shell carries the Hono Recovery markers with no untrusted HTML", () => {
    for (const needle of [
      'id="recovery-heading"',
      'data-testid="recovery-retry"',
      'data-testid="recovery-invite"',
      'class="recovery-actions"',
      "recovery-hero",
      "Let's get you back to the lobby",
      "Join with an invite link instead",
      "Welcome, guest",
      'class="account-caption"',
      'theme="home"',
    ]) {
      expect(lib, `missing ${needle}`).toContain(needle);
    }
    // The tab-title site suffix rides SiteMetadata's derivation: a bare model
    // title through Shell, suffixed once like the Hono RecoveryShell — never
    // a pre-suffixed title prop (which double-suffixed).
    expect(lib).toContain("title={title}");
    expect(lib).toContain("Shell");
    expect(lib).not.toContain("{@html");
    expect(lib).not.toContain("<script src");
    expect(lib).not.toContain("<iframe");
    // The shell renders display copy only: no session, database or network
    // reads merely to offer recovery (same posture as the Hono RecoveryShell).
    expect(lib).not.toMatch(/getSignedCookie|readSession|dbFor|ADMIN_DB|SESSION_STORE|fetch\(/);
  });

  it("the page binds the whole RecoveryModel, no canonical divergence", () => {
    // The Hono Recovery ships no canonical link (transient outcome page, like
    // the branded error shells' posture): the Kit page mirrors that absence
    // instead of inventing metadata Hono never sends.
    // Guest chrome (Welcome caption + Join button) lives in the shared
    // Recovery shell, pinned above; the page only binds the model to it.
    for (const needle of [
      "Recovery",
      "title",
      "message",
      "retryUrl",
      "retryLabel",
      "inviteUrl",
      "PageProps",
      "data",
    ]) {
      expect(page, `missing ${needle}`).toContain(needle);
    }
    expect(page).not.toContain("{@html");
    expect(page).not.toContain("<script src");
    expect(page).not.toContain("<iframe");
  });

  it("the load stays server-rendered with safe next, private no-store and no journey writes", () => {
    expect(load).toContain("csr = false");
    expect(load).toContain("safeNext");
    expect(load).toContain("no-store, private");
    expect(load).toContain("Your session expired");
    expect(load).toContain("Your earlier changes were not saved");
    expect(load).toContain("Log in with Discord");
    expect(load).toContain("/auth/discord?next=");
    expect(load).toContain('inviteUrl: "/discord"');
    // The one-use journey writes stay Hono-owned: the Kit load never mints,
    // consumes or signs journey state, reads sessions or touches the database.
    expect(load).not.toMatch(
      /setSignedCookie|cookies\.set|SESSION_STORE|ADMIN_DB|kitSessionBridge|memberRead|journeys/,
    );
  });

  it("registers a public, Hono-owned manifest entry", () => {
    expect(manifest).toMatch(/path:\s*"\/auth\/recover"/);
    expect(manifest).toMatch(/\/auth\/recover"[^}]*reads:\s*"public"/);
    // Stays on Hono until the enablement review: flipping enabled flips
    // ownership, and the parity ledger fails any enabled route with no run.
    expect(manifest).toMatch(/\/auth\/recover"[^}]*enabled:\s*false/);
  });
});
