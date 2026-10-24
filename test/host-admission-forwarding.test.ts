// Host-admission forwarding contract (threat-model gaps row: a request behind
// a proxy carries `X-Forwarded-Host` (or other forwarding headers) that
// admission does not read). Worker tests: admission trusts only the
// environment hostname — the Host header plus the request URL — and every
// forwarding header is ignored for the verdict. Refusals use the branded
// DB-free 404 and never echo a supplied host.
//
// Stable check ID: host-forward-matrix (see ci/check-security-pins.mjs and
// docs/security-pin-contracts.md). The threat-model rows stay the single
// source of truth; this file only pins the executable behavior.
//
// `x-forwarded-for` appears here for the admission verdict only: off-edge it
// remains the throttle client-key fallback (src/throttle.ts), which is not
// host admission and is not pinned here.

import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import * as adminDb from "../src/admin/db";
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

const TRUSTED = "next.example.test";
const EVIL_DIRECT = "evil-direct.example.test";
const EVIL_FORWARD = "evil-forward.example.test";

// Host-valued forwarding signals: each carries a hostile host the verdict
// must ignore (direct-host mismatch, forwarded-host-only mismatch).
const HOST_VALUED_FORWARDING: Array<[string, string]> = [
  ["x-forwarded-host", EVIL_FORWARD],
  ["forwarded", `host=${EVIL_FORWARD}`],
  ["forwarded", `for=203.0.113.7;host=${EVIL_FORWARD}`],
  // Comma-joined values are the classic poisoning shape; admission must not
  // parse this header at all, so any value stays ignored.
  ["x-forwarded-host", `${TRUSTED}, ${EVIL_FORWARD}`],
];

// Non-host forwarding signals: hostile-looking values the verdict must also
// ignore. None of these names a host, so none can admit or refuse.
const NON_HOST_FORWARDING: Array<[string, string]> = [
  ["x-forwarded-proto", "http"],
  ["x-forwarded-port", "8080"],
  ["x-forwarded-for", "203.0.113.7"],
  ["x-forwarded-for", `${EVIL_FORWARD}, 203.0.113.7`],
];

async function expectBrandedRefusal(res: Response, markers: string[]): Promise<string> {
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type") ?? "").toContain("text/html");
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  const body = await res.text();
  expect(body).toContain("We cannot find that page");
  for (const marker of markers) {
    expect(body, `refusal body echoes ${marker}`).not.toContain(marker);
  }
  const headerValues = [...res.headers.values()].join("\n");
  for (const marker of markers) {
    expect(headerValues, `refusal headers echo ${marker}`).not.toContain(marker);
  }
  return body;
}

async function expectNoEcho(res: Response, markers: string[]): Promise<string> {
  const body = await res.text();
  const headerValues = [...res.headers.values()].join("\n");
  for (const marker of markers) {
    expect(body, `response body echoes ${marker}`).not.toContain(marker);
    expect(headerValues, `response headers echo ${marker}`).not.toContain(marker);
  }
  return body;
}

describe("host-admission forwarding contract", () => {
  it.each(HOST_VALUED_FORWARDING)(
    "forwarded-host-only mismatch stays admitted: trusted direct + %s: %s",
    async (name, value) => {
      const admitted = await app.request(
        `${base.APP_URL}/up`,
        { headers: { host: TRUSTED, [name]: value } },
        base,
      );
      // 503 here means admitted past Host admission (no DB in this fixture).
      expect(admitted.status).toBe(503);
      await expectNoEcho(admitted, [EVIL_FORWARD, EVIL_DIRECT]);
    },
  );

  it.each(NON_HOST_FORWARDING)(
    "non-host forwarding signals stay ignored for the verdict: %s: %s",
    async (name, value) => {
      const admitted = await app.request(
        `${base.APP_URL}/up`,
        { headers: { host: TRUSTED, [name]: value } },
        base,
      );
      expect(admitted.status).toBe(503);
    },
  );

  it("both-set precedence: an evil Host is refused even when forwarding names the trusted host", async () => {
    const trustedForwarding = {
      "x-forwarded-host": TRUSTED,
      forwarded: `for=203.0.113.7;host=${TRUSTED}`,
      "x-forwarded-proto": "https",
    };
    const res = await app.request(
      `${base.APP_URL}/up`,
      { headers: { host: EVIL_DIRECT, ...trustedForwarding } },
      base,
    );
    await expectBrandedRefusal(res, [EVIL_DIRECT, EVIL_FORWARD]);
  });

  it("both-set precedence: an evil request URL is refused even when every header agrees", async () => {
    const res = await app.request(
      `https://${EVIL_DIRECT}/up`,
      {
        headers: {
          host: TRUSTED,
          "x-forwarded-host": TRUSTED,
          forwarded: `host=${TRUSTED}`,
        },
      },
      base,
    );
    await expectBrandedRefusal(res, [EVIL_DIRECT, EVIL_FORWARD]);
  });

  it("a refused forwarded matrix never acquires DB or assets and sets no session", async () => {
    const acquire = vi.spyOn(adminDb, "dbFor").mockRejectedValue(new Error("DB forbidden"));
    const fetch = vi.fn(async () => new Response("asset lookup forbidden"));
    try {
      const res = await app.request(
        `${base.APP_URL}/styles.css`,
        {
          headers: {
            host: EVIL_DIRECT,
            "x-forwarded-host": TRUSTED,
            cookie: "__Host-two_session=existing-token",
          },
        },
        {
          ...base,
          DATABASE_URL: "postgres://agent_test@agent-testdb:5432/two_web_next",
          ASSETS: { fetch },
        },
      );
      await expectBrandedRefusal(res, [EVIL_DIRECT, EVIL_FORWARD]);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(acquire).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      acquire.mockRestore();
    }
  });

  it("every forwarding header evil at once: still admitted, URLs stay APP_URL-derived, nothing echoes", async () => {
    const evilForwarding = {
      "x-forwarded-host": EVIL_FORWARD,
      forwarded: `for=203.0.113.7;host=${EVIL_FORWARD}`,
      "x-forwarded-proto": "http",
      "x-forwarded-port": "8080",
      "x-forwarded-for": "203.0.113.7",
    };
    const headers = { host: TRUSTED, ...evilForwarding };
    const home = await app.request(`${base.APP_URL}/`, { headers }, base);
    expect(home.status).toBe(200);
    const homeBody = await expectNoEcho(home, [EVIL_FORWARD, EVIL_DIRECT]);
    expect(homeBody).toContain(`<link rel="canonical" href="${base.APP_URL}/"`);
    const sitemap = await app.request(`${base.APP_URL}/sitemap_index.xml`, { headers }, base);
    expect(sitemap.status).toBe(200);
    const xml = await expectNoEcho(sitemap, [EVIL_FORWARD, EVIL_DIRECT]);
    expect(xml).toContain(`<loc>${base.APP_URL}/</loc>`);
    const login = await app.request(`${base.APP_URL}/auth/discord`, { headers }, base);
    expect(login.status).toBe(302);
    expect(new URL(login.headers.get("location") ?? "").searchParams.get("redirect_uri")).toBe(
      `${base.APP_URL}/auth/discord/callback`,
    );
    await expectNoEcho(login, [EVIL_FORWARD, EVIL_DIRECT]);
  });
});
