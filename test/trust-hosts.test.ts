// TrustHosts re-expression (W16: TOG-10110). Ports two-web's
// App\Http\Middleware\TrustHosts (APP_URL host only): only the APP_URL host
// is trusted; anything else is refused before routing. Workers terminate TLS
// at the edge, so there is no proxy layer — and X-Forwarded-Host is ignored
// (client-controlled; honouring it is the poisoning vector).
//
// Contract pinned here:
// - foreign Host → branded DB-free 404 (same page as an unknown path), never
//   a bare error, and the body never names the refused host.
// - per-env: the allowlist derives from that environment's APP_URL, so
//   staging never accepts the production host and vice versa.
// - absolute URLs (canonical, OAuth redirect_uri, sitemap, robots) derive
//   from APP_URL, never from Host: stable under a spoofed Host.

import { describe, expect, it } from "vitest";
import app from "../src/index";
import { isTrustedHost, normalizeHost, trustedHost } from "../src/trust-hosts";
import type { Env } from "../src/env";

const base: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const EVIL = "evil.example.test";
const evilHeaders = { host: EVIL };

const staging = (token?: string): Env => ({
  ...base,
  APP_URL: "https://next.togetherweown.com",
  ...(token ? { QA_AUTH_TOKEN: token } : {}),
});
const production: Env = { ...base, APP_URL: "https://togetherweown.com" };

describe("unit: host matching", () => {
  it("trustedHost takes the APP_URL hostname, lowercased; garbage fails closed", () => {
    expect(trustedHost("https://next.togetherweown.com")).toBe("next.togetherweown.com");
    expect(trustedHost("https://NEXT.example.test/x")).toBe("next.example.test");
    expect(trustedHost("not a url")).toBeNull();
    expect(trustedHost("")).toBeNull();
  });

  it("normalizeHost strips ports/brackets/case; empty is absent", () => {
    expect(normalizeHost("next.example.test:8443")).toBe("next.example.test");
    expect(normalizeHost("NEXT.EXAMPLE.TEST")).toBe("next.example.test");
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("  ")).toBeNull();
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost(undefined)).toBeNull();
  });

  it("exact match only: subdomains, parents, lookalikes and FQDN dots refused", () => {
    const url = "https://next.example.test";
    expect(isTrustedHost(url, ["next.example.test"])).toBe(true);
    expect(isTrustedHost(url, ["NEXT.EXAMPLE.TEST"])).toBe(true);
    expect(isTrustedHost(url, ["next.example.test:443"])).toBe(true);
    for (const bad of [
      "sub.next.example.test",
      "example.test",
      "evilnext.example.test",
      "next.example.test.evil.com",
      "next.example.test.",
      "evil.example.test",
    ]) {
      expect(isTrustedHost(url, [bad])).toBe(false);
    }
  });

  it("absent Host and loopback are allowed (synthetic traffic + wrangler dev); one bad signal refuses", () => {
    const url = "https://next.example.test";
    expect(isTrustedHost(url, [null])).toBe(true);
    expect(isTrustedHost(url, [undefined])).toBe(true);
    for (const lb of ["localhost", "127.0.0.1", "::1"]) {
      expect(isTrustedHost(url, [lb])).toBe(true);
    }
    expect(isTrustedHost(url, ["next.example.test", EVIL])).toBe(false);
    expect(isTrustedHost(url, [null, EVIL])).toBe(false);
  });

  it("a misconfigured APP_URL fails closed", () => {
    expect(isTrustedHost("not a url", ["anything.example"])).toBe(false);
    expect(isTrustedHost("not a url", [null])).toBe(true);
  });
});

describe("middleware: foreign Host refused before routing", () => {
  it.each(["/", "/about", "/health", "/sitemap_index.xml", "/robots.txt", "/auth/discord", "/join/discord"])(
    "%s with a foreign Host answers the branded 404 and never names the host",
    async (path) => {
      const res = await app.request(path, { headers: evilHeaders }, base);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("We cannot find that page");
      expect(body).not.toContain(EVIL);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
    },
  );

  it("mounted sub-apps refuse too: /admin, /profile and the machine ingress", async () => {
    for (const path of ["/admin", "/profile", "/api/agent-events"]) {
      const res = await app.request(path, { headers: evilHeaders }, base);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(EVIL);
    }
  });

  it("the staging QA seam is unreachable under a spoofed Host even with the token", async () => {
    const res = await app.request("/auth/qa/qa-member", {
      method: "POST",
      headers: { ...evilHeaders, "X-TWO-QA-Auth": "qa-secret" },
    }, staging("qa-secret"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(EVIL);
  });

  it("lookalike and parent hosts refused; case/port variants of the real host accepted", async () => {
    for (const bad of ["sub.next.example.test", "example.test", "next.example.test.evil.com", "next.example.test."]) {
      const res = await app.request("/health", { headers: { host: bad } }, base);
      expect(res.status).toBe(404);
    }
    for (const good of ["next.example.test", "NEXT.EXAMPLE.TEST", "next.example.test:8443"]) {
      const res = await app.request("/health", { headers: { host: good } }, base);
      expect(res.status).toBe(200);
    }
  });

  it("an absolute request URL to a foreign host is refused; to the trusted host it passes", async () => {
    const bad = await app.request("https://evil.example.test/health", {}, base);
    expect(bad.status).toBe(404);
    const good = await app.request("https://next.example.test/health", {}, base);
    expect(good.status).toBe(200);
  });

  it("X-Forwarded-Host is ignored: trusted Host + evil forward passes with APP_URL URLs", async () => {
    const res = await app.request("/sitemap_index.xml", {
      headers: { host: "next.example.test", "x-forwarded-host": EVIL },
    }, base);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("https://next.example.test/");
    expect(xml).not.toContain(EVIL);
  });
});

describe("middleware: per-env allowlist", () => {
  it("each environment accepts its own host", async () => {
    expect((await app.request("/health", { headers: { host: "next.togetherweown.com" } }, staging())).status).toBe(200);
    expect((await app.request("/health", { headers: { host: "togetherweown.com" } }, production)).status).toBe(200);
    expect((await app.request("/health", { headers: { host: "next.example.test" } }, base)).status).toBe(200);
  });

  it("staging never accepts the production host and vice versa (not a global list)", async () => {
    expect((await app.request("/health", { headers: { host: "togetherweown.com" } }, staging())).status).toBe(404);
    expect((await app.request("/health", { headers: { host: "next.togetherweown.com" } }, production)).status).toBe(404);
  });

  it("a foreign host is refused in every environment", async () => {
    for (const e of [base, staging(), production]) {
      const res = await app.request("/health", { headers: evilHeaders }, e);
      expect(res.status).toBe(404);
    }
  });
});

describe("absolute URLs stable under a spoofed Host (APP_URL-derived, never Host-derived)", () => {
  it("home canonical names APP_URL on a trusted Host; a spoofed Host yields no evil canonical", async () => {
    const ok = await app.request("/", { headers: { host: "next.example.test" } }, base);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('<link rel="canonical" href="https://next.example.test/"');
    const spoofed = await app.request("/", { headers: evilHeaders }, base);
    expect(spoofed.status).toBe(404);
    expect(await spoofed.text()).not.toContain(EVIL);
  });

  it("OAuth redirect_uri values name APP_URL; spoofed Hosts never mint an evil redirect", async () => {
    const login = await app.request("/auth/discord", { headers: { host: "next.example.test" } }, base);
    expect(login.status).toBe(302);
    expect(new URL(login.headers.get("location")!).searchParams.get("redirect_uri")).toBe(
      "https://next.example.test/auth/discord/callback",
    );
    const join = await app.request("/join/discord", { headers: { host: "next.example.test" } }, base);
    expect(join.status).toBe(302);
    expect(new URL(join.headers.get("location")!).searchParams.get("redirect_uri")).toBe(
      "https://next.example.test/join/callback",
    );
    for (const path of ["/auth/discord", "/join/discord"]) {
      const res = await app.request(path, { headers: evilHeaders }, base);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).not.toContain(EVIL);
    }
  });

  it("sitemap locs and the robots Sitemap line name APP_URL; spoofed Hosts get no index", async () => {
    const sm = await app.request("/sitemap_index.xml", { headers: { host: "next.example.test" } }, base);
    expect(sm.status).toBe(200);
    const xml = await sm.text();
    expect(xml).toContain("<loc>https://next.example.test/</loc>");
    expect(xml).not.toContain(EVIL);
    const robots = await app.request("/robots.txt", { headers: { host: "next.example.test" } }, base);
    expect(await robots.text()).toContain("Sitemap: https://next.example.test/sitemap_index.xml");
    for (const path of ["/sitemap_index.xml", "/robots.txt"]) {
      const res = await app.request(path, { headers: evilHeaders }, base);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(EVIL);
    }
  });
});
