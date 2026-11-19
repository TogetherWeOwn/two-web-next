import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { securityHeadersFor } from "../src/http/secure-headers";
import { LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import { fetchApp } from "./helpers/fetch-app";

// Independent wire goldens from before Hono and Kit shared the builder.
const BASE_CSP =
  "default-src 'self'; base-uri 'self'; connect-src 'self'; object-src 'none'; " +
  "img-src 'self' https://cdn.discordapp.com; frame-src 'none'; style-src 'self'; " +
  "script-src 'self'; font-src 'self'; frame-ancestors 'none'; form-action 'self'; report-to csp-endpoint";

const STATIC_HEADERS = {
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
  "X-XSS-Protection": "0",
};

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

// Include intentionally absent headers so e.g. adding app-owned HSTS fails.
const SECURITY_HEADER =
  /^(cross-origin-|origin-agent-cluster$|referrer-policy$|strict-transport-security$|x-content-type-options$|x-dns-prefetch-control$|x-download-options$|x-frame-options$|x-permitted-cross-domain-policies$|x-xss-protection$|content-security-policy|permissions-policy$|reporting-endpoints$|report-to$|x-powered-by$)/;

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

describe("securityHeadersFor preserves the Hono wire policy", () => {
  for (const featured of [undefined, "cdn.example.test, img.example.test"]) {
    for (const [method, path] of cases) {
      it(`${method} ${path} (featured hosts: ${featured ?? "none"})`, async () => {
        let csp = BASE_CSP;
        if (featured) {
          csp = csp.replace(
            "https://cdn.discordapp.com;",
            "https://cdn.discordapp.com https://cdn.example.test https://img.example.test;",
          );
        }
        if (path === "/join" && method !== "POST") {
          csp = csp.replace("frame-src 'none'", "frame-src https://discord.com/widget");
        }
        if (path === "/" || path === "/rules") {
          csp = csp.replace(
            "style-src 'self'",
            `style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`,
          );
        }
        const expected = Object.entries({
          ...STATIC_HEADERS,
          "Content-Security-Policy": csp,
          "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
          "Reporting-Endpoints": 'csp-endpoint="/csp-reports"',
        });
        expect(securityHeadersFor({ path, method }, featured)).toEqual(expected);

        const res = await fetchApp(
          new Request(`${env.APP_URL}${path}`, { method, headers: { host: "next.example.test" } }),
          { ...env, FEATURED_IMAGE_HOSTS: featured },
          {} as ExecutionContext,
        );
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
