import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { securityHeadersFor } from "../src/http/secure-headers";
import { fetchApp } from "./helpers/fetch-app";

// These fetch-seam comparisons pin where Hono applies the shared policy.
// They do not independently prove the builder's values: the CSP/COEP/SEO
// assertions and base-to-head Hono wire recordings cover policy equivalence.

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

// Include headers the adapter must not add, such as HSTS and Report-To.
const SECURITY_HEADER =
  /^(cross-origin-|origin-agent-cluster$|referrer-policy$|strict-transport-security$|x-content-type-options$|x-dns-prefetch-control$|x-download-options$|x-frame-options$|x-permitted-cross-domain-policies$|x-xss-protection$|content-security-policy|permissions-policy$|reporting-endpoints$|report-to$)/;

const cases: Array<[string, string]> = [
  ["GET", "/"],
  ["GET", "/join"],
  ["HEAD", "/join"],
  ["POST", "/join"],
  ["GET", "/rules"],
  ["GET", "/events/past"],
  ["GET", "/no-such-page"],
  ["POST", "/api/agent-events"],
];

describe("Hono fetch applies securityHeadersFor", () => {
  for (const featured of [undefined, "cdn.example.com, img.example.com"]) {
    for (const [method, path] of cases) {
      it(`${method} ${path} (featured hosts: ${featured ?? "none"})`, async () => {
        const res = await fetchApp(
          new Request(`${env.APP_URL}${path}`, { method, headers: { host: "next.example.test" } }),
          { ...env, FEATURED_IMAGE_HOSTS: featured },
          {} as ExecutionContext,
        );
        const expected = securityHeadersFor({ path, method }, featured);
        for (const [name, value] of expected) expect(res.headers.get(name), name).toBe(value);
        const emitted = [...res.headers.keys()].filter((name) => SECURITY_HEADER.test(name)).sort();
        expect(emitted).toEqual(expected.map(([name]) => name.toLowerCase()).sort());
      });
    }
  }

  it("frames the Discord widget only on GET/HEAD /join", () => {
    const frameSrc = (path: string, method: string) =>
      /frame-src ([^;]+)/.exec(
        new Map(securityHeadersFor({ path, method })).get("Content-Security-Policy")!,
      )![1];
    expect(frameSrc("/join", "GET")).toBe("https://discord.com/widget");
    expect(frameSrc("/join", "POST")).toBe("'none'");
    expect(frameSrc("/events/past", "GET")).toBe("'none'");
  });
});
