import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

function directives(res: Response): Record<string, string> {
  const csp = res.headers.get("content-security-policy");
  expect(csp).not.toBeNull();
  return Object.fromEntries(csp!.split(";").map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources.join(" ")];
  }));
}

describe("route CSP (local fixtures, no DB)", () => {
  it.each(["GET", "HEAD"])("%s /join permits only the Discord widget origin", async (method) => {
    const res = await app.request("/join?next=/events", { method }, env);
    expect(res.status).toBe(200);
    const csp = directives(res);
    expect(csp["frame-src"]).toBe("https://discord.com");
    expect(csp["default-src"]).toBe("'self'");
    expect(csp["script-src"]).toBe("'self'");
    expect(csp["style-src"]).toBe("'self'");
    expect(csp["frame-ancestors"]).toBe("'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    if (method === "GET") expect(await res.text()).toContain("https://discord.com/widget?id=");
  });

  it.each(["/", "/about", "/faq", "/privacy", "/join/discord", "/join/callback", "/join/recovery", "/join/", "/JOIN", "/admin", "/profile", "/missing"])("%s does not gain iframe permission", async (path) => {
    const res = await app.request(path, {}, env);
    expect(directives(res)["frame-src"]).toBe("'none'");
  });

  it("POST /join cannot gain the page's frame permission", async () => {
    const res = await app.request("/join", { method: "POST" }, env);
    expect(directives(res)["frame-src"]).toBe("'none'");
  });

  it("shares configured exact image hosts across routes, without broad sources", async () => {
    const configured = { ...env, FEATURED_IMAGE_HOSTS: "images.unsplash.com,*.evil.com,localhost,10.0.0.1,evil.com;script-src *" };
    for (const path of ["/join", "/about", "/admin", "/missing"]) {
      const res = await app.request(path, {}, configured);
      expect(directives(res)["img-src"]).toBe("'self' https://cdn.discordapp.com https://images.unsplash.com");
      expect(directives(res)["script-src"]).toBe("'self'");
    }
    // No module-global configuration leaks between requests.
    expect(directives(await app.request("/about", {}, env))["img-src"])
      .toBe("'self' https://cdn.discordapp.com");
  });

  it.each(["localdomain", "localhost.localdomain", "cdn.localhost.localdomain", "alt", "images.alt", "cdn.images.alt", "corp", "images.corp", "cdn.images.corp", "mail", "images.mail", "cdn.images.mail"])("omits configured reserved namespace %s from CSP", async (host) => {
    const configured = { ...env, FEATURED_IMAGE_HOSTS: `images.unsplash.com,${host}` };
    for (const path of ["/join", "/about"]) {
      const res = await app.request(path, {}, configured);
      expect(directives(res)["img-src"]).toBe("'self' https://cdn.discordapp.com https://images.unsplash.com");
    }
  });

  it("keeps both report directives and the reporting destination unchanged", async () => {
    for (const path of ["/join", "/about"]) {
      const res = await app.request(path, {}, env);
      expect(directives(res)["report-uri"]).toBe("/csp-reports");
      expect(directives(res)["report-to"]).toBe("csp-endpoint");
      expect(res.headers.get("reporting-endpoints")).toBe('csp-endpoint="/csp-reports"');
      expect(res.headers.get("report-to")).toBeNull();
    }
    const report = await app.request("/csp-reports", { method: "POST", body: "{}" }, env);
    expect(report.status).toBe(204);
    expect(directives(report)["frame-src"]).toBe("'none'");
  });
});
