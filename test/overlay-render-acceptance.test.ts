// Acceptance: overlay render route GET /o/:token (spec slice 2).
//
// Contract (written blind to the implementation; C1-C7 are the owner-approved
// round-1 decisions, C4 the watermark social contract, C6 the bare 404):
//   - Chromeless transparent page: no Layout header/footer, body background
//     transparent, server-rendered watermark node (logo + Together We Own
//     lockup), Cache-Control private + no-store, no Set-Cookie, the session
//     cookie never read.
//   - Unknown, revoked, rotated-past-grace and demoted-member tokens answer
//     one bare 404: byte-identical to the frozen GET /members 404, no member
//     data, no existence hint, no access-log row.
//   - Rotated tokens honor the 10s predecessor grace.
//   - Page loads carry a per-IP throttle (join AUTH 10/min precedent): the
//     first 10 pass, sustained loads 429 with Retry-After, another IP stays
//     green. Unknown-token loads count too, so token guessing cannot flood.
//   - Every script the page ships (external or inline) stays within the
//     conservative ES2017 syntax baseline (Chrome 63-era CEF) until the open
//     OBS-baseline question is answered.
//
// Seams the suite pins (the Builder implements against these):
//   - Token, config and membership rows are read through the ADMIN_DB
//     binding (the established member-data read seam); fixtures address the
//     spec-pinned overlay_tokens/overlay_configs tables via raw SQL.
//   - The throttle honors the THROTTLE_STORE binding; the client IP comes
//     from cf-connecting-ip like every other throttle test.
//   - Cache assertions compare directive sets, not serialization order: the
//     repo writes "no-store, private" while the spec prose writes
//     "private, no-store"; both orders satisfy the contract.
//   - The DB-free unknown-token cases characterize the frozen 404 shape and
//     pass before the route exists; the registration test and every DB-backed
//     case fail until the schema and route slices land.
//
// Owned by the acceptance card: the Builder builds on this branch and never
// edits this file. Deliberately no route-inventory comment here: the route is
// unregistered at base, so the reference would read as stale; the build PR
// adds its own reference, inventory fixture row, parity/URL entry, a11y
// coverage entry with matrix-pin update, and throttle-bucket inventory row.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import rawApp from "../src/index";
import app from "./app";
import { memberDataAccessLogs } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { SECURITY_HEADERS } from "../src/headers";
import { createMemorySessionStore, type SessionStore, type Sql } from "../src/sessions";
import { cookieFor, env, MEMBER, OUTSIDER, PERSONAL_STRINGS, seed } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  clearOverlayTables,
  insertOverlayConfig,
  insertOverlayToken,
  mintOverlayToken,
} from "./helpers/overlay-fixture";

const offlineEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

function cacheDirectives(res: Response): string[] {
  return (res.headers.get("cache-control") ?? "")
    .split(",")
    .map((directive) => directive.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

describe("overlay render route registration (DB-free)", () => {
  it("registers GET /o/:token on the mounted worker", () => {
    const paths = rawApp.routes
      .filter((route) => route.method === "GET")
      .map((route) => route.path);
    expect(paths).toContain("/o/:token");
  });
});

describe("overlay unknown-token 404 shape (DB-free characterization)", () => {
  const get = (token: string) => app.request(`/o/${encodeURIComponent(token)}`, {}, offlineEnv);

  async function frozenMembersBody(): Promise<string> {
    const res = await app.request("/members", {}, offlineEnv);
    expect(res.status).toBe(404);
    return res.text();
  }

  it("answers an unknown well-formed token with the frozen 404 and no reflection", async () => {
    const token = mintOverlayToken();
    const res = await get(token);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(cacheDirectives(res)).toEqual(["no-store", "private"]);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    const body = await res.text();
    expect(body).toBe(await frozenMembersBody());
    expect(body).not.toContain(token);
    expect(body).not.toContain("two_ov_");
  });

  it.each(["!!!", "two_ov_short", "x".repeat(200), "../members/100000000000000101"])(
    "answers malformed token %s with the identical 404 (no existence hint)",
    async (token) => {
      const res = await get(token);
      expect(res.status).toBe(404);
      expect(res.headers.getSetCookie()).toHaveLength(0);
      const body = await res.text();
      expect(body).toBe(await frozenMembersBody());
      expect(body).not.toContain("100000000000000101");
    },
  );

  it("carries the security headers, keeps framing denied and never sets a cookie", async () => {
    const res = await get(mintOverlayToken());
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "overlay render on the mounted worker (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: Db;
    let sessions: SessionStore;
    let remoteFetch: MockInstance<typeof fetch>;
    const bindings = () => ({
      ...env,
      ADMIN_DB: db,
      SESSION_STORE: sessions,
      THROTTLE_STORE: async () => fixture.client as unknown as Sql,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    });
    const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings());

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
    });

    beforeEach(async () => {
      remoteFetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected external fetch"));
      await fixture.reset();
      await seed(db);
      await clearOverlayTables(fixture);
      sessions = createMemorySessionStore();
    });

    afterEach(async () => {
      try {
        await fixture?.reset();
        await clearOverlayTables(fixture);
        expect(remoteFetch).not.toHaveBeenCalled();
      } finally {
        remoteFetch?.mockRestore();
      }
    });

    afterAll(() => fixture?.dispose());

    it("live token renders the chromeless overlay with the server-rendered watermark", async () => {
      const token = mintOverlayToken();
      await insertOverlayConfig(fixture, MEMBER.userId);
      await insertOverlayToken(fixture, { token, memberId: MEMBER.userId });
      const res = await request(`/o/${token}`, { headers: { "cf-connecting-ip": "192.0.2.11" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(cacheDirectives(res)).toEqual(["no-store", "private"]);
      expect(res.headers.getSetCookie()).toHaveLength(0);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(res.headers.get(name), name).toBe(value);
      }
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const body = await res.text();
      expect(body).toContain(MEMBER.username);
      expect(body).toContain("Together We Own");
      expect(body).toContain("logo.svg");
      expect(body).not.toContain("<header");
      expect(body).not.toContain("<footer");
      expect(body).not.toContain("site-header");
      for (const personal of [...PERSONAL_STRINGS, OUTSIDER.username, OUTSIDER.userId]) {
        expect(body).not.toContain(personal);
      }
      expect(body).not.toContain("Europe/London");
    });

    it("ignores the session cookie: member, moderator and guest see identical bytes", async () => {
      const token = mintOverlayToken();
      await insertOverlayConfig(fixture, MEMBER.userId);
      await insertOverlayToken(fixture, { token, memberId: MEMBER.userId });
      const path = `/o/${token}`;
      const guest = await request(path, { headers: { "cf-connecting-ip": "192.0.2.12" } });
      expect(guest.status).toBe(200);
      const guestBody = await guest.text();
      for (const [label, actor, ip] of [
        ["member", MEMBER, "192.0.2.13"],
        [
          "moderator",
          {
            userId: "100000000000000103",
            username: "w15-moderator",
            member: true,
            moderator: true,
          },
          "192.0.2.14",
        ],
      ] as const) {
        const authed = await request(path, {
          headers: { "cf-connecting-ip": ip, cookie: await cookieFor(sessions, actor) },
        });
        expect(authed.status, label).toBe(200);
        expect(await authed.text(), label).toBe(guestBody);
        expect(authed.headers.getSetCookie(), label).toHaveLength(0);
      }
      expect(guest.headers.getSetCookie()).toHaveLength(0);
    });

    it("serves a transparent body theme from the page or its stylesheets", async () => {
      const token = mintOverlayToken();
      await insertOverlayConfig(fixture, MEMBER.userId);
      await insertOverlayToken(fixture, { token, memberId: MEMBER.userId });
      const ip = "192.0.2.15";
      const res = await request(`/o/${token}`, { headers: { "cf-connecting-ip": ip } });
      expect(res.status).toBe(200);
      const html = await res.text();
      const sources: string[] = [/<body[^>]*>/i.exec(html)?.[0] ?? ""];
      for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
        sources.push(match[1]!);
      }
      const tags = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
      const cssHrefs = tags
        .filter((tag) => /rel=["']stylesheet["']/i.test(tag))
        .map((tag) => /href=["']([^"']+)["']/i.exec(tag)?.[1])
        .filter((href): href is string => !!href && href.startsWith("/"));
      for (const href of cssHrefs) {
        const css = await request(href, { headers: { "cf-connecting-ip": ip } });
        expect(css.status, href).toBe(200);
        sources.push(await css.text());
      }
      const normalized = sources.join("\n").replace(/\s+/g, "");
      expect(normalized).toMatch(/body\{[^}]*background:transparent/);
    });

    it("keeps every shipped script within the OBS baseline syntax", async () => {
      const token = mintOverlayToken();
      await insertOverlayConfig(fixture, MEMBER.userId);
      await insertOverlayToken(fixture, { token, memberId: MEMBER.userId });
      const ip = "192.0.2.16";
      const res = await request(`/o/${token}`, { headers: { "cf-connecting-ip": ip } });
      expect(res.status).toBe(200);
      const html = await res.text();
      // Conservative ES2017 baseline (Chrome 63-era CEF) until the open
      // OBS-baseline question is answered: current OBS ships CEF 127+, but
      // members may stream from older installs.
      const checkBaseline = (code: string, label: string) => {
        expect(code, `${label}: no optional chaining`).not.toMatch(/\?\.(?![0-9])/);
        expect(code, `${label}: no nullish coalescing`).not.toMatch(/\?\?/);
        expect(code, `${label}: no logical assignment`).not.toMatch(/(\|\||&&)=/);
      };
      const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
        .map((match) => match[1]!)
        .filter((src) => src.startsWith("/"));
      expect(scriptSrcs.length).toBeLessThanOrEqual(1);
      for (const src of scriptSrcs) {
        const js = await request(src, { headers: { "cf-connecting-ip": ip } });
        expect(js.status, src).toBe(200);
        checkBaseline(await js.text(), src);
      }
      const inlineTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
      for (const tag of inlineTags) {
        const attrs = tag[1]!;
        if (/\bsrc=/.test(attrs)) continue;
        const type = /type=["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase() ?? "";
        if (
          type !== "" &&
          !["text/javascript", "module", "text/ecmascript", "application/javascript"].includes(type)
        ) {
          continue;
        }
        checkBaseline(tag[2]!, "inline script");
      }
    });

    it("unknown, revoked, rotated, demoted and never-member tokens share one bare 404", async () => {
      const unknown = mintOverlayToken();
      const revoked = mintOverlayToken();
      const rotated = mintOverlayToken();
      const demoted = mintOverlayToken();
      const outsider = mintOverlayToken();
      await insertOverlayConfig(fixture, MEMBER.userId);
      await insertOverlayConfig(fixture, OUTSIDER.userId);
      await insertOverlayToken(fixture, {
        token: revoked,
        memberId: MEMBER.userId,
        status: "revoked",
      });
      await insertOverlayToken(fixture, {
        token: rotated,
        memberId: MEMBER.userId,
        status: "rotated",
        rotatedAt: new Date(Date.now() - 60_000),
      });
      await insertOverlayToken(fixture, { token: demoted, memberId: MEMBER.userId });
      await insertOverlayToken(fixture, { token: outsider, memberId: OUTSIDER.userId });
      const control = await request(`/o/${demoted}`, {
        headers: { "cf-connecting-ip": "198.51.100.101" },
      });
      expect(control.status).toBe(200);
      await fixture.client`UPDATE users SET member = false WHERE id = ${MEMBER.userId}`;
      const bodies: string[] = [];
      const cases: Array<[string, string, string]> = [
        ["unknown", unknown, "198.51.100.102"],
        ["revoked", revoked, "198.51.100.103"],
        ["rotated", rotated, "198.51.100.104"],
        ["demoted", demoted, "198.51.100.105"],
        ["outsider", outsider, "198.51.100.106"],
      ];
      for (const [label, token, ip] of cases) {
        const res = await request(`/o/${token}`, { headers: { "cf-connecting-ip": ip } });
        expect(res.status, label).toBe(404);
        expect(res.headers.get("content-type"), label).toMatch(/text\/html/);
        expect(cacheDirectives(res), label).toEqual(["no-store", "private"]);
        expect(res.headers.getSetCookie(), label).toHaveLength(0);
        bodies.push(await res.text());
      }
      const members = await request("/members", {
        headers: { "cf-connecting-ip": "198.51.100.107" },
      });
      expect(members.status).toBe(404);
      bodies.push(await members.text());
      for (const body of bodies) {
        expect(body).toBe(bodies[0]);
        for (const secret of [
          ...PERSONAL_STRINGS,
          MEMBER.username,
          MEMBER.userId,
          OUTSIDER.username,
          OUTSIDER.userId,
          unknown,
          revoked,
          rotated,
          demoted,
          outsider,
        ]) {
          expect(body).not.toContain(secret);
        }
      }
    });

    it("overlay loads and token failures write no access-log rows", async () => {
      const live = mintOverlayToken();
      const unknown = mintOverlayToken();
      const revoked = mintOverlayToken();
      await insertOverlayConfig(fixture, MEMBER.userId);
      await insertOverlayToken(fixture, { token: live, memberId: MEMBER.userId });
      await insertOverlayToken(fixture, {
        token: revoked,
        memberId: MEMBER.userId,
        status: "revoked",
      });
      expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
      const ips = ["198.51.100.111", "198.51.100.112", "198.51.100.113"];
      const loads: Array<[string, number]> = [
        [live, 200],
        [unknown, 404],
        [revoked, 404],
      ];
      for (const [[token, expected], ip] of loads.map(
        (load, index) => [load, ips[index]!] as const,
      )) {
        const res = await request(`/o/${token}`, { headers: { "cf-connecting-ip": ip } });
        expect(res.status).toBe(expected);
        await res.text();
      }
      expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
    });

    it("rotated token within the 10s grace still renders", async () => {
      const token = mintOverlayToken();
      await insertOverlayConfig(fixture, MEMBER.userId);
      await insertOverlayToken(fixture, {
        token,
        memberId: MEMBER.userId,
        status: "rotated",
        rotatedAt: new Date(Date.now() - 5_000),
      });
      const res = await request(`/o/${token}`, { headers: { "cf-connecting-ip": "192.0.2.17" } });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(MEMBER.username);
    });

    it("demotion kills a live token immediately", async () => {
      const token = mintOverlayToken();
      await insertOverlayConfig(fixture, MEMBER.userId);
      await insertOverlayToken(fixture, { token, memberId: MEMBER.userId });
      const before = await request(`/o/${token}`, {
        headers: { "cf-connecting-ip": "192.0.2.18" },
      });
      expect(before.status).toBe(200);
      await fixture.client`UPDATE users SET member = false WHERE id = ${MEMBER.userId}`;
      const after = await request(`/o/${token}`, { headers: { "cf-connecting-ip": "192.0.2.19" } });
      expect(after.status).toBe(404);
      const unknown = await request(`/o/${mintOverlayToken()}`, {
        headers: { "cf-connecting-ip": "192.0.2.20" },
      });
      expect(unknown.status).toBe(404);
      expect(await after.text()).toBe(await unknown.text());
    });

    it("per-IP throttle bounds valid-token loads while another IP stays green", async () => {
      const token = mintOverlayToken();
      await insertOverlayConfig(fixture, MEMBER.userId);
      await insertOverlayToken(fixture, { token, memberId: MEMBER.userId });
      const flooded = "192.0.2.61";
      let saw429 = false;
      for (let i = 0; i < 120; i++) {
        const res = await request(`/o/${token}`, { headers: { "cf-connecting-ip": flooded } });
        if (res.status === 429) {
          expect(i).toBeGreaterThanOrEqual(10);
          saw429 = true;
          const retryAfter = res.headers.get("retry-after");
          expect(retryAfter).toMatch(/^\d+$/);
          const seconds = Number(retryAfter);
          expect(seconds).toBeGreaterThanOrEqual(1);
          expect(seconds).toBeLessThanOrEqual(86400);
          expect(cacheDirectives(res)).toEqual(["no-store", "private"]);
          expect(res.headers.getSetCookie()).toHaveLength(0);
          const body = await res.text();
          for (const personal of PERSONAL_STRINGS) expect(body).not.toContain(personal);
          expect(body).not.toContain(token);
        } else {
          expect(res.status).toBe(200);
          await res.text();
        }
      }
      expect(saw429).toBe(true);
      const other = await request(`/o/${token}`, { headers: { "cf-connecting-ip": "192.0.2.62" } });
      expect(other.status).toBe(200);
    });

    it("unknown-token loads count toward the same per-IP budget", async () => {
      const token = mintOverlayToken();
      const flooded = "192.0.2.63";
      let saw429 = false;
      for (let i = 0; i < 120; i++) {
        const res = await request(`/o/${token}`, { headers: { "cf-connecting-ip": flooded } });
        if (res.status === 429) {
          expect(i).toBeGreaterThanOrEqual(10);
          saw429 = true;
          expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
          expect(cacheDirectives(res)).toEqual(["no-store", "private"]);
          expect(res.headers.getSetCookie()).toHaveLength(0);
          const body = await res.text();
          expect(body).not.toContain(token);
        } else {
          expect(res.status).toBe(404);
          await res.text();
        }
      }
      expect(saw429).toBe(true);
    });
  },
);
