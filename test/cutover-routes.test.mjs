import { expect, it } from "vitest";
import app from "../src/index";
import { parseArgs, runChecks } from "../ci/cutover-check.mjs";

const leaves = ["/about", "/faq", "/rules", "/privacy"];
const retiredPaths = ["/health", "/healthz", "/db-ping", "/members", "/members/"];

for (const phase of ["before", "after"]) {
  it(`${phase} URL gates accept actual retired-path 404s without database bindings`, async () => {
    const target = phase === "before" ? "next.togetherweown.com" : "togetherweown.com";
    const options = parseArgs(["--phase", phase, "--target", target, "--event-key", "fixture"]);
    const env = { APP_URL: `https://${target}` };
    const seen = [];
    const result = await runChecks(options, {
      resolver: { resolve4: async () => ["127.0.0.1"], resolve6: async () => [] },
      request: async (url) => {
        const parsed = new URL(url);
        if (parsed.hostname !== target || !retiredPaths.includes(parsed.pathname)) {
          return { status: 404, headers: {}, body: "", tlsVerified: true };
        }
        seen.push(parsed.pathname);
        const response = await app.request(url, {}, env);
        expect(response.status).toBe(404);
        expect(response.headers.getSetCookie()).toHaveLength(0);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
          tlsVerified: true,
        };
      },
    });
    // Unrelated gates deliberately fail; all retired-path gates must exist and pass.
    expect(seen.sort()).toEqual([...retiredPaths].sort());
    const diagnosticChecks = result.checks.filter((check) =>
      retiredPaths.some((path) => check.id === `url:${path}`),
    );
    expect(diagnosticChecks).toHaveLength(retiredPaths.length);
    expect(diagnosticChecks.filter((check) => !check.ok)).toEqual([]);
  });

  it(`${phase} login alias gates accept the actual DB-free temporary redirect`, async () => {
    // Hostnames are in-process identities; DNS and unrelated requests are stubbed.
    const target = phase === "before" ? "next.togetherweown.com" : "togetherweown.com";
    const options = parseArgs(["--phase", phase, "--target", target, "--event-key", "fixture"]);
    const cases = [
      { path: "/auth/discord/redirect", location: "/auth/discord", cache: "no-store" },
      { path: "/login", location: "/auth/discord", cache: "no-store" },
      { path: "/community", location: "/", cache: "no-store, private" },
    ];
    const byPath = Object.fromEntries(cases.map((entry) => [entry.path, entry]));
    const env = {
      APP_URL: `https://${target}`,
      get DB() {
        throw new Error("alias must not read DB");
      },
      get DATABASE_URL() {
        throw new Error("alias must not read DATABASE_URL");
      },
    };
    const seen = [];
    const result = await runChecks(options, {
      resolver: { resolve4: async () => ["127.0.0.1"], resolve6: async () => [] },
      request: async (url) => {
        const parsed = new URL(url);
        const expected = parsed.hostname === target ? byPath[parsed.pathname] : undefined;
        if (!expected) {
          return { status: 404, headers: {}, body: "", tlsVerified: true };
        }
        seen.push(parsed.pathname);
        const response = await app.request(url, {}, env);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(expected.location);
        expect(response.headers.get("cache-control")).toBe(expected.cache);
        expect(response.headers.getSetCookie()).toHaveLength(0);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
          tlsVerified: true,
        };
      },
    });
    expect(seen.sort()).toEqual(Object.keys(byPath).sort());
    // Other gates deliberately fail; each alias gate must exist and pass.
    const aliasChecks = result.checks.filter((check) =>
      Object.keys(byPath).some((path) =>
        ["url:", "location:", "no-store:"].some((prefix) => check.id === prefix + path),
      ),
    );
    expect(aliasChecks).toHaveLength(9);
    expect(aliasChecks.filter((check) => !check.ok)).toEqual([]);
  });
}

// Feed the real DB-free route HTML into the gate; synthetic canonical markup
// must not conceal a missing tag in the application. No sockets or DB bindings.
for (const phase of ["before", "after"]) {
  it(`${phase} canonical/indexing gates accept actual static-leaf responses`, async () => {
    // These hosts are in-process request identities, never resolved or contacted.
    const target = phase === "before" ? "next.togetherweown.com" : "togetherweown.com";
    const options = parseArgs(["--phase", phase, "--target", target, "--event-key", "fixture"]);
    const env = {
      APP_URL: `https://${target}`,
      DISCORD_CLIENT_ID: "test",
      DISCORD_CLIENT_SECRET: "test",
      DISCORD_GUILD_ID: "test",
      DISCORD_INVITE_URL: "https://discord.gg/test",
      DISCORD_BOT_TOKEN: "test",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    };
    const seen = [];
    const result = await runChecks(options, {
      resolver: { resolve4: async () => ["127.0.0.1"], resolve6: async () => [] },
      request: async (url) => {
        const parsed = new URL(url);
        if (
          parsed.protocol !== "https:" ||
          parsed.search ||
          parsed.hostname !== target ||
          !leaves.includes(parsed.pathname)
        ) {
          return { status: 404, headers: {}, body: "", tlsVerified: true };
        }
        seen.push(parsed.pathname);
        const response = await app.request(url, {}, env);
        expect(response.status).toBe(200);
        expect(response.headers.getSetCookie()).toHaveLength(0);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
          tlsVerified: true,
        };
      },
    });
    // Other gates deliberately fail (this fixture only exercises the leaves).
    expect(seen.sort()).toEqual([...leaves].sort());
    const leafChecks = result.checks.filter((check) =>
      leaves.some((path) =>
        ["canonical:", "indexing:", "preview-header:"].some((prefix) => check.id === prefix + path),
      ),
    );
    expect(leafChecks).toHaveLength(leaves.length * (phase === "before" ? 3 : 2));
    expect(leafChecks.filter((check) => !check.ok)).toEqual([]);
  });
}
