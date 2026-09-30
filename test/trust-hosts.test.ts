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

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
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

  it("absent Host requires a trusted URL signal; loopback has no exemption", () => {
    const url = "https://next.example.test";
    expect(isTrustedHost(url, [null])).toBe(false);
    expect(isTrustedHost(url, [undefined])).toBe(false);
    expect(isTrustedHost(url, [undefined, "next.example.test"])).toBe(true);
    for (const lb of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(isTrustedHost(url, [lb])).toBe(false);
    }
    expect(isTrustedHost(url, ["next.example.test", EVIL])).toBe(false);
    expect(isTrustedHost(url, [null, EVIL])).toBe(false);
  });

  it("a misconfigured APP_URL fails closed", () => {
    expect(isTrustedHost("not a url", ["anything.example"])).toBe(false);
    expect(isTrustedHost("not a url", [null])).toBe(false);
  });
});

describe("middleware: foreign Host refused before routing", () => {
  it.each(["/", "/about", "/health", "/sitemap_index.xml", "/robots.txt", "/auth/discord", "/join/discord"])(
    "%s with a foreign Host answers the branded 404 and never names the host",
    async (path) => {
      const res = await app.request(`${base.APP_URL}${path}`, { headers: evilHeaders }, base);
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
      const res = await app.request(`${base.APP_URL}${path}`, { headers: evilHeaders }, base);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(EVIL);
    }
  });

  it("the staging QA seam is unreachable under a spoofed Host even with the token", async () => {
    const res = await app.request(`${staging().APP_URL}/auth/qa/qa-member`, {
      method: "POST",
      headers: { ...evilHeaders, "X-TWO-QA-Auth": "qa-secret" },
    }, staging("qa-secret"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(EVIL);
  });

  it("lookalike and parent hosts refused; case/port variants of the real host accepted", async () => {
    for (const bad of ["sub.next.example.test", "example.test", "next.example.test.evil.com", "next.example.test."]) {
      const res = await app.request(`${base.APP_URL}/health`, { headers: { host: bad } }, base);
      expect(res.status).toBe(404);
    }
    for (const good of ["next.example.test", "NEXT.EXAMPLE.TEST", "next.example.test:8443"]) {
      const res = await app.request(`${base.APP_URL}/health`, { headers: { host: good } }, base);
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
    const res = await app.request(`${base.APP_URL}/sitemap_index.xml`, {
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
    expect((await app.request(`${staging().APP_URL}/health`, { headers: { host: "next.togetherweown.com" } }, staging())).status).toBe(200);
    expect((await app.request(`${production.APP_URL}/health`, { headers: { host: "togetherweown.com" } }, production)).status).toBe(200);
    expect((await app.request(`${base.APP_URL}/health`, { headers: { host: "next.example.test" } }, base)).status).toBe(200);
  });

  it("staging never accepts the production host and vice versa (not a global list)", async () => {
    expect((await app.request(`${staging().APP_URL}/health`, { headers: { host: "togetherweown.com" } }, staging())).status).toBe(404);
    expect((await app.request(`${production.APP_URL}/health`, { headers: { host: "next.togetherweown.com" } }, production)).status).toBe(404);
  });

  it("a foreign host is refused in every environment", async () => {
    for (const e of [base, staging(), production]) {
      const res = await app.request(`${e.APP_URL}/health`, { headers: evilHeaders }, e);
      expect(res.status).toBe(404);
    }
  });
});

describe("review regressions: fail closed at the Worker boundary", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("production refuses loopback %s", async (host) => {
    const header = await app.request("https://togetherweown.com/health", { headers: { host } }, production);
    expect(header.status).toBe(404);
    const url = await app.request(`http://${host}/health`, {}, production);
    expect(url.status).toBe(404);
  });

  it.each([
    "", ":443", "[", "[]", "[::1]garbage", "[::1]:bad", "::1",
    "next.example.test:443,evil.example.test", "next.example.test:443 evil.example.test",
    "next.example.test:", "next.example.test:bad", "next.example.test:65536",
    "next.example.test/path", "user@next.example.test", "next.example.test:443:8443",
  ])("a present malformed Host %j is not absent or trusted", async (host) => {
    expect(isTrustedHost(base.APP_URL, [host, "next.example.test"])).toBe(false);
    const res = await app.request(`${base.APP_URL}/health`, { headers: { host } }, base);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
  });

  it("a duplicate Host merged into one field is refused", async () => {
    const headers = new Headers({ host: "next.example.test:443" });
    headers.append("host", "evil.example.test");
    expect((await app.request(`${base.APP_URL}/health`, { headers }, base)).status).toBe(404);
  });

  it("invalid APP_URL never permits absent or loopback signals", () => {
    for (const appUrl of ["not a url", "", "file:///", "ftp://localhost"]) {
      for (const hosts of [[], [null], ["localhost"], ["127.0.0.1"], ["[::1]"]]) {
        expect(isTrustedHost(appUrl, hosts)).toBe(false);
      }
    }
  });

  it("loopback works only when it is the configured development host", async () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const env = { ...base, APP_URL: `http://${host}:8787` };
      expect((await app.request(`${env.APP_URL}/health`, { headers: { host: `${host}:8787` } }, env)).status).toBe(200);
      expect((await app.request(`${base.APP_URL}/health`, {}, env)).status).toBe(404);
    }
  });

  it("configured IPv6 is normalized on both sides, not rejected by bracket mismatch", async () => {
    const env = { ...base, APP_URL: "https://[2001:db8::1]" };
    expect(trustedHost(env.APP_URL)).toBe("2001:db8::1");
    expect((await app.request(`${env.APP_URL}/health`, {
      headers: { host: "[2001:0db8:0:0:0:0:0:1]:443" },
    }, env)).status).toBe(200);
    expect((await app.request("https://[2001:db8::2]/health", {}, env)).status).toBe(404);
  });

  it("the URL authority must be trusted even when Host is absent or trusted", async () => {
    const res = await app.request("https://evil.example.test/health", {
      headers: { host: "next.example.test" },
    }, base);
    expect(res.status).toBe(404);
    expect(isTrustedHost(base.APP_URL, [null])).toBe(false);
  });

  it("all HTTP traffic, including assets, enters the Worker first", () => {
    const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8")
      .replace(/^\s*\/\/.*$/gm, ""));
    expect(config.assets.run_worker_first).toBe(true);
    expect(config.assets.binding).toBe("ASSETS");
    expect(config.workers_dev).toBe(false);
  });

  it("trusted static requests reach ASSETS; foreign ones never do", async () => {
    const fetch = vi.fn(async () => new Response("body { color: white; }", {
      headers: { "content-type": "text/css" },
    }));
    const env = { ...base, ASSETS: { fetch } };
    const bad = await app.request("https://evil.example.test/styles.css", {}, env);
    expect(bad.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    const spoofed = await app.request(`${base.APP_URL}/styles.css`, { headers: evilHeaders }, env);
    expect(spoofed.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    const good = await app.request(`${base.APP_URL}/styles.css`, {}, env);
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toBe("text/css");
    expect(await good.text()).toContain("color: white");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("missing assets still get the branded DB-free 404", async () => {
    const env = { ...base, ASSETS: { fetch: vi.fn(async () => new Response(null, { status: 404 })) } };
    const res = await app.request(`${base.APP_URL}/missing.css`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("We cannot find that page");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
  });
});

describe("absolute URLs stable under a spoofed Host (APP_URL-derived, never Host-derived)", () => {
  it("home canonical names APP_URL on a trusted Host; a spoofed Host yields no evil canonical", async () => {
    const ok = await app.request(`${base.APP_URL}/`, { headers: { host: "next.example.test" } }, base);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('<link rel="canonical" href="https://next.example.test/"');
    const spoofed = await app.request(`${base.APP_URL}/`, { headers: evilHeaders }, base);
    expect(spoofed.status).toBe(404);
    expect(await spoofed.text()).not.toContain(EVIL);
  });

  it("OAuth redirect_uri values name APP_URL; spoofed Hosts never mint an evil redirect", async () => {
    const login = await app.request(`${base.APP_URL}/auth/discord`, { headers: { host: "next.example.test" } }, base);
    expect(login.status).toBe(302);
    expect(new URL(login.headers.get("location")!).searchParams.get("redirect_uri")).toBe(
      "https://next.example.test/auth/discord/callback",
    );
    const join = await app.request(`${base.APP_URL}/join/discord`, { headers: { host: "next.example.test" } }, base);
    expect(join.status).toBe(302);
    expect(new URL(join.headers.get("location")!).searchParams.get("redirect_uri")).toBe(
      "https://next.example.test/join/callback",
    );
    for (const path of ["/auth/discord", "/join/discord"]) {
      const res = await app.request(`${base.APP_URL}${path}`, { headers: evilHeaders }, base);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).not.toContain(EVIL);
    }
  });

  it("sitemap locs and the robots Sitemap line name APP_URL; spoofed Hosts get no index", async () => {
    const sm = await app.request(`${base.APP_URL}/sitemap_index.xml`, { headers: { host: "next.example.test" } }, base);
    expect(sm.status).toBe(200);
    const xml = await sm.text();
    expect(xml).toContain("<loc>https://next.example.test/</loc>");
    expect(xml).not.toContain(EVIL);
    const robots = await app.request(`${base.APP_URL}/robots.txt`, { headers: { host: "next.example.test" } }, base);
    expect(await robots.text()).toContain("Sitemap: https://next.example.test/sitemap_index.xml");
    for (const path of ["/sitemap_index.xml", "/robots.txt"]) {
      const res = await app.request(`${base.APP_URL}${path}`, { headers: evilHeaders }, base);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(EVIL);
    }
  });
});
